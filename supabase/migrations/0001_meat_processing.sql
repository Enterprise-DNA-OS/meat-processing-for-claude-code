-- meat-processing-for-claude-code: core schema.
-- A red meat plant's office: the producers who supply it and their agents, the
-- price grids, kill bookings, arrivals with the vendor declaration, the kill
-- sheet off the scales, grid pricing per carcase, levies and deductions, the
-- settlement each producer is paid on (a buyer-created tax invoice), boning
-- yields, and the traceability report after slaughter.
--
-- Runs unchanged on PGlite (embedded) and on Postgres / Supabase.
--
-- Money is stored in cents, weights in kilograms to one decimal, prices in
-- cents per kilogram. This database never pays anyone and never lodges
-- anything with NLIS, NAIT or the tax office: payments go through the bank and
-- traceability uploads through the national database, then are recorded here.
--
-- The rules live in the database, not a screen: a carcase is priced off the
-- grid that was agreed for its booking (or flagged off grid), a settlement is
-- refused while any head are unaccounted for, any carcase is unpriced, the
-- vendor declaration is missing or the producer has no buyer-created invoice
-- agreement in date, a settled kill sheet cannot be edited, an issued
-- settlement cannot be changed except to record its payment, and its lines are
-- append only. docs/compliance.md cites the rule behind each check.

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create or replace function append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append only: record a correction instead', tg_table_name;
end
$$;

-- ---------------------------------------------------------------- settings

create table settings (
  id boolean primary key default true check (id),
  plant_name text not null,
  plant_number text,                                      -- establishment or registration number
  currency text not null default 'AUD',
  jurisdiction text not null default 'AU' check (jurisdiction in ('NZ', 'AU')),
  gst_pct numeric(5,2) not null default 10,
  payment_days integer not null default 7,                -- plant policy: pay producers within this many days of kill
  feedback_days integer not null default 2,               -- plant policy: kill sheet to the producer within this many days
  trace_report_hours integer not null default 48,         -- report slaughtered tags to NLIS or NAIT within this many hours
  lairage_max_hours integer not null default 24,          -- plant welfare policy: longest stay in the yards before slaughter
  agreement_warn_days integer not null default 60,        -- warn this many days before a buyer-created invoice agreement ends
  cattle_per_day integer not null default 300,            -- kill floor capacity, head per day
  smallstock_per_day integer not null default 2500,
  condemn_watch_pct numeric(5,2) not null default 2,      -- condemnation rate worth raising with a producer
  bruise_watch_pct numeric(5,2) not null default 10,      -- bruised carcases (score 2 or more) worth raising with a producer
  updated_at timestamptz not null default now()
);
create trigger settings_updated before update on settings for each row execute function set_updated_at();

-- Levies the plant deducts from producers and pays on. Rates change: keep the
-- source and the date each rate was checked.
create table levy_rates (
  id uuid primary key default gen_random_uuid(),
  species text not null check (species in ('cattle', 'sheep', 'lamb', 'goat')),
  name text not null,
  basis text not null check (basis in ('per_head', 'pct_of_value')),
  rate numeric(10,4) not null check (rate >= 0),          -- cents per head, or percent of carcase value
  cap_cents_per_head integer check (cap_cents_per_head is null or cap_cents_per_head >= 0), -- percent levies stop at this per head
  source text not null,
  checked_on date not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index levy_rates_one_active on levy_rates (species, name) where active;

-- ---------------------------------------------------------------- producers and agents

create table agents (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  company text,
  commission_cents_per_head bigint not null default 0 check (commission_cents_per_head >= 0),
  email text,
  phone text,
  created_at timestamptz not null default now()
);

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  trading_name text,
  business_number text,                                   -- ABN or NZBN
  gst_registered boolean not null default true,
  gst_number text,                                        -- NZ GST number (AU uses the ABN)
  property_id text,                                       -- AU property identification code (PIC) or NZ NAIT location number
  quality_assurance_no text,                              -- AU LPA accreditation or NZ farm assurance number
  quality_assurance_expires_on date,
  agreement_signed_on date,                               -- buyer-created tax invoice (RCTI) agreement
  agreement_expires_on date,
  bank_last4 text check (bank_last4 is null or bank_last4 ~ '^[0-9]{4}$'),
  agent_id uuid references agents(id),
  status text not null default 'active' check (status in ('active', 'hold', 'closed')),
  hold_reason text,
  region text,
  contact_name text,
  email text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'hold' or hold_reason is not null),
  check (agreement_expires_on is null or agreement_signed_on is null or agreement_expires_on > agreement_signed_on)
);
create trigger suppliers_updated before update on suppliers for each row execute function set_updated_at();

