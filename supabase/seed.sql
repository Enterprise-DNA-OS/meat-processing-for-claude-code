-- Demo data: Tablelands Meat Co, a fictional cattle and lamb plant in regional
-- New South Wales. Dates are relative to today, so the plant always has
-- something to say: a settlement past the payment terms, a kill sheet held
-- because the producer's buyer-created invoice agreement has run out, a carcase
-- off the grid, a head unaccounted for, a lamb mob with no vendor declaration,
-- a cattle mob whose declaration says it is inside a withholding period, cattle
-- in the yards past the plant's time limit, tags not yet reported to NLIS,
-- a day booked over the kill floor's capacity, a producer bruising one carcase
-- in four, and a boning yield that dropped this week.
-- Idempotent: a second run does nothing.

do $$
declare
  t date := current_date;
  ag_ridge uuid; ag_west uuid;
  brk uuid; gln uuid; koo uuid; mil uuid; red uuid; tal uuid; war uuid; yar uuid;
  gc uuid; gl uuid; gs uuid;
  b uuid; i integer;
begin
  if exists (select 1 from settings) then return; end if;

  insert into settings (plant_name, plant_number, currency, jurisdiction, gst_pct, payment_days, feedback_days, trace_report_hours, lairage_max_hours, cattle_per_day, smallstock_per_day)
  values ('Tablelands Meat Co Pty Ltd', 'Est. 0000 (demo)', 'AUD', 'AU', 10, 7, 2, 48, 24, 300, 2500);

  -- Rates from the Department of Agriculture levy pages, checked 2026-11-19. Rates change: /levies shows the source and date of each.
  insert into levy_rates (species, name, basis, rate, cap_cents_per_head, source, checked_on) values
    ('cattle', 'Cattle transaction levy', 'per_head', 500, null, 'https://www.agriculture.gov.au/ag-farm-food/levies/rates/cattle-livestock-transaction', date '2026-11-19'),
    ('lamb', 'Lamb transaction levy', 'pct_of_value', 2, 150, 'https://www.agriculture.gov.au/agriculture-land/farm-food-drought/levies/rates/sheep-and-lamb-transaction', date '2026-11-19'),
    ('sheep', 'Sheep transaction levy', 'pct_of_value', 2, 20, 'https://www.agriculture.gov.au/agriculture-land/farm-food-drought/levies/rates/sheep-and-lamb-transaction', date '2026-11-19');

  insert into agents (name, company, commission_cents_per_head, email) values ('Ridge Livestock', 'Ridge Livestock and Property', 1500, 'office@ridgelivestock.example') returning id into ag_ridge;
  insert into agents (name, company, commission_cents_per_head, email) values ('Western Plains Agency', 'Western Plains Agency Pty Ltd', 120, 'bookings@westernplains.example') returning id into ag_west;

  -- ---------------------------------------------------------------- suppliers
  insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, agreement_signed_on, agreement_expires_on, bank_last4, agent_id, region, contact_name, email, phone)
  values ('BRK', 'Brookvale Pastoral Co', '41 552 908 113', true, 'NA123456', 'LPA 3301245', t + 400, t - 300, t + 430, '4821', ag_ridge, 'Guyra', 'Fiona Doyle', 'fiona@brookvale.example', '0400 111 201')
  returning id into brk;
  insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, agreement_signed_on, agreement_expires_on, bank_last4, agent_id, region, contact_name, email, phone)
  values ('GLN', 'Glenrock Partnership', '63 004 771 562', true, 'NA224681', 'LPA 3307781', t + 220, t - 705, t + 25, '1190', ag_ridge, 'Walcha', 'Hamish Glen', 'hamish@glenrock.example', '0400 111 202')
  returning id into gln;
  insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, agreement_signed_on, agreement_expires_on, bank_last4, agent_id, region, contact_name, email, phone)
  values ('KOO', 'Koorawatha Grazing Trust', '27 118 640 395', true, 'NG338150', 'LPA 3312290', t + 150, t - 740, t - 10, '7734', ag_west, 'Crookwell', 'Sally Burke', 'sally@koorawatha.example', '0400 111 203')
  returning id into koo;
  insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, agreement_signed_on, agreement_expires_on, bank_last4, agent_id, region, contact_name, email, phone)
  values ('MIL', 'Millbrook Farms', '85 330 219 004', true, 'NA412907', 'LPA 3309912', t + 300, t - 200, t + 530, '3302', ag_west, 'Uralla', 'Tom Millar', 'tom@millbrook.example', '0400 111 204')
  returning id into mil;
  insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, agreement_signed_on, agreement_expires_on, bank_last4, region, contact_name, email, phone)
  values ('RED', 'Redbank Cattle Co', '19 664 503 287', true, 'NA519330', 'LPA 3315567', t + 90, t - 150, t + 580, '6650', 'Glen Innes', 'Greg Redfern', 'greg@redbank.example', '0400 111 205')
  returning id into red;
  insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, agreement_signed_on, agreement_expires_on, bank_last4, region, contact_name, email, phone, notes)
  values ('TAL', 'Tallowood Station', '52 997 120 664', false, 'NA608812', 'LPA 3302871', t - 20, t - 90, t + 640, '0907', 'Tenterfield', 'June Tallis', 'june@tallowood.example', '0400 111 206', 'Not registered for GST: settlements carry no GST.')
  returning id into tal;
  insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, agreement_signed_on, agreement_expires_on, bank_last4, agent_id, region, contact_name, email, phone)
  values ('WAR', 'Warrigal Downs', '74 205 881 930', true, 'NG701145', 'LPA 3318834', t + 260, t - 400, t + 330, '5518', ag_west, 'Goulburn', 'Ben Warren', 'ben@warrigal.example', '0400 111 207')
  returning id into war;
  insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, bank_last4, region, contact_name, email, phone)
  values ('YAR', 'Yarran Creek Beef', '30 481 776 215', true, 'NA811270', 'LPA 3321106', t + 360, '2214', 'Inverell', 'Kate Yarran', 'kate@yarrancreek.example', '0400 111 208')
  returning id into yar;

  -- ---------------------------------------------------------------- grids
  insert into grids (code, species, name, valid_from, notes) values ('CAT-SPRING', 'cattle', 'Spring cattle grid', t - 60, 'Domestic and export, hot standard carcase weight') returning id into gc;
  insert into grid_lines (grid_id, sort, category, min_kg, max_kg, min_fat, max_fat, max_teeth, cents_per_kg) values
    (gc, 1, 'STEER', 220, 279.9, 2, 4, 2, 720), (gc, 2, 'STEER', 280, 339.9, 2, 4, 4, 745), (gc, 3, 'STEER', 340, 420, 2, 4, 4, 735),
    (gc, 4, 'HEIFER', 200, 279.9, 2, 4, 2, 705), (gc, 5, 'HEIFER', 280, 360, 2, 4, 4, 725),
    (gc, 6, 'STEER', 180, 420, 1, 5, 8, 640), (gc, 7, 'HEIFER', 180, 360, 1, 5, 8, 630),
    (gc, 8, 'COW', 160, 400, 1, 5, 8, 560), (gc, 9, 'BULL', 250, 550, 1, 5, 8, 600);
  insert into grid_deductions (grid_id, code, description, cents_per_kg) values
    (gc, 'BRUISE', 'Bruise score 2 or more', 40), (gc, 'DARK', 'Dark cutter (pH over 5.7)', 50);

  insert into grids (code, species, name, valid_from) values ('LAMB-SPRING', 'lamb', 'Spring lamb grid', t - 45) returning id into gl;
  insert into grid_lines (grid_id, sort, category, min_kg, max_kg, min_fat, max_fat, max_teeth, cents_per_kg) values
    (gl, 1, 'LAMB', 16, 23.9, 2, 4, 0, 1050), (gl, 2, 'LAMB', 24, 30, 2, 4, 0, 1020), (gl, 3, 'LAMB', 12, 15.9, 1, 3, 0, 950),
    (gl, 4, 'LAMB', 12, 32, 1, 5, 0, 900), (gl, 5, 'HOGGET', 16, 32, 1, 5, 2, 880);
  insert into grid_deductions (grid_id, code, description, cents_per_kg) values (gl, 'BRUISE', 'Bruise score 2 or more', 30);

  insert into grids (code, species, name, valid_from) values ('SHEEP-SPRING', 'sheep', 'Spring mutton grid', t - 45) returning id into gs;
  insert into grid_lines (grid_id, sort, category, min_kg, max_kg, min_fat, max_fat, max_teeth, cents_per_kg) values
    (gs, 1, 'MUTTON', 18, 35, 1, 5, 8, 620), (gs, 2, 'MUTTON', 12, 45, 1, 6, 8, 540);

  -- ---------------------------------------------------------------- B1001 Brookvale, 30 steers, settled and paid
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1001', brk, ag_ridge, 'cattle', 30, t - 14, gc, 'killed', 168000, 'Northern Tablelands Haulage') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_no, declaration_received, hgp_free, property_id_declared, pen, last_fed_at, actor)
  values (b, (t - 15) + time '16:30', 30, 'NVD 8841207', true, true, 'NA123456', 'P4', (t - 15) + time '06:00', 'Lisa Ng');
  insert into carcases (booking_id, kill_date, body_no, species, category, tag_id, hot_kg, fat_score, teeth, trace_reported_at)
  select b, t - 14, 100 + g, 'cattle', 'STEER', '982 0001' || lpad(g::text, 5, '0'), 285 + (g * 37 % 70), 2 + (g % 3), case when g % 6 = 0 then 2 else 0 end, (t - 14) + time '17:00'
    from generate_series(1, 30) g;

  -- ---------------------------------------------------------------- B1002 Millbrook, 400 lambs, settled and paid
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1002', mil, ag_west, 'lamb', 400, t - 12, gl, 'killed', 96000, 'Uralla Stock Transport') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, dead_on_arrival, declaration_no, declaration_received, property_id_declared, pen, last_fed_at, actor)
  values (b, (t - 13) + time '15:00', 400, 2, 'NVD 5512093', true, 'NA412907', 'S2', (t - 13) + time '07:00', 'Lisa Ng');
  insert into carcases (booking_id, kill_date, body_no, species, category, hot_kg, fat_score, teeth, bruise_score, trace_reported_at)
  select b, t - 12, g, 'lamb', 'LAMB', 18 + (g * 7 % 90) / 10.0, 2 + (g % 3), 0, case when g % 40 = 0 then 2 else 0 end, (t - 12) + time '18:00'
    from generate_series(1, 398) g;

  -- ---------------------------------------------------------------- B1003 Glenrock, 24 head, settled, unpaid and late
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1003', gln, ag_ridge, 'cattle', 24, t - 11, gc, 'killed', 142000, 'Northern Tablelands Haulage') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_no, declaration_received, hgp_free, property_id_declared, pen, last_fed_at, actor)
  values (b, (t - 12) + time '17:10', 24, 'NVD 8841577', true, true, 'NA224681', 'P2', (t - 12) + time '06:30', 'Lisa Ng');
  insert into carcases (booking_id, kill_date, body_no, species, category, tag_id, hot_kg, fat_score, teeth, trace_reported_at)
  select b, t - 11, 200 + g, 'cattle', case when g % 2 = 0 then 'HEIFER' else 'STEER' end, '982 0002' || lpad(g::text, 5, '0'), 250 + (g * 29 % 80), 2 + (g % 3), 0, (t - 11) + time '16:40'
    from generate_series(1, 24) g;

  -- ---------------------------------------------------------------- B1004 Redbank, 28 head, settled, not yet due. Bruising and a condemnation.
  insert into bookings (number, supplier_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1004', red, 'cattle', 28, t - 6, gc, 'killed', 151000, 'Redbank own truck') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_no, declaration_received, hgp_free, property_id_declared, lame_or_injured, pen, last_fed_at, actor)
  values (b, (t - 7) + time '18:20', 28, 'NVD 8842015', true, false, 'NA519330', 2, 'P6', (t - 7) + time '05:00', 'Lisa Ng');
  insert into carcases (booking_id, kill_date, body_no, species, category, tag_id, hot_kg, fat_score, teeth, bruise_score, dark_cutter, condemned, condemn_reason, trace_reported_at)
  select b, t - 6, 300 + g, 'cattle', 'STEER', '982 0003' || lpad(g::text, 5, '0'), 300 + (g * 23 % 90), 2 + (g % 3), case when g % 4 = 0 then 4 else 2 end,
         case when g % 4 = 1 then 2 else 0 end, g % 9 = 0, g = 17, case when g = 17 then 'Abscess, whole carcase' end, (t - 6) + time '16:00'
    from generate_series(1, 28) g;

  -- ---------------------------------------------------------------- B1005 Koorawatha, 350 lambs, killed, agreement expired
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1005', koo, ag_west, 'lamb', 350, t - 3, gl, 'killed', 88000, 'Crookwell Carriers') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_no, declaration_received, property_id_declared, pen, last_fed_at, actor)
  values (b, (t - 4) + time '14:00', 350, 'NVD 5513340', true, 'NG338150', 'S1', (t - 4) + time '06:00', 'Lisa Ng');
  insert into carcases (booking_id, kill_date, body_no, species, category, hot_kg, fat_score, teeth, bruise_score, trace_reported_at)
  select b, t - 3, g, 'lamb', 'LAMB', 17 + (g * 11 % 100) / 10.0, 2 + (g % 3), 0, case when g % 50 = 0 then 2 else 0 end, (t - 3) + time '17:30'
    from generate_series(1, 350) g;

  -- ---------------------------------------------------------------- B1006 Tallowood, 18 head, one carcase off grid, tags not reported
  insert into bookings (number, supplier_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1006', tal, 'cattle', 18, t - 2, gc, 'killed', 0, 'Delivered by producer') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_no, declaration_received, hgp_free, property_id_declared, pen, last_fed_at, actor)
  values (b, (t - 3) + time '16:00', 18, 'NVD 8842390', true, true, 'NA608812', 'P1', (t - 3) + time '07:00', 'Lisa Ng');
  insert into carcases (booking_id, kill_date, body_no, species, category, tag_id, hot_kg, fat_score, teeth)
  select b, t - 2, 400 + g, 'cattle', case when g <= 4 then 'COW' else 'STEER' end, '982 0004' || lpad(g::text, 5, '0'), 240 + (g * 31 % 110),
         case when g = 9 then 6 else 2 + (g % 3) end, case when g <= 4 then 8 else 2 end
    from generate_series(1, 18) g;

  -- ---------------------------------------------------------------- B1007 Brookvale, 32 head, one unaccounted for, tags not reported
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1007', brk, ag_ridge, 'cattle', 32, t - 1, gc, 'killed', 176000, 'Northern Tablelands Haulage') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_no, declaration_received, hgp_free, property_id_declared, pen, last_fed_at, actor)
  values (b, (t - 2) + time '17:45', 32, 'NVD 8842611', true, true, 'NA123456', 'P3', (t - 2) + time '06:00', 'Lisa Ng');
  insert into carcases (booking_id, kill_date, body_no, species, category, tag_id, hot_kg, fat_score, teeth)
  select b, t - 1, 500 + g, 'cattle', case when g % 3 = 0 then 'HEIFER' else 'STEER' end, '982 0005' || lpad(g::text, 5, '0'), 270 + (g * 41 % 90), 2 + (g % 3), 0
    from generate_series(1, 31) g;

  -- ---------------------------------------------------------------- B1008 Millbrook, 450 lambs, killed, no vendor declaration on file
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1008', mil, ag_west, 'lamb', 450, t - 1, gl, 'killed', 102000, 'Uralla Stock Transport') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_received, property_id_declared, pen, last_fed_at, notes, actor)
  values (b, (t - 2) + time '15:20', 450, false, 'NA412907', 'S3', (t - 2) + time '07:00', 'Driver said the declaration was emailed. Not found yet.', 'Lisa Ng');
  insert into carcases (booking_id, kill_date, body_no, species, category, hot_kg, fat_score, teeth)
  select b, t - 1, g, 'lamb', 'LAMB', 18 + (g * 13 % 80) / 10.0, 2 + (g % 3), 0
    from generate_series(1, 450) g;

  -- ---------------------------------------------------------------- today: two cattle mobs in the yards
  insert into bookings (number, supplier_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1009', red, 'cattle', 30, t, gc, 'arrived', 158000, 'Redbank own truck') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_no, declaration_received, hgp_free, property_id_declared, pen, last_fed_at, actor)
  values (b, (localtimestamp - interval '30 hours')::timestamp(0), 30, 'NVD 8842807', true, false, 'NA519330', 'P5', (localtimestamp - interval '36 hours')::timestamp(0), 'Lisa Ng');

  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, status, freight_cents, carrier)
  values ('B1010', gln, ag_ridge, 'cattle', 20, t, gc, 'arrived', 128000, 'Northern Tablelands Haulage') returning id into b;
  insert into arrivals (booking_id, arrived_at, head_received, declaration_no, declaration_received, withholding_clear, hgp_free, property_id_declared, pen, last_fed_at, notes, actor)
  values (b, (localtimestamp - interval '14 hours')::timestamp(0), 20, 'NVD 8842844', true, false, true, 'NA224681', 'P7', (localtimestamp - interval '18 hours')::timestamp(0),
          'Declaration question 5: drenched 12 days ago, ESI not yet passed.', 'Lisa Ng');

  -- ---------------------------------------------------------------- the forward kill
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, freight_cents) values ('B1011', brk, ag_ridge, 'cattle', 40, t + 1, gc, 190000);
  insert into bookings (number, supplier_id, species, head_booked, kill_date, grid_id) values ('B1012', yar, 'cattle', 25, t + 2, gc);
  insert into bookings (number, supplier_id, species, head_booked, kill_date, grid_id, freight_cents) values ('B1016', red, 'cattle', 120, t + 2, gc, 420000);
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, freight_cents) values ('B1017', brk, ag_ridge, 'cattle', 200, t + 2, gc, 560000);
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id) values ('B1013', mil, ag_west, 'lamb', 600, t + 3, gl);
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id) values ('B1015', war, ag_west, 'sheep', 300, t + 4, gs);
  insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id) values ('B1014', koo, ag_west, 'lamb', 500, t + 7, gl);
  insert into bookings (number, supplier_id, species, head_booked, kill_date, grid_id, status, cancelled_reason) values ('B1018', tal, 'cattle', 15, t + 5, gc, 'cancelled', 'Producer kept them for the store sale');
  update suppliers set status = 'hold', hold_reason = 'Bank account change requested by email: confirm by phone before paying' where id = war;

  -- ---------------------------------------------------------------- settlements
  perform issue_settlement((select id from bookings where number = 'B1001'), t - 13, 'Anna Kerr');
  perform issue_settlement((select id from bookings where number = 'B1002'), t - 11, 'Anna Kerr');
  perform issue_settlement((select id from bookings where number = 'B1003'), t - 10, 'Anna Kerr');
  perform issue_settlement((select id from bookings where number = 'B1004'), t - 5, 'Anna Kerr');
  update settlements set status = 'paid', paid_on = t - 8, payment_ref = 'EFT 20431' where number = 'S-B1001';
  update settlements set status = 'paid', paid_on = t - 6, payment_ref = 'EFT 20457' where number = 'S-B1002';

  -- ---------------------------------------------------------------- boning yields, three weeks
  insert into boning_runs (run_on, species, category, carcase_kg, saleable_kg, fat_bone_kg, cartons, actor) values
    (t - 20, 'cattle', 'STEER', 9200, 6440, 2650, 254, 'Mark Owens'),
    (t - 13, 'cattle', 'STEER', 9650, 6780, 2770, 268, 'Mark Owens'),
    (t - 10, 'cattle', 'HEIFER', 6100, 4250, 1780, 168, 'Mark Owens'),
    (t - 5, 'cattle', 'STEER', 9050, 6010, 2880, 237, 'Mark Owens'),
    (t - 19, 'lamb', 'LAMB', 7900, 5700, 2110, 285, 'Mark Owens'),
    (t - 11, 'lamb', 'LAMB', 8300, 6010, 2200, 300, 'Mark Owens'),
    (t - 2, 'lamb', 'LAMB', 7100, 5110, 1910, 255, 'Mark Owens');

  insert into notes (supplier_id, body, actor) values
    (red, 'Rang Greg about bruising on B1004: he thinks the loading ramp at Glen Innes. Will check before the next load.', 'Anna Kerr'),
    (gln, 'Hamish asked when B1003 will be paid. Told him this week.', 'Anna Kerr');
  insert into history (actor, action, subject) values ('Seed', 'demo data loaded', 'Tablelands Meat Co');
end
$$;