-- ---------------------------------------------------------------- price grids

create table grids (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  species text not null check (species in ('cattle', 'sheep', 'lamb', 'goat')),
  name text not null,
  valid_from date not null,
  valid_to date,
  notes text,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);

-- One price band. A carcase takes the first line (by sort) whose category,
-- weight, fat score and dentition it fits.
create table grid_lines (
  id uuid primary key default gen_random_uuid(),
  grid_id uuid not null references grids(id),
  sort integer not null,
  category text not null,                                 -- STEER, HEIFER, COW, BULL, LAMB, HOGGET, MUTTON
  min_kg numeric(6,1) not null default 0,
  max_kg numeric(6,1) not null default 9999,
  min_fat integer not null default 0,                     -- fat score (1 lean to 6 over fat), or GR depth band
  max_fat integer not null default 99,
  max_teeth integer not null default 8,                   -- permanent incisors
  cents_per_kg integer not null check (cents_per_kg >= 0),
  unique (grid_id, sort),
  check (max_kg >= min_kg and max_fat >= min_fat)
);

-- Discounts the grid applies for defects, per kilogram or per head.
create table grid_deductions (
  id uuid primary key default gen_random_uuid(),
  grid_id uuid not null references grids(id),
  code text not null check (code in ('BRUISE', 'DARK', 'TRIM')),
  description text not null,
  cents_per_kg integer not null default 0 check (cents_per_kg >= 0),
  cents_per_head integer not null default 0 check (cents_per_head >= 0),
  unique (grid_id, code)
);

-- ---------------------------------------------------------------- bookings and arrivals

create table bookings (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  supplier_id uuid not null references suppliers(id),
  agent_id uuid references agents(id),
  species text not null check (species in ('cattle', 'sheep', 'lamb', 'goat')),
  head_booked integer not null check (head_booked > 0),
  kill_date date not null,
  grid_id uuid not null references grids(id),
  status text not null default 'booked' check (status in ('booked', 'arrived', 'killed', 'settled', 'cancelled')),
  freight_cents bigint not null default 0 check (freight_cents >= 0),   -- freight the plant paid and recovers from the producer
  carrier text,
  cancelled_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'cancelled' or cancelled_reason is not null)
);
create trigger bookings_updated before update on bookings for each row execute function set_updated_at();
create index bookings_kill_date on bookings (kill_date);

create or replace function bookings_check() returns trigger
language plpgsql as $$
declare g record; s record;
begin
  select * into g from grids where id = new.grid_id;
  if g.species <> new.species then
    raise exception 'Grid % prices % but the booking is %', g.code, g.species, new.species;
  end if;
  if new.kill_date < g.valid_from or (g.valid_to is not null and new.kill_date > g.valid_to) then
    raise exception 'Grid % is not valid on the kill date %', g.code, new.kill_date;
  end if;
  if tg_op = 'INSERT' then
    select * into s from suppliers where id = new.supplier_id;
    if s.status <> 'active' then
      raise exception 'Supplier % is %: no new bookings (%)', s.code, s.status, coalesce(s.hold_reason, 'closed');
    end if;
  end if;
  return new;
end
$$;
create trigger bookings_check before insert or update of grid_id, kill_date, species on bookings for each row execute function bookings_check();

create table arrivals (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references bookings(id),
  arrived_at timestamp not null,
  head_received integer not null check (head_received >= 0),
  dead_on_arrival integer not null default 0 check (dead_on_arrival >= 0),
  declaration_no text,                                    -- AU National Vendor Declaration or NZ Animal Status Declaration
  declaration_received boolean not null default false,
  withholding_clear boolean not null default true,        -- declaration says no animal is inside a withholding period or ESI
  hgp_free boolean,                                       -- AU: declared free of hormonal growth promotants
  property_id_declared text,                              -- the PIC or NAIT number on the declaration
  lame_or_injured integer not null default 0 check (lame_or_injured >= 0),
  pen text,
  last_fed_at timestamp,
  notes text,
  actor text not null,
  created_at timestamptz not null default now(),
  check (dead_on_arrival <= head_received)
);

-- ---------------------------------------------------------------- the kill sheet

create table carcases (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references bookings(id),
  kill_date date not null,
  body_no integer not null,
  species text not null check (species in ('cattle', 'sheep', 'lamb', 'goat')),
  category text not null,
  tag_id text,                                            -- NLIS device or NAIT tag; null for mob-based smallstock
  hot_kg numeric(6,1) not null check (hot_kg >= 0),
  fat_score integer,
  teeth integer not null default 0 check (teeth between 0 and 8),
  bruise_score integer not null default 0 check (bruise_score between 0 and 3),
  dark_cutter boolean not null default false,
  condemned boolean not null default false,
  condemn_reason text,
  agreed_cents_per_kg integer check (agreed_cents_per_kg is null or agreed_cents_per_kg >= 0), -- price agreed with the producer for a carcase off grid
  agreed_reason text,
  grid_line_id uuid references grid_lines(id),
  cents_per_kg integer,                                   -- set by the grid; null means off grid
  deduction_cents bigint not null default 0,
  value_cents bigint not null default 0,
  trace_reported_at timestamp,                            -- tag reported to NLIS or NAIT as slaughtered
  created_at timestamptz not null default now(),
  unique (kill_date, species, body_no),
  check (not condemned or condemn_reason is not null)
);
create index carcases_booking on carcases (booking_id);

-- Price a carcase off its booking's grid, every time its measurements change.
create or replace function carcases_price() returns trigger
language plpgsql as $$
declare b record; l record; d record; ded bigint := 0; base bigint;
begin
  select * into b from bookings where id = new.booking_id;
  if b.status = 'cancelled' then raise exception 'Booking % is cancelled', b.number; end if;
  if new.species <> b.species then raise exception 'Carcase is % but booking % is %', new.species, b.number, b.species; end if;
  select * into l from grid_lines gl
   where gl.grid_id = b.grid_id and upper(gl.category) = upper(new.category)
     and new.hot_kg between gl.min_kg and gl.max_kg
     and coalesce(new.fat_score, 0) between gl.min_fat and gl.max_fat
     and new.teeth <= gl.max_teeth
   order by gl.sort limit 1;
  if new.condemned or (not found and new.agreed_cents_per_kg is null) then
    new.grid_line_id := case when found then l.id else null end;
    new.cents_per_kg := case when found then l.cents_per_kg else null end;
    new.deduction_cents := 0;
    new.value_cents := 0;
    return new;
  end if;
  if found then
    new.grid_line_id := l.id;
    new.cents_per_kg := l.cents_per_kg;
  else
    new.grid_line_id := null;
    new.cents_per_kg := new.agreed_cents_per_kg;
  end if;
  base := round(new.hot_kg * new.cents_per_kg);
  for d in select * from grid_deductions where grid_id = b.grid_id loop
    if (d.code = 'BRUISE' and new.bruise_score >= 2) or (d.code = 'DARK' and new.dark_cutter) then
      ded := ded + round(new.hot_kg * d.cents_per_kg) + d.cents_per_head;
    end if;
  end loop;
  new.deduction_cents := least(ded, base);
  new.value_cents := base - new.deduction_cents;
  return new;
end
$$;
create trigger carcases_price before insert or update of hot_kg, fat_score, teeth, category, bruise_score, dark_cutter, condemned, booking_id, agreed_cents_per_kg on carcases
  for each row execute function carcases_price();

-- A settled kill sheet is closed: only the traceability report time may change.
create or replace function carcases_lock() returns trigger
language plpgsql as $$
declare st text;
begin
  select status into st from bookings where id = coalesce(old.booking_id, new.booking_id);
  if st = 'settled' then
    if tg_op = 'DELETE' then raise exception 'Booking is settled: its kill sheet cannot be changed'; end if;
    if (new.hot_kg, new.fat_score, new.teeth, new.category, new.bruise_score, new.dark_cutter, new.condemned, new.booking_id, new.agreed_cents_per_kg)
       is distinct from (old.hot_kg, old.fat_score, old.teeth, old.category, old.bruise_score, old.dark_cutter, old.condemned, old.booking_id, old.agreed_cents_per_kg) then
      raise exception 'Booking is settled: its kill sheet cannot be changed. Record an adjustment on the settlement.';
    end if;
  end if;
  return coalesce(new, old);
end
$$;
create trigger carcases_lock before update or delete on carcases for each row execute function carcases_lock();

-- ---------------------------------------------------------------- settlements

-- A settlement is the plant's buyer-created tax invoice to the producer for one
-- booking (kind settlement), or a later correction to one (kind adjustment).
create table settlements (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  kind text not null default 'settlement' check (kind in ('settlement', 'adjustment')),
  supplier_id uuid not null references suppliers(id),
  booking_id uuid not null references bookings(id),
  adjusts_id uuid references settlements(id),
  issued_on date not null,
  due_on date not null,
  gross_cents bigint not null,                            -- carcase value before deductions
  gst_cents bigint not null default 0,
  deductions_cents bigint not null default 0,             -- levies, freight, commission (positive number)
  net_cents bigint not null,                              -- paid to the producer
  status text not null default 'issued' check (status in ('issued', 'paid')),
  paid_on date,
  payment_ref text,
  actor text not null,
  created_at timestamptz not null default now(),
  check (kind = 'settlement' or adjusts_id is not null),
  check (status <> 'paid' or paid_on is not null),
  check (net_cents = gross_cents + gst_cents - deductions_cents)
);
create unique index settlements_one_per_booking on settlements (booking_id) where kind = 'settlement';

create table settlement_lines (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references settlements(id),
  sort integer not null,
  kind text not null check (kind in ('carcases', 'gst', 'levy', 'freight', 'commission', 'adjustment')),
  description text not null,
  head integer,
  kg numeric(10,1),
  amount_cents bigint not null,                           -- signed: positive paid to the producer, negative deducted
  created_at timestamptz not null default now()
);
create trigger settlement_lines_append_only before update or delete on settlement_lines for each row execute function append_only();

create or replace function settlements_check() returns trigger
language plpgsql as $$
declare s record; b record; a record; unpriced integer; killed integer;
begin
  if tg_op = 'DELETE' then raise exception 'settlements are never deleted: issue an adjustment'; end if;
  if tg_op = 'UPDATE' then
    if (new.number, new.kind, new.supplier_id, new.booking_id, new.issued_on, new.gross_cents, new.gst_cents, new.deductions_cents, new.net_cents, new.actor)
       is distinct from (old.number, old.kind, old.supplier_id, old.booking_id, old.issued_on, old.gross_cents, old.gst_cents, old.deductions_cents, old.net_cents, old.actor) then
      raise exception 'Settlement % is issued: it cannot be changed. Issue an adjustment.', old.number;
    end if;
    if old.status = 'paid' and new.status <> 'paid' then raise exception 'Settlement % is already paid', old.number; end if;
    return new;
  end if;
  select * into s from suppliers where id = new.supplier_id;
  select * into b from bookings where id = new.booking_id;
  if b.supplier_id <> new.supplier_id then raise exception 'Booking % belongs to another supplier', b.number; end if;
  -- A buyer-created tax invoice needs both parties registered for GST and a
  -- current written agreement. A producer not registered for GST gets a
  -- settlement statement with no GST instead, and needs no agreement.
  if s.gst_registered and (s.agreement_signed_on is null or (s.agreement_expires_on is not null and s.agreement_expires_on < new.issued_on)) then
    raise exception 'Supplier % has no buyer-created invoice agreement in date: record one before issuing a settlement', s.code;
  end if;
  if new.kind = 'settlement' then
    select * into a from arrivals where booking_id = b.id;
    if not found then raise exception 'Booking % has no arrival recorded', b.number; end if;
    if not a.declaration_received then raise exception 'Booking % has no vendor declaration on file', b.number; end if;
    select count(*), count(*) filter (where cents_per_kg is null and not condemned) into killed, unpriced from carcases where booking_id = b.id;
    if unpriced > 0 then raise exception 'Booking % has % carcase(s) off grid: price them first', b.number, unpriced; end if;
    if killed + a.dead_on_arrival <> a.head_received then
      raise exception 'Booking %: % received, % killed and % dead on arrival. Account for every head first', b.number, a.head_received, killed, a.dead_on_arrival;
    end if;
  end if;
  return new;
end
$$;
create trigger settlements_check before insert or update or delete on settlements for each row execute function settlements_check();

create or replace function settlements_close_booking() returns trigger
language plpgsql as $$
begin
  if new.kind = 'settlement' then update bookings set status = 'settled' where id = new.booking_id; end if;
  return new;
end
$$;
create trigger settlements_close_booking after insert on settlements for each row execute function settlements_close_booking();

-- ---------------------------------------------------------------- boning and yields

create table boning_runs (
  id uuid primary key default gen_random_uuid(),
  run_on date not null,
  species text not null check (species in ('cattle', 'sheep', 'lamb', 'goat')),
  category text,
  carcase_kg numeric(10,1) not null check (carcase_kg > 0),
  saleable_kg numeric(10,1) not null check (saleable_kg >= 0),   -- cartoned primals, cuts and trim
  fat_bone_kg numeric(10,1) not null default 0 check (fat_bone_kg >= 0),
  cartons integer not null default 0,
  notes text,
  actor text not null,
  created_at timestamptz not null default now(),
  check (saleable_kg + fat_bone_kg <= carcase_kg * 1.02)
);

-- ---------------------------------------------------------------- notes and history

create table notes (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references suppliers(id),
  booking_id uuid references bookings(id),
  body text not null,
  actor text not null,
  created_at timestamptz not null default now(),
  check (supplier_id is not null or booking_id is not null)
);
create trigger notes_append_only before update or delete on notes for each row execute function append_only();

create table history (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null,
  subject text not null,
  detail jsonb
);
create trigger history_append_only before update or delete on history for each row execute function append_only();

-- ---------------------------------------------------------------- views

-- Every carcase with who sent it and what it earned.
create view v_carcases as
select c.id, c.kill_date, c.body_no, c.species, c.category, c.tag_id, c.hot_kg, c.fat_score, c.teeth,
       c.bruise_score, c.dark_cutter, c.condemned, c.condemn_reason, c.cents_per_kg, c.deduction_cents, c.value_cents,
       c.trace_reported_at, (c.cents_per_kg is null and not c.condemned) as off_grid, c.agreed_cents_per_kg, c.agreed_reason,
       b.number as booking_no, b.id as booking_id, b.status as booking_status, s.code as supplier_code, s.name as supplier_name, s.id as supplier_id,
       g.code as grid_code, gl.category as grid_category
  from carcases c
  join bookings b on b.id = c.booking_id
  join suppliers s on s.id = b.supplier_id
  join grids g on g.id = b.grid_id
  left join grid_lines gl on gl.id = c.grid_line_id;

-- Every booking with its head counted at each step.
create view v_bookings as
select b.id, b.number, b.kill_date, b.species, b.status, b.head_booked, s.code as supplier_code, s.name as supplier_name,
       s.id as supplier_id, g.code as grid_code, ag.name as agent_name,
       a.head_received, a.dead_on_arrival, a.declaration_received, a.withholding_clear, a.arrived_at, a.last_fed_at,
       coalesce(k.killed, 0) as killed, coalesce(k.condemned, 0) as condemned, coalesce(k.off_grid, 0) as off_grid,
       coalesce(k.kg, 0) as hot_kg, coalesce(k.value_cents, 0) as value_cents,
       case when a.id is null then null else a.head_received - a.dead_on_arrival - coalesce(k.killed, 0) end as unaccounted,
       st.number as settlement_no, st.status as settlement_status, st.due_on, st.net_cents
  from bookings b
  join suppliers s on s.id = b.supplier_id
  join grids g on g.id = b.grid_id
  left join agents ag on ag.id = b.agent_id
  left join arrivals a on a.booking_id = b.id
  left join (select booking_id, count(*) as killed, count(*) filter (where condemned) as condemned,
                    count(*) filter (where cents_per_kg is null and not condemned) as off_grid,
                    sum(hot_kg) as kg, sum(value_cents) as value_cents
               from carcases group by booking_id) k on k.booking_id = b.id
  left join settlements st on st.booking_id = b.id and st.kind = 'settlement';

-- Each supplier's last 90 days on the kill floor.
create view v_supplier_performance as
select s.id as supplier_id, s.code, s.name,
       count(c.id) as carcases,
       round(avg(c.hot_kg) filter (where not c.condemned), 1) as avg_kg,
       round(avg(c.cents_per_kg) filter (where not c.condemned and c.cents_per_kg is not null), 0) as avg_cents_per_kg,
       round(100.0 * count(c.id) filter (where c.condemned) / nullif(count(c.id), 0), 1) as condemned_pct,
       round(100.0 * count(c.id) filter (where c.bruise_score >= 2) / nullif(count(c.id), 0), 1) as bruised_pct,
       round(100.0 * count(c.id) filter (where c.dark_cutter) / nullif(count(c.id), 0), 1) as dark_pct,
       coalesce(sum(c.deduction_cents), 0) as deductions_cents,
       coalesce(sum(c.value_cents), 0) as value_cents
  from suppliers s
  left join bookings b on b.supplier_id = s.id
  left join carcases c on c.booking_id = b.id and c.kill_date >= current_date - 90
 group by s.id, s.code, s.name;

-- Settlements not yet paid, with days past the plant's terms.
create view v_settlements_open as
select st.number, st.kind, st.issued_on, st.due_on, st.net_cents, s.code as supplier_code, s.name as supplier_name, b.number as booking_no,
       b.kill_date, current_date - st.due_on as days_late
  from settlements st
  join suppliers s on s.id = st.supplier_id
  join bookings b on b.id = st.booking_id
 where st.status = 'issued';

-- Boning yield per run.
create view v_yields as
select run_on, species, category, carcase_kg, saleable_kg, fat_bone_kg, cartons,
       round(100.0 * saleable_kg / carcase_kg, 1) as yield_pct,
       round(100.0 * (carcase_kg - saleable_kg - fat_bone_kg) / carcase_kg, 1) as loss_pct
  from boning_runs;


-- ---------------------------------------------------------------- settlement maths

-- The lines a settlement for one booking would carry. Used for the test run and
-- for issuing, so the two never disagree. Positive is paid to the producer.
create or replace function settlement_preview(p_booking uuid)
returns table (sort integer, kind text, description text, head integer, kg numeric, amount_cents bigint)
language plpgsql as $$
declare b record; s record; st record; ag record; v record; l record; n integer := 0;
begin
  select * into st from settings;
  select * into b from bookings where id = p_booking;
  select * into s from suppliers where id = b.supplier_id;
  select count(*) filter (where not condemned)::int as paid_head, count(*)::int as killed,
         count(*) filter (where condemned)::int as condemned,
         coalesce(sum(hot_kg) filter (where not condemned), 0) as kg,
         coalesce(sum(value_cents), 0)::bigint as value, coalesce(sum(deduction_cents), 0)::bigint as defects
    into v from carcases where booking_id = p_booking;
  n := n + 1; sort := n; kind := 'carcases'; head := v.paid_head; kg := v.kg; amount_cents := v.value;
  description := format('%s carcases on grid %s', v.paid_head, (select code from grids where id = b.grid_id))
    || case when v.defects > 0 then format(' (after $%s in bruising and dark cutting discounts)', to_char(v.defects / 100.0, 'FM999,999,990.00')) else '' end;
  return next;
  if v.condemned > 0 then
    n := n + 1; sort := n; kind := 'carcases'; head := v.condemned; kg := null; amount_cents := 0;
    description := format('%s condemned, not paid', v.condemned); return next;
  end if;
  if s.gst_registered and v.value > 0 then
    n := n + 1; sort := n; kind := 'gst'; head := null; kg := null; amount_cents := round(v.value * st.gst_pct / 100);
    description := format('GST at %s%%', st.gst_pct::float); return next;
  end if;
  for l in select * from levy_rates where active and species = b.species order by name loop
    n := n + 1; sort := n; kind := 'levy'; kg := null;
    if l.basis = 'per_head' then
      head := v.killed; amount_cents := -round(l.rate * v.killed);
      description := format('%s, %s head at $%s', l.name, v.killed, to_char(l.rate / 100.0, 'FM990.00'));
    else
      head := v.paid_head;
      select -coalesce(sum(case when l.cap_cents_per_head is null then round(c.value_cents * l.rate / 100)
                                else least(round(c.value_cents * l.rate / 100), l.cap_cents_per_head) end), 0)::bigint
        into amount_cents from carcases c where c.booking_id = p_booking and not c.condemned;
      description := format('%s at %s%% of value', l.name, l.rate::float)
        || case when l.cap_cents_per_head is not null then format(', at most $%s a head', to_char(l.cap_cents_per_head / 100.0, 'FM990.00')) else '' end;
    end if;
    return next;
  end loop;
  if b.freight_cents > 0 then
    n := n + 1; sort := n; kind := 'freight'; head := null; kg := null; amount_cents := -b.freight_cents;
    description := 'Freight' || coalesce(' by ' || b.carrier, ''); return next;
  end if;
  if b.agent_id is not null then
    select * into ag from agents where id = b.agent_id;
    if ag.commission_cents_per_head > 0 then
      n := n + 1; sort := n; kind := 'commission'; head := v.killed; kg := null;
      amount_cents := -(ag.commission_cents_per_head * v.killed);
      description := format('Agent commission, %s', ag.name); return next;
    end if;
  end if;
end
$$;

-- Issue the settlement for a booking from its preview. The checks in
-- settlements_check refuse it while anything is missing.
create or replace function issue_settlement(p_booking uuid, p_issued date, p_actor text)
returns uuid
language plpgsql as $$
declare b record; st record; sid uuid; g bigint; t bigint; d bigint;
begin
  select * into st from settings;
  select * into b from bookings where id = p_booking;
  if b.status = 'settled' then raise exception 'Booking % is already settled', b.number; end if;
  if b.status not in ('killed', 'arrived') then raise exception 'Booking % is %: nothing to settle', b.number, b.status; end if;
  select coalesce(sum(p.amount_cents) filter (where p.kind = 'carcases'), 0),
         coalesce(sum(p.amount_cents) filter (where p.kind = 'gst'), 0),
         coalesce(-sum(p.amount_cents) filter (where p.amount_cents < 0), 0)
    into g, t, d from settlement_preview(p_booking) p;
  insert into settlements (number, kind, supplier_id, booking_id, issued_on, due_on, gross_cents, gst_cents, deductions_cents, net_cents, actor)
  values ('S-' || regexp_replace(b.number, '[^0-9A-Za-z]', '', 'g'), 'settlement', b.supplier_id, b.id, p_issued,
          b.kill_date + st.payment_days, g, t, d, g + t - d, p_actor)
  returning id into sid;
  insert into settlement_lines (settlement_id, sort, kind, description, head, kg, amount_cents)
  select sid, p.sort, p.kind, p.description, p.head, p.kg, p.amount_cents from settlement_preview(p_booking) p;
  insert into history (actor, action, subject, detail) values (p_actor, 'settle', b.number, jsonb_build_object('net_cents', g + t - d));
  return sid;
end
$$;

-- ---------------------------------------------------------------- locks

alter table settings enable row level security;
alter table levy_rates enable row level security;
alter table agents enable row level security;
alter table suppliers enable row level security;
alter table grids enable row level security;
alter table grid_lines enable row level security;
alter table grid_deductions enable row level security;
alter table bookings enable row level security;
alter table arrivals enable row level security;
alter table carcases enable row level security;
alter table settlements enable row level security;
alter table settlement_lines enable row level security;
alter table boning_runs enable row level security;
alter table notes enable row level security;
alter table history enable row level security;
