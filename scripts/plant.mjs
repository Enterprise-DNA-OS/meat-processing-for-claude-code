#!/usr/bin/env node
// meat-processing-for-claude-code: the one CLI. Claude Code slash commands call
// this; so can you.
//
//   node scripts/plant.mjs <command> [args] [--flags] [--json]
//   npm run plant -- <command> ...
//
// Run with no arguments (or `help`) for the command list.
//
// This system holds a red meat plant's office: producers and agents, price
// grids, kill bookings, arrivals and vendor declarations, the kill sheet,
// settlements (buyer-created tax invoices), levies, boning yields and the
// traceability report. It records payments the bank has made and uploads made
// to NLIS or NAIT; it never makes either.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDb, REPO_ROOT } from './lib/db.mjs';
import { parseCsv, pick, yesNo } from './lib/csv.mjs';
import { table as fmtTable, price, truncate, heading as fmtHeading } from './lib/format.mjs';

function table(rows, cols) {
  console.log(fmtTable(rows, cols.map(([key, label, format]) => ({ key, label, format, align: [$, pct, kg, num0].includes(format) ? 'right' : 'left' }))));
}
function heading(text) { console.log(fmtHeading(text)); }

// ---------------------------------------------------------------- arguments

const BOOL_FLAGS = new Set(['json', 'help', 'all', 'dry-run', 'condemned', 'dark', 'gst', 'no-gst', 'clear', 'not-clear', 'received']);

function parseArgv(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name; let value;
      if (eq > -1) { name = a.slice(2, eq); value = a.slice(eq + 1); }
      else {
        name = a.slice(2);
        const next = argv[i + 1];
        if (BOOL_FLAGS.has(name) || next === undefined || next.startsWith('--')) value = true;
        else value = argv[++i];
      }
      flags[name] = value;
    } else args.push(a);
  }
  return { args, flags };
}

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

const n = (v) => Number(v ?? 0);
const str = (v) => (v === true || v === undefined || v === null ? '' : String(v));

function today() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(iso, k) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
}
function parseDate(v, what = 'date') {
  if (!v || v === true) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const lower = s.toLowerCase();
  if (lower === 'today') return today();
  if (lower === 'yesterday') return addDays(today(), -1);
  if (lower === 'tomorrow') return addDays(today(), 1);
  // Australian and New Zealand exports write DD/MM/YYYY.
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  throw new CliError(`"${v}" is not a ${what}. Use YYYY-MM-DD.`);
}
function parseTimestamp(v) {
  if (!v || v === true) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}$/.test(s)) return s.replace('T', ' ') + ':00';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}:\d{2}$/.test(s)) return s.replace('T', ' ');
  if (s.toLowerCase() === 'now') return null;
  throw new CliError(`"${v}" is not a time. Use "YYYY-MM-DD HH:MM".`);
}
function parseMoney(v, what = 'amount') {
  if (v === undefined || v === null || v === '' || v === true) throw new CliError(`Give the ${what} in dollars, for example 1680 or 1680.50.`);
  const s = String(v).replace(/[$,\s]/g, '');
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  const x = Number(s.replace(/[()-]/g, ''));
  if (!Number.isFinite(x)) throw new CliError(`"${v}" is not an amount.`);
  return Math.round((neg ? -x : x) * 100);
}
function parseInt0(v, what) {
  const x = Number(String(v ?? '').replace(/[,\s]/g, ''));
  if (!Number.isInteger(x) || x < 0) throw new CliError(`"${v}" is not a whole number of ${what}.`);
  return x;
}
function parseKg(v, what = 'weight') {
  const x = Number(String(v ?? '').replace(/[,\skg]/gi, ''));
  if (!Number.isFinite(x) || x < 0) throw new CliError(`"${v}" is not a ${what} in kilograms.`);
  return Math.round(x * 10) / 10;
}
function actorOf(flags) {
  const a = str(flags.actor) || process.env.PLANT_ACTOR || '';
  if (!a.trim()) throw new CliError('Name who is doing this: --actor="Your name" (or set PLANT_ACTOR). Every change is recorded against a person.');
  return a.trim();
}
const SPECIES = ['cattle', 'sheep', 'lamb', 'goat'];
function species(v) {
  const s = str(v).toLowerCase().replace(/s$/, '');
  const map = { cattle: 'cattle', cow: 'cattle', beef: 'cattle', sheep: 'sheep', mutton: 'sheep', lamb: 'lamb', goat: 'goat' };
  if (!map[s]) throw new CliError(`"${v}" is not a species. Use ${SPECIES.join(', ')}.`);
  return map[s];
}

let CURRENCY = 'AUD';
const $ = (cents) => price(cents, CURRENCY);
const pct = (v) => (v === null || v === undefined ? '' : `${Number(v).toFixed(1)}%`);
const kg = (v) => (v === null || v === undefined ? '' : `${Number(v).toLocaleString('en-AU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`);
const num0 = (v) => (v === null || v === undefined ? '' : String(Math.round(Number(v))));
const ckg = (v) => (v === null || v === undefined ? 'OFF GRID' : `${(Number(v) / 100).toFixed(2)}/kg`);

// ---------------------------------------------------------------- lookups

const RESOLVERS = {
  supplier: {
    from: 'suppliers c',
    cols: 'c.*',
    exact: "lower(c.code) = lower($1) or lower(c.name) = lower($1) or lower(coalesce(c.property_id, '')) = lower($1) or lower(coalesce(c.business_number, '')) = lower($1)",
    fuzzy: 'c.code ilike $1 or c.name ilike $1 or c.trading_name ilike $1',
    label: (r) => `${r.code}  ${r.name} (${r.status})`,
  },
  booking: {
    from: 'bookings c join suppliers s on s.id = c.supplier_id',
    cols: 'c.*, s.code as supplier_code, s.name as supplier_name',
    exact: 'lower(c.number) = lower($1)',
    fuzzy: 'c.number ilike $1',
    label: (r) => `${r.number}  ${r.supplier_code} ${r.head_booked} ${r.species} ${r.kill_date} (${r.status})`,
  },
  settlement: {
    from: 'settlements c join suppliers s on s.id = c.supplier_id join bookings b on b.id = c.booking_id',
    cols: 'c.*, s.code as supplier_code, s.name as supplier_name, b.number as booking_no, b.kill_date',
    exact: "lower(c.number) = lower($1) or (c.kind = 'settlement' and lower(b.number) = lower($1))",
    fuzzy: 'c.number ilike $1',
    label: (r) => `${r.number}  ${r.supplier_code} ${$(r.net_cents)} (${r.status})`,
  },
  agent: {
    from: 'agents c',
    cols: 'c.*',
    exact: 'lower(c.name) = lower($1) or lower(coalesce(c.company, \'\')) = lower($1)',
    fuzzy: 'c.name ilike $1 or c.company ilike $1',
    label: (r) => r.name,
  },
  grid: {
    from: 'grids c',
    cols: 'c.*',
    exact: 'lower(c.code) = lower($1) or lower(c.name) = lower($1)',
    fuzzy: 'c.code ilike $1 or c.name ilike $1',
    label: (r) => `${r.code}  ${r.name} (${r.species})`,
  },
};

async function resolve(db, kind, ref) {
  const r = RESOLVERS[kind];
  if (!ref || ref === true) throw new CliError(`Name the ${kind}.`);
  ref = String(ref);
  let rows = await db.query(`select ${r.cols} from ${r.from} where ${r.exact}`, [ref]);
  if (!rows.length && /^[0-9a-f-]{6,}$/i.test(ref)) rows = await db.query(`select ${r.cols} from ${r.from} where c.id::text like $1`, [`${ref.toLowerCase()}%`]);
  if (!rows.length) rows = await db.query(`select ${r.cols} from ${r.from} where ${r.fuzzy} limit 20`, [`%${ref}%`]);
  if (!rows.length) throw new CliError(`No ${kind} matches "${ref}".`);
  if (rows.length > 1) throw new CliError(`"${ref}" matches ${rows.length} ${kind} records. Be more specific:\n${rows.map((x) => `  ${r.label(x)}`).join('\n')}`);
  return rows[0];
}

async function record(db, actor, action, subject, detail = null) {
  await db.query('insert into history (actor, action, subject, detail) values ($1, $2, $3, $4)', [actor, action, subject, detail ? JSON.stringify(detail) : null]);
}

async function settings(db) {
  const [s] = await db.query('select * from settings');
  if (!s) throw new CliError('No settings row. Run npm run demo for the demo, or insert your plant details into settings first.');
  CURRENCY = s.currency;
  return s;
}

async function tx(db, fn) {
  await db.exec('BEGIN');
  try {
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (e) {
    await db.exec('ROLLBACK');
    throw e;
  }
}

function out(flags, data, human) {
  if (flags.json) { console.log(JSON.stringify(data, null, 2)); return; }
  human(data);
}

// ---------------------------------------------------------------- reads: producers, agents, grids

async function cmdSuppliers(db, { flags }) {
  const where = flags.all ? '' : "where s.status <> 'closed'";
  const rows = await db.query(`
    select s.code, s.name, s.status, s.region, s.gst_registered, s.property_id, s.agreement_expires_on, s.quality_assurance_expires_on,
           a.name as agent, p.carcases, p.avg_cents_per_kg, p.bruised_pct, p.condemned_pct,
           (select count(*) from bookings b where b.supplier_id = s.id and b.status in ('booked', 'arrived') )::int as open_bookings
      from suppliers s left join agents a on a.id = s.agent_id
      left join v_supplier_performance p on p.supplier_id = s.id
      ${where} order by s.code`);
  out(flags, rows, (r) => {
    heading(`Suppliers (${r.length})`);
    table(r, [['code', 'Code'], ['name', 'Name'], ['status', 'Status'], ['region', 'Region'], ['agent', 'Agent'],
      ['agreement_expires_on', 'Agreement ends', (v, x) => (x.gst_registered ? v || 'NONE' : 'not GST')], ['carcases', '90-day head', num0],
      ['avg_cents_per_kg', 'Avg c/kg', num0], ['bruised_pct', 'Bruised', pct], ['open_bookings', 'Booked', num0]]);
  });
}

async function cmdSupplier(db, { args, flags }) {
  const s = await resolve(db, 'supplier', args.join(' '));
  const [perf] = await db.query('select * from v_supplier_performance where supplier_id = $1', [s.id]);
  const bookings = await db.query('select number, kill_date, species, status, head_booked, head_received, killed, condemned, value_cents, settlement_no, settlement_status from v_bookings where supplier_id = $1 order by kill_date desc limit 12', [s.id]);
  const open = await db.query('select number, issued_on, due_on, net_cents, days_late from v_settlements_open where supplier_code = $1 order by due_on', [s.code]);
  const notes = await db.query('select created_at, actor, body from notes where supplier_id = $1 order by created_at desc limit 10', [s.id]);
  const [agent] = s.agent_id ? await db.query('select name, commission_cents_per_head from agents where id = $1', [s.agent_id]) : [];
  out(flags, { supplier: s, agent: agent || null, performance: perf, bookings, open_settlements: open, notes }, (d) => {
    heading(`${s.code}  ${s.name}`);
    console.log(`  ${s.status}${s.hold_reason ? ` (${s.hold_reason})` : ''}, ${s.region || 'region not set'}. Contact ${s.contact_name || '-'} ${s.phone || ''} ${s.email || ''}`);
    console.log(`  ${s.business_number ? `ABN/NZBN ${s.business_number}, ` : ''}${s.gst_registered ? 'registered for GST' : 'NOT registered for GST'}. Property ${s.property_id || 'not recorded'}. Bank account ending ${s.bank_last4 || 'not recorded'}.`);
    console.log(`  Buyer-created invoice agreement: ${s.agreement_signed_on ? `signed ${s.agreement_signed_on}, ends ${s.agreement_expires_on || 'no end date'}` : 'none on file'}.`);
    console.log(`  Quality assurance: ${s.quality_assurance_no || 'not recorded'}${s.quality_assurance_expires_on ? `, ends ${s.quality_assurance_expires_on}` : ''}. Agent: ${agent ? agent.name : 'direct'}.`);
    if (perf && n(perf.carcases)) console.log(`  Last 90 days: ${perf.carcases} carcases, average ${perf.avg_kg} kg at ${perf.avg_cents_per_kg} c/kg, ${pct(perf.bruised_pct)} bruised, ${pct(perf.dark_pct)} dark cutters, ${pct(perf.condemned_pct)} condemned, ${$(perf.deductions_cents)} in grid discounts.`);
    console.log('\n  Bookings');
    table(bookings, [['number', 'Booking'], ['kill_date', 'Kill date'], ['species', 'Species'], ['status', 'Status'], ['head_booked', 'Booked', num0], ['killed', 'Killed', num0], ['value_cents', 'Value', $], ['settlement_no', 'Settlement'], ['settlement_status', 'Paid?']]);
    if (open.length) { console.log('\n  Unpaid settlements'); table(open, [['number', 'Settlement'], ['due_on', 'Due'], ['net_cents', 'Net', $], ['days_late', 'Days late', (v) => (n(v) > 0 ? `${v} LATE` : '')]]); }
    if (notes.length) { console.log('\n  Notes'); table(notes, [['created_at', 'When', (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 10)], ['actor', 'Who'], ['body', 'Note', (v) => truncate(v, 90)]]); }
  });
}

async function cmdAgents(db, { flags }) {
  const rows = await db.query(`select a.name, a.company, a.commission_cents_per_head, a.email,
      (select count(*) from suppliers s where s.agent_id = a.id)::int as suppliers,
      (select coalesce(sum(b.head_booked), 0) from bookings b where b.agent_id = a.id and b.kill_date >= current_date - 90 and b.status <> 'cancelled')::int as head_90
    from agents a order by a.name`);
  out(flags, rows, (r) => { heading('Agents'); table(r, [['name', 'Agent'], ['company', 'Company'], ['commission_cents_per_head', 'Commission/head', $], ['suppliers', 'Suppliers', num0], ['head_90', 'Head, 90 days', num0]]); });
}

async function cmdGrids(db, { flags }) {
  const rows = await db.query(`select g.code, g.species, g.name, g.valid_from, g.valid_to, count(l.id)::int as lines, min(l.cents_per_kg) as low, max(l.cents_per_kg) as high
    from grids g left join grid_lines l on l.grid_id = g.id group by g.id order by g.species, g.valid_from desc`);
  out(flags, rows, (r) => { heading('Price grids'); table(r, [['code', 'Grid'], ['species', 'Species'], ['name', 'Name'], ['valid_from', 'From'], ['valid_to', 'To'], ['lines', 'Lines', num0], ['low', 'Lowest c/kg', num0], ['high', 'Highest c/kg', num0]]); });
}

async function cmdGrid(db, { args, flags }) {
  const g = await resolve(db, 'grid', args.join(' '));
  const lines = await db.query('select sort, category, min_kg, max_kg, min_fat, max_fat, max_teeth, cents_per_kg from grid_lines where grid_id = $1 order by sort', [g.id]);
  const deductions = await db.query('select code, description, cents_per_kg, cents_per_head from grid_deductions where grid_id = $1 order by code', [g.id]);
  out(flags, { grid: g, lines, deductions }, (d) => {
    heading(`${g.code}  ${g.name} (${g.species}), valid ${g.valid_from} to ${g.valid_to || 'open'}`);
    table(lines, [['sort', '#', num0], ['category', 'Category'], ['min_kg', 'From kg', kg], ['max_kg', 'To kg', kg], ['min_fat', 'Fat from', num0], ['max_fat', 'Fat to', num0], ['max_teeth', 'Max teeth', num0], ['cents_per_kg', 'c/kg', num0]]);
    console.log('\n  Discounts');
    table(deductions, [['code', 'Code'], ['description', 'What'], ['cents_per_kg', 'c/kg', num0], ['cents_per_head', 'c/head', num0]]);
    console.log('\n  A carcase takes the first line it fits, in order. One that fits none is off grid and holds the settlement until it is priced.');
  });
}

// ---------------------------------------------------------------- reads: the kill

async function cmdBookings(db, { flags }) {
  const from = parseDate(flags.from) || addDays(today(), -14);
  const to = parseDate(flags.to) || addDays(today(), 28);
  const params = [from, to];
  let where = 'kill_date between $1 and $2';
  if (flags.status && flags.status !== true) { params.push(String(flags.status)); where += ` and status = $${params.length}`; }
  if (flags.species && flags.species !== true) { params.push(species(flags.species)); where += ` and species = $${params.length}`; }
  const rows = await db.query(`select number, kill_date, species, supplier_code, supplier_name, agent_name, grid_code, status, head_booked, head_received, killed, unaccounted, settlement_no, settlement_status
    from v_bookings where ${where} order by kill_date, number`, params);
  out(flags, rows, (r) => {
    heading(`Bookings ${from} to ${to} (${r.length})`);
    table(r, [['number', 'Booking'], ['kill_date', 'Kill date'], ['species', 'Species'], ['supplier_code', 'Supplier'], ['grid_code', 'Grid'], ['status', 'Status'],
      ['head_booked', 'Booked', num0], ['head_received', 'Arrived', num0], ['killed', 'Killed', num0], ['settlement_no', 'Settlement'], ['settlement_status', 'Paid?']]);
  });
}

async function yardRows(db) {
  return db.query(`select b.number, b.kill_date, b.species, s.code as supplier_code, a.pen, a.arrived_at, a.head_received, a.dead_on_arrival, a.lame_or_injured,
      a.declaration_received, a.withholding_clear, a.hgp_free, a.last_fed_at,
      round(extract(epoch from (localtimestamp - a.arrived_at)) / 3600.0, 1) as hours_in_yards,
      round(extract(epoch from (localtimestamp - a.last_fed_at)) / 3600.0, 1) as hours_off_feed,
      a.head_received - a.dead_on_arrival - (select count(*) from carcases c where c.booking_id = b.id) as still_to_kill
    from bookings b join arrivals a on a.booking_id = b.id join suppliers s on s.id = b.supplier_id
   where b.status = 'arrived' order by a.arrived_at`);
}

async function cmdYards(db, { flags }) {
  const s = await settings(db);
  const rows = await yardRows(db);
  out(flags, rows, (r) => {
    heading(`In the yards now (${r.reduce((t, x) => t + n(x.still_to_kill), 0)} head)`);
    table(r, [['number', 'Booking'], ['supplier_code', 'Supplier'], ['species', 'Species'], ['pen', 'Pen'], ['still_to_kill', 'Head', num0],
      ['hours_in_yards', 'Hours in yards', (v) => `${v}${n(v) > s.lairage_max_hours ? ' OVER' : ''}`], ['hours_off_feed', 'Hours off feed', (v) => (v === null ? '?' : String(v))],
      ['declaration_received', 'Declaration', (v) => (v ? 'yes' : 'MISSING')], ['withholding_clear', 'Withholding', (v) => (v ? 'clear' : 'NOT CLEAR')]]);
    console.log(`\n  Plant limit: ${s.lairage_max_hours} hours in the yards before slaughter.`);
  });
}

async function cmdAgenda(db, { args, flags }) {
  const s = await settings(db);
  const day = parseDate(args[0] || flags.date) || today();
  const rows = await db.query(`select number, species, supplier_code, supplier_name, agent_name, grid_code, status, head_booked, head_received, dead_on_arrival, killed,
      declaration_received, withholding_clear, arrived_at from v_bookings where kill_date = $1 and status <> 'cancelled' order by species, number`, [day]);
  const cattle = rows.filter((r) => r.species === 'cattle').reduce((t, r) => t + n(r.head_received ?? r.head_booked), 0);
  const small = rows.filter((r) => r.species !== 'cattle').reduce((t, r) => t + n(r.head_received ?? r.head_booked), 0);
  const holds = rows.filter((r) => r.head_received !== null && (!r.declaration_received || !r.withholding_clear)).map((r) => ({ number: r.number, why: !r.declaration_received ? 'no vendor declaration' : 'declaration shows a withholding period or ESI not passed' }));
  const data = { date: day, bookings: rows, cattle_head: cattle, cattle_capacity: s.cattle_per_day, smallstock_head: small, smallstock_capacity: s.smallstock_per_day, holds };
  out(flags, data, (d) => {
    heading(`Kill agenda ${day}: ${cattle} cattle of ${s.cattle_per_day}, ${small} smallstock of ${s.smallstock_per_day}`);
    table(rows, [['number', 'Booking'], ['species', 'Species'], ['supplier_code', 'Supplier'], ['agent_name', 'Agent'], ['grid_code', 'Grid'], ['head_booked', 'Booked', num0],
      ['head_received', 'Arrived', (v) => (v === null ? 'not yet' : String(v))], ['killed', 'Killed', num0], ['status', 'Status']]);
    if (holds.length) { console.log('\n  Do not kill until cleared:'); for (const h of holds) console.log(`  ${h.number}: ${h.why}`); }
    if (cattle > s.cattle_per_day || small > s.smallstock_per_day) console.log('\n  OVER CAPACITY: move a booking or add a shift.');
  });
}

async function cmdSupply(db, { flags }) {
  const s = await settings(db);
  const days = n(flags.days) || 28;
  const rows = await db.query(`select kill_date, sum(head_booked) filter (where species = 'cattle')::int as cattle, sum(head_booked) filter (where species <> 'cattle')::int as smallstock,
      count(*)::int as bookings from bookings where status in ('booked', 'arrived') and kill_date between current_date and current_date + $1::int group by kill_date order by kill_date`, [days]);
  for (const r of rows) {
    r.cattle_pct = Math.round(100 * n(r.cattle) / s.cattle_per_day);
    r.smallstock_pct = Math.round(100 * n(r.smallstock) / s.smallstock_per_day);
    r.over = n(r.cattle) > s.cattle_per_day || n(r.smallstock) > s.smallstock_per_day;
  }
  out(flags, rows, (r) => {
    heading(`Forward supply, next ${days} days (capacity ${s.cattle_per_day} cattle, ${s.smallstock_per_day} smallstock a day)`);
    table(r, [['kill_date', 'Kill date'], ['bookings', 'Bookings', num0], ['cattle', 'Cattle', num0], ['cattle_pct', 'Cattle %', (v) => `${v}%`], ['smallstock', 'Smallstock', num0], ['smallstock_pct', 'Smallstock %', (v) => `${v}%`], ['over', '', (v) => (v ? 'OVER' : '')]]);
  });
}

async function bookingFull(db, ref) {
  const b = await resolve(db, 'booking', ref);
  const [v] = await db.query('select * from v_bookings where id = $1', [b.id]);
  const [arrival] = await db.query('select * from arrivals where booking_id = $1', [b.id]);
  return { b, v, arrival: arrival || null };
}

async function cmdKillSheet(db, { args, flags }) {
  const { b, v, arrival } = await bookingFull(db, args[0]);
  const carcases = await db.query(`select body_no, tag_id, category, hot_kg, fat_score, teeth, bruise_score, dark_cutter, condemned, condemn_reason, cents_per_kg, deduction_cents, value_cents, off_grid
    from v_carcases where booking_id = $1 order by body_no`, [b.id]);
  const byGrade = await db.query(`select coalesce(grid_category, category) as category, count(*)::int as head, round(avg(hot_kg), 1) as avg_kg, round(avg(cents_per_kg), 0) as avg_c,
      sum(value_cents) as value_cents from v_carcases where booking_id = $1 group by 1 order by 1`, [b.id]);
  out(flags, { booking: v, arrival, by_category: byGrade, carcases }, () => {
    heading(`Kill sheet ${b.number}: ${b.supplier_code} ${b.supplier_name}, ${b.species}, killed ${b.kill_date}`);
    if (arrival) console.log(`  Arrived ${String(arrival.arrived_at).slice(0, 16)}: ${arrival.head_received} head, ${arrival.dead_on_arrival} dead on arrival. Declaration ${arrival.declaration_received ? arrival.declaration_no || 'received' : 'NOT RECEIVED'}.`);
    console.log(`  ${v.killed} killed, ${v.condemned} condemned, ${v.off_grid} off grid${n(v.unaccounted) ? `, ${v.unaccounted} UNACCOUNTED FOR` : ''}. Total ${kg(v.hot_kg)} kg hot, ${$(v.value_cents)}.`);
    console.log('');
    table(byGrade, [['category', 'Category'], ['head', 'Head', num0], ['avg_kg', 'Avg kg', kg], ['avg_c', 'Avg c/kg', num0], ['value_cents', 'Value', $]]);
    const shown = carcases.length > 40 && !flags.all ? carcases.filter((c) => c.off_grid || c.condemned || c.bruise_score >= 2 || c.dark_cutter) : carcases;
    console.log(`\n  ${shown === carcases ? 'Every carcase' : `Carcases with a problem (${shown.length} of ${carcases.length}; --all for every one)`}`);
    table(shown, [['body_no', 'Body', num0], ['tag_id', 'Tag'], ['category', 'Cat'], ['hot_kg', 'HSCW kg', kg], ['fat_score', 'Fat', num0], ['teeth', 'Teeth', num0], ['bruise_score', 'Bruise', num0],
      ['dark_cutter', 'Dark', (x) => (x ? 'yes' : '')], ['cents_per_kg', 'Price', (x, r) => (r.condemned ? 'CONDEMNED' : ckg(x))], ['deduction_cents', 'Discount', $], ['value_cents', 'Value', $]]);
  });
}

async function cmdOffGrid(db, { flags }) {
  const rows = await db.query(`select c.booking_no, c.supplier_code, c.kill_date, c.body_no, c.tag_id, c.category, c.hot_kg, c.fat_score, c.teeth, c.grid_code,
      (select gl.category || ' ' || gl.min_kg || '-' || gl.max_kg || 'kg fat ' || gl.min_fat || '-' || gl.max_fat || ' at ' || gl.cents_per_kg || 'c'
         from grid_lines gl join grids g on g.id = gl.grid_id where g.code = c.grid_code and upper(gl.category) = upper(c.category)
         order by abs(c.hot_kg - (gl.min_kg + gl.max_kg) / 2) + 20 * greatest(0, coalesce(c.fat_score, 0) - gl.max_fat, gl.min_fat - coalesce(c.fat_score, 0)) limit 1) as nearest_line
    from v_carcases c where c.off_grid and c.booking_status <> 'settled' order by c.kill_date, c.body_no`);
  out(flags, rows, (r) => {
    heading(`Off grid (${r.length})`);
    table(r, [['booking_no', 'Booking'], ['supplier_code', 'Supplier'], ['kill_date', 'Killed'], ['body_no', 'Body', num0], ['category', 'Cat'], ['hot_kg', 'kg', kg], ['fat_score', 'Fat', num0], ['teeth', 'Teeth', num0], ['nearest_line', 'Nearest grid line']]);
    if (r.length) console.log('\n  Agree a price with the producer, then record it with: price <booking> <body> --cents=<c/kg> --reason="..."');
  });
}

async function cmdPrice(db, { args, flags }) {
  const actor = actorOf(flags);
  const { b } = await bookingFull(db, args[0]);
  const body = parseInt0(args[1], 'body number');
  const cents = parseInt0(flags.cents, 'cents per kilogram');
  if (!str(flags.reason)) throw new CliError('Say why: --reason="agreed with the producer by phone".');
  const [c] = await db.query('select * from carcases where booking_id = $1 and body_no = $2', [b.id, body]);
  if (!c) throw new CliError(`No body ${body} on ${b.number}.`);
  if (c.cents_per_kg !== null && !c.condemned) throw new CliError(`Body ${body} is already on the grid at ${c.cents_per_kg} c/kg. Correct its measurements with regrade instead.`);
  if (c.condemned) throw new CliError(`Body ${body} is condemned and is not paid.`);
  await tx(db, async () => {
    await db.query('update carcases set agreed_cents_per_kg = $2, agreed_reason = $3 where id = $1', [c.id, cents, str(flags.reason)]);
    await record(db, actor, 'price off grid', `${b.number} body ${body}`, { cents_per_kg: cents, reason: str(flags.reason) });
  });
  const [after] = await db.query('select cents_per_kg, value_cents from carcases where id = $1', [c.id]);
  out(flags, { booking: b.number, body, ...after }, (d) => console.log(`${b.number} body ${body} priced at ${d.cents_per_kg} c/kg: ${$(d.value_cents)}.`));
}

async function cmdCarcases(db, { flags }) {
  const day = parseDate(flags.date) || addDays(today(), -1);
  const rows = await db.query(`select species, coalesce(grid_category, category) as category, count(*)::int as head, round(avg(hot_kg), 1) as avg_kg, round(sum(hot_kg), 1) as total_kg,
      round(avg(cents_per_kg), 0) as avg_c, count(*) filter (where condemned)::int as condemned, count(*) filter (where off_grid)::int as off_grid, sum(value_cents) as value_cents
    from v_carcases where kill_date = $1 group by 1, 2 order by 1, 2`, [day]);
  out(flags, { date: day, grades: rows }, (d) => {
    heading(`Kill ${day} by category`);
    table(rows, [['species', 'Species'], ['category', 'Category'], ['head', 'Head', num0], ['avg_kg', 'Avg kg', kg], ['total_kg', 'Total kg', kg], ['avg_c', 'Avg c/kg', num0], ['condemned', 'Condemned', num0], ['off_grid', 'Off grid', num0], ['value_cents', 'Value', $]]);
  });
}

async function cmdTrace(db, { flags }) {
  const s = await settings(db);
  const rows = await db.query(`select kill_date, species, count(*)::int as head, count(*) filter (where tag_id is null)::int as untagged,
      round(extract(epoch from (localtimestamp - kill_date::timestamp)) / 3600.0)::int as hours_since_kill
    from carcases where trace_reported_at is null group by kill_date, species order by kill_date`);
  for (const r of rows) r.late = n(r.hours_since_kill) > s.trace_report_hours;
  const body = s.jurisdiction === 'NZ' ? 'NAIT' : 'NLIS';
  out(flags, { register: body, limit_hours: s.trace_report_hours, unreported: rows }, (d) => {
    heading(`Not yet reported to ${body} as slaughtered`);
    table(rows, [['kill_date', 'Kill date'], ['species', 'Species'], ['head', 'Head', num0], ['hours_since_kill', 'Hours since', num0], ['late', '', (v) => (v ? `LATE (limit ${s.trace_report_hours}h)` : '')]]);
    console.log(`\n  Upload the kill to ${body}, then record it: reported <kill date> [--species=] --ref=<upload reference> --actor=`);
  });
}

// ---------------------------------------------------------------- reads: money

async function cmdPreview(db, { args, flags }) {
  const { b, v, arrival } = await bookingFull(db, args[0]);
  const lines = await db.query('select * from settlement_preview($1)', [b.id]);
  const gross = lines.filter((l) => l.kind === 'carcases').reduce((t, l) => t + n(l.amount_cents), 0);
  const net = lines.reduce((t, l) => t + n(l.amount_cents), 0);
  const blockers = await settlementBlockers(db, b, v, arrival);
  out(flags, { booking: b.number, lines, gross_cents: gross, net_cents: net, blockers }, () => {
    heading(`Settlement test run ${b.number}: ${b.supplier_code} ${b.supplier_name}`);
    table(lines, [['description', 'Line'], ['head', 'Head', num0], ['kg', 'kg', kg], ['amount_cents', 'Amount', $]]);
    console.log(`\n  Net to the producer: ${$(net)}`);
    if (blockers.length) { console.log('\n  Cannot issue yet:'); for (const x of blockers) console.log(`  - ${x}`); }
    else console.log(`\n  Ready. Issue it with: settle ${b.number} --actor="Your name"`);
  });
}

async function settlementBlockers(db, b, v, arrival) {
  const [s] = await db.query('select * from suppliers where id = $1', [b.supplier_id]);
  const out2 = [];
  if (b.status === 'settled') out2.push('already settled');
  if (!['killed', 'arrived'].includes(b.status) && b.status !== 'settled') out2.push(`booking is ${b.status}`);
  if (!arrival) out2.push('no arrival recorded');
  else if (!arrival.declaration_received) out2.push('no vendor declaration on file');
  if (n(v.off_grid)) out2.push(`${v.off_grid} carcase(s) off grid`);
  if (arrival && n(v.unaccounted)) out2.push(`${v.unaccounted} head unaccounted for (received ${arrival.head_received}, killed ${v.killed}, dead on arrival ${arrival.dead_on_arrival})`);
  if (s.gst_registered && (!s.agreement_signed_on || (s.agreement_expires_on && s.agreement_expires_on < today()))) out2.push(`no buyer-created invoice agreement in date for ${s.code}`);
  if (s.status === 'hold') out2.push(`supplier on hold: ${s.hold_reason}`);
  return out2;
}

async function cmdSettlements(db, { flags }) {
  const params = [];
  let where = "st.issued_on >= current_date - 60";
  if (flags.status && flags.status !== true) { params.push(String(flags.status)); where += ` and st.status = $${params.length}`; }
  const rows = await db.query(`select st.number, st.kind, s.code as supplier_code, b.number as booking_no, b.kill_date, st.issued_on, st.due_on, st.gross_cents, st.gst_cents, st.deductions_cents, st.net_cents, st.status, st.paid_on, st.payment_ref
    from settlements st join suppliers s on s.id = st.supplier_id join bookings b on b.id = st.booking_id where ${where} order by st.issued_on desc, st.number`, params);
  out(flags, rows, (r) => {
    heading(`Settlements, last 60 days (${r.length})`);
    table(r, [['number', 'Settlement'], ['supplier_code', 'Supplier'], ['kill_date', 'Killed'], ['issued_on', 'Issued'], ['due_on', 'Due'], ['gross_cents', 'Gross', $], ['gst_cents', 'GST', $], ['deductions_cents', 'Deductions', $], ['net_cents', 'Net', $], ['status', 'Status'], ['paid_on', 'Paid']]);
  });
}

async function cmdSettlement(db, { args, flags }) {
  const st = await resolve(db, 'settlement', args[0]);
  const lines = await db.query('select sort, kind, description, head, kg, amount_cents from settlement_lines where settlement_id = $1 order by sort', [st.id]);
  out(flags, { settlement: st, lines }, () => {
    heading(`${st.number} (${st.kind}) to ${st.supplier_code} ${st.supplier_name}, booking ${st.booking_no} killed ${st.kill_date}`);
    console.log(`  Issued ${st.issued_on} by ${st.actor}, due ${st.due_on}. ${st.status === 'paid' ? `Paid ${st.paid_on} (${st.payment_ref || 'no reference'}).` : 'NOT PAID.'}`);
    table(lines, [['description', 'Line'], ['head', 'Head', num0], ['kg', 'kg', kg], ['amount_cents', 'Amount', $]]);
    console.log(`\n  Gross ${$(st.gross_cents)} + GST ${$(st.gst_cents)} - deductions ${$(st.deductions_cents)} = net ${$(st.net_cents)}`);
  });
}

async function cmdDue(db, { flags }) {
  const rows = await db.query('select * from v_settlements_open order by due_on, number');
  const unsettled = await db.query(`select number, supplier_code, kill_date, killed, value_cents, current_date - kill_date as days_since_kill
    from v_bookings where status = 'killed' order by kill_date`);
  out(flags, { open: rows, killed_not_settled: unsettled }, (d) => {
    heading(`Settlements to pay (${rows.length}, ${$(rows.reduce((t, r) => t + n(r.net_cents), 0))})`);
    table(rows, [['number', 'Settlement'], ['supplier_code', 'Supplier'], ['kill_date', 'Killed'], ['due_on', 'Due'], ['net_cents', 'Net', $], ['days_late', 'Days late', (v) => (n(v) > 0 ? `${v} LATE` : '')]]);
    heading(`Killed, not yet settled (${unsettled.length})`);
    table(unsettled, [['number', 'Booking'], ['supplier_code', 'Supplier'], ['kill_date', 'Killed'], ['killed', 'Head', num0], ['value_cents', 'Value so far', $], ['days_since_kill', 'Days since kill', num0]]);
  });
}

async function cmdPerformance(db, { flags }) {
  const s = await settings(db);
  const rows = await db.query('select * from v_supplier_performance where carcases > 0 order by code');
  for (const r of rows) r.flags = [n(r.condemned_pct) >= n(s.condemn_watch_pct) ? 'condemnations' : '', n(r.bruised_pct) >= n(s.bruise_watch_pct) ? 'bruising' : ''].filter(Boolean).join(', ');
  out(flags, rows, (r) => {
    heading('Supplier performance, last 90 days');
    table(r, [['code', 'Supplier'], ['carcases', 'Head', num0], ['avg_kg', 'Avg kg', kg], ['avg_cents_per_kg', 'Avg c/kg', num0], ['bruised_pct', 'Bruised', pct], ['dark_pct', 'Dark', pct], ['condemned_pct', 'Condemned', pct], ['deductions_cents', 'Discounts', $], ['value_cents', 'Value', $], ['flags', 'Raise with them']]);
    console.log(`\n  Watch levels: condemned ${s.condemn_watch_pct}%, bruised ${s.bruise_watch_pct}%.`);
  });
}

async function cmdPriceCheck(db, { flags }) {
  const sp = flags.species && flags.species !== true ? species(flags.species) : null;
  const rows = await db.query(`select supplier_code, species, count(*)::int as head, round(avg(hot_kg), 1) as avg_kg, round(avg(fat_score), 1) as avg_fat,
      round(avg(cents_per_kg), 0) as grid_c, round(sum(value_cents)::numeric / nullif(sum(hot_kg) filter (where not condemned), 0), 0) as paid_c,
      round(100.0 * sum(deduction_cents) / nullif(sum(value_cents + deduction_cents), 0), 1) as discount_pct,
      round(100.0 * count(*) filter (where teeth >= 4) / count(*), 1) as older_pct
    from v_carcases where kill_date >= current_date - 90 and ($1::text is null or species = $1) group by 1, 2 order by species, paid_c`, [sp]);
  out(flags, rows, (r) => {
    heading('What each supplier was paid per kilogram, last 90 days, and why');
    table(r, [['supplier_code', 'Supplier'], ['species', 'Species'], ['head', 'Head', num0], ['avg_kg', 'Avg kg', kg], ['avg_fat', 'Avg fat', (v) => String(v ?? '')], ['older_pct', '4+ teeth', pct], ['grid_c', 'Grid c/kg', num0], ['discount_pct', 'Discounts', pct], ['paid_c', 'Paid c/kg', num0]]);
  });
}

async function cmdYields(db, { flags }) {
  const weeks = n(flags.weeks) || 4;
  const rows = await db.query(`select date_trunc('week', run_on)::date as week, species, sum(carcase_kg) as carcase_kg, sum(saleable_kg) as saleable_kg, sum(cartons)::int as cartons,
      round(100.0 * sum(saleable_kg) / sum(carcase_kg), 1) as yield_pct
    from boning_runs where run_on >= current_date - ($1::int * 7) group by 1, 2 order by species, week`, [weeks]);
  const bySpecies = {};
  for (const r of rows) { const prev = bySpecies[r.species]; r.change = prev ? Math.round((n(r.yield_pct) - n(prev.yield_pct)) * 10) / 10 : null; bySpecies[r.species] = r; }
  out(flags, rows, (r) => {
    heading(`Boning yield by week, last ${weeks} weeks`);
    table(r, [['week', 'Week of'], ['species', 'Species'], ['carcase_kg', 'Carcase kg', kg], ['saleable_kg', 'Saleable kg', kg], ['cartons', 'Cartons', num0], ['yield_pct', 'Yield', pct],
      ['change', 'vs last week', (v) => (v === null ? '' : `${v > 0 ? '+' : ''}${v} pts${v <= -1.5 ? '  LOOK AT THIS' : ''}`)]]);
  });
}

async function cmdLevies(db, { flags }) {
  const rates = await db.query('select species, name, basis, rate, cap_cents_per_head, source, checked_on, active from levy_rates order by species, name');
  const collected = await db.query(`select to_char(st.issued_on, 'YYYY-MM') as month, b.species, sum(l.head)::int as head, -sum(l.amount_cents) as levy_cents
    from settlement_lines l join settlements st on st.id = l.settlement_id join bookings b on b.id = st.booking_id where l.kind = 'levy' group by 1, 2 order by 1, 2`);
  out(flags, { rates, collected }, () => {
    heading('Levy rates');
    table(rates, [['species', 'Species'], ['name', 'Levy'], ['basis', 'Basis'], ['rate', 'Rate', (v, r) => (r.basis === 'per_head' ? `${(n(v) / 100).toFixed(2)} a head` : `${Number(v)}%${r.cap_cents_per_head !== null ? `, max ${(n(r.cap_cents_per_head) / 100).toFixed(2)} a head` : ''}`)], ['checked_on', 'Checked']]);
    for (const r of rates) console.log(`  ${r.name}: ${r.source}`);
    heading('Levies deducted on settlements, by month (to be paid on)');
    table(collected, [['month', 'Month'], ['species', 'Species'], ['head', 'Head', num0], ['levy_cents', 'Levy', $]]);
  });
}

async function cmdHistory(db, { flags }) {
  const rows = await db.query('select at, actor, action, subject, detail from history order by id desc limit $1', [n(flags.limit) || 30]);
  out(flags, rows, (r) => { heading('History'); table(r, [['at', 'When', (v) => String(v instanceof Date ? v.toISOString() : v).slice(0, 16).replace('T', ' ')], ['actor', 'Who'], ['action', 'What'], ['subject', 'On'], ['detail', 'Detail', (v) => truncate(v ? JSON.stringify(v) : '', 60)]]); });
}

async function cmdCalendar(db, { flags }) {
  const days = n(flags.days) || 60;
  const rows = await db.query(`
    select agreement_expires_on as on_date, 'agreement ends' as what, code || ' ' || name as subject from suppliers where status <> 'closed' and gst_registered and agreement_expires_on between current_date - 30 and current_date + $1::int
    union all select quality_assurance_expires_on, 'quality assurance ends', code || ' ' || name from suppliers where status <> 'closed' and quality_assurance_expires_on between current_date - 30 and current_date + $1::int
    union all select due_on, 'settlement due', number || ' ' || supplier_code || ' ' || to_char(net_cents / 100.0, 'FM999,999,990.00') from v_settlements_open where due_on <= current_date + $1::int
    union all select kill_date, 'kill: ' || species, number || ' ' || supplier_code || ' ' || head_booked || ' head' from v_bookings where status = 'booked' and kill_date between current_date and current_date + least($1::int, 14)
    union all select checked_on + 365, 'levy rate due a check', name from levy_rates where active and checked_on + 365 <= current_date + $1::int
    order by 1`, [days]);
  out(flags, rows, (r) => { heading(`Calendar, next ${days} days`); table(r, [['on_date', 'Date'], ['what', 'What'], ['subject', 'Detail']]); });
}

// ---------------------------------------------------------------- compliance and attention

async function complianceFindings(db, s) {
  const body = s.jurisdiction === 'NZ' ? 'NAIT' : 'NLIS';
  const decl = s.jurisdiction === 'NZ' ? 'Animal Status Declaration' : 'National Vendor Declaration';
  const f = [];
  const add = (rule, level, subject, detail, source) => f.push({ rule, level, subject, detail, source });

  for (const r of await db.query(`select b.number, s.code from bookings b join arrivals a on a.booking_id = b.id join suppliers s on s.id = b.supplier_id where not a.declaration_received and b.status <> 'cancelled'`))
    add('declaration', 'breach', r.number, `${r.code}: livestock received with no ${decl} on file`, 'docs/compliance.md#1');
  for (const r of await db.query(`select b.number, s.code, b.status from bookings b join arrivals a on a.booking_id = b.id join suppliers s on s.id = b.supplier_id where not a.withholding_clear and b.status <> 'cancelled'`))
    add('withholding', 'breach', r.number, `${r.code}: declaration shows animals inside a withholding period or export slaughter interval (${r.status})`, 'docs/compliance.md#2');
  for (const r of await db.query(`select kill_date, species, count(*)::int as head, round(extract(epoch from (localtimestamp - kill_date::timestamp)) / 3600.0)::int as hours
      from carcases where trace_reported_at is null group by 1, 2`))
    if (n(r.hours) > s.trace_report_hours) add('trace-report', 'breach', `${r.kill_date} ${r.species}`, `${r.head} head killed ${r.hours} hours ago, not reported to ${body} (limit ${s.trace_report_hours} hours)`, 'docs/compliance.md#3');
    else add('trace-report', 'due', `${r.kill_date} ${r.species}`, `${r.head} head to report to ${body} within ${s.trace_report_hours - n(r.hours)} hours`, 'docs/compliance.md#3');
  for (const r of await db.query(`select code, name, agreement_expires_on, agreement_signed_on from suppliers where status <> 'closed' and gst_registered
      and (agreement_signed_on is null or agreement_expires_on < current_date + $1::int)`, [s.agreement_warn_days])) {
    const lapsed = !r.agreement_signed_on || r.agreement_expires_on < today();
    add('rcti-agreement', lapsed ? 'breach' : 'due', r.code, lapsed ? `${r.name}: no current buyer-created invoice agreement, so no settlement can be issued` : `${r.name}: agreement ends ${r.agreement_expires_on}`, 'docs/compliance.md#4');
  }
  for (const r of await db.query(`select number, supplier_code, current_date - kill_date as days from v_bookings where status = 'killed' and current_date - kill_date > 21`))
    add('rcti-28-days', n(r.days) > 28 ? 'breach' : 'due', r.number, `${r.supplier_code}: killed ${r.days} days ago and no settlement issued (the buyer-created invoice must reach the producer within 28 days)`, 'docs/compliance.md#5');
  for (const r of await db.query(`select code, name, quality_assurance_expires_on from suppliers where status <> 'closed' and (quality_assurance_no is null or quality_assurance_expires_on < current_date)`))
    add('quality-assurance', 'breach', r.code, `${r.name}: quality assurance accreditation ${r.quality_assurance_expires_on ? `ended ${r.quality_assurance_expires_on}` : 'not recorded'}`, 'docs/compliance.md#6');
  for (const r of await db.query(`select number, supplier_code, hours_in_yards from (${YARDS_SQL}) y where hours_in_yards > $1`, [s.lairage_max_hours]))
    add('lairage', 'breach', r.number, `${r.supplier_code}: ${r.hours_in_yards} hours in the yards (plant limit ${s.lairage_max_hours})`, 'docs/compliance.md#7');
  for (const r of await db.query(`select b.number, s.code, a.property_id_declared, s.property_id from bookings b join arrivals a on a.booking_id = b.id join suppliers s on s.id = b.supplier_id
      where a.property_id_declared is not null and s.property_id is not null and upper(a.property_id_declared) <> upper(s.property_id)`))
    add('property-id', 'breach', r.number, `${r.code}: declaration names property ${r.property_id_declared}, supplier record says ${r.property_id}`, 'docs/compliance.md#8');
  for (const r of await db.query(`select name, checked_on from levy_rates where active and checked_on < current_date - 365`))
    add('levy-rate', 'due', r.name, `rate last checked ${r.checked_on}: confirm it against the current schedule`, 'docs/compliance.md#9');
  const order = { breach: 0, due: 1 };
  return f.sort((a, b) => order[a.level] - order[b.level]);
}

const YARDS_SQL = `select b.number, s.code as supplier_code, round(extract(epoch from (localtimestamp - a.arrived_at)) / 3600.0, 1) as hours_in_yards
  from bookings b join arrivals a on a.booking_id = b.id join suppliers s on s.id = b.supplier_id
  where b.status = 'arrived'`;

async function cmdCompliance(db, { flags }) {
  const s = await settings(db);
  const f = await complianceFindings(db, s);
  out(flags, f, (r) => {
    heading(`Compliance: ${r.filter((x) => x.level === 'breach').length} breached, ${r.filter((x) => x.level === 'due').length} due soon`);
    table(r, [['level', 'Level'], ['rule', 'Rule'], ['subject', 'On'], ['detail', 'What', (v) => truncate(v, 100)], ['source', 'Source']]);
    console.log('\n  Rules and their sources: docs/compliance.md. Not legal advice.');
  });
}

async function attentionItems(db, s) {
  const items = [];
  const add = (level, subject, what, command) => items.push({ level, subject, what, command });
  for (const f of await complianceFindings(db, s)) {
    const cmd = { declaration: `declaration ${f.subject} --no=<number> --actor=`, withholding: `agenda`, 'trace-report': `reported ${f.subject.split(' ')[0]} --species=${f.subject.split(' ')[1] || ''} --ref= --actor=`,
      'rcti-agreement': `agreement ${f.subject} --signed= --expires= --actor=`, 'rcti-28-days': `preview ${f.subject}`, 'quality-assurance': `supplier ${f.subject}`, lairage: 'yards', 'property-id': `supplier ${f.subject}`, 'levy-rate': 'levies' }[f.rule];
    add(f.level === 'breach' ? 'breach' : 'action', f.subject, f.detail, cmd);
  }
  for (const r of await db.query('select * from v_settlements_open where days_late > 0 order by days_late desc'))
    add('breach', r.number, `${r.supplier_code}: ${$(r.net_cents)} due ${r.due_on}, ${r.days_late} days late (plant terms ${s.payment_days} days from kill)`, `pay ${r.number} --ref= --actor=`);
  for (const r of await db.query("select number from bookings where status = 'killed' order by kill_date, number")) {
    const { b, v, arrival } = await bookingFull(db, r.number);
    const blockers = await settlementBlockers(db, b, v, arrival);
    if (blockers.length) add('action', r.number, `Settlement held: ${blockers.join('; ')}`, `preview ${r.number}`);
    else add('action', r.number, 'Killed and ready to settle', `settle ${r.number} --actor=`);
  }
  for (const r of await db.query(`select c.booking_no, c.supplier_code, count(*)::int as head from v_carcases c where c.off_grid and c.booking_status <> 'settled' group by 1, 2`))
    add('action', r.booking_no, `${r.supplier_code}: ${r.head} carcase(s) off grid, agree a price`, 'off-grid');
  for (const r of await db.query(`select number, supplier_code, kill_date from v_bookings where status = 'killed' and kill_date <= current_date - $1::int`, [s.feedback_days]))
    add('info', r.number, `${r.supplier_code}: kill sheet due to the producer (killed ${r.kill_date}, plant aim ${s.feedback_days} days)`, `draft-letter ${r.supplier_code} --kind=feedback --booking=${r.number}`);
  for (const r of await db.query(`select kill_date, sum(head_booked) filter (where species = 'cattle')::int as cattle, sum(head_booked) filter (where species <> 'cattle')::int as small
      from bookings where status in ('booked', 'arrived') and kill_date >= current_date group by 1`))
    if (n(r.cattle) > s.cattle_per_day || n(r.small) > s.smallstock_per_day) add('action', r.kill_date, `Booked over capacity: ${n(r.cattle)} cattle (of ${s.cattle_per_day}), ${n(r.small)} smallstock (of ${s.smallstock_per_day})`, 'supply');
  for (const r of await db.query(`select b.number, s.code, s.status, s.hold_reason, s.gst_registered, s.agreement_signed_on, b.kill_date from bookings b join suppliers s on s.id = b.supplier_id
      where b.status = 'booked' and b.kill_date between current_date and current_date + 14 and (s.status <> 'active' or (s.gst_registered and s.agreement_signed_on is null))`))
    add('action', r.number, r.status !== 'active' ? `${r.code} is on hold (${r.hold_reason}) and booked to kill ${r.kill_date}` : `${r.code} is booked to kill ${r.kill_date} with no buyer-created invoice agreement: get one signed first`, `supplier ${r.code}`);
  for (const r of await db.query(`select * from v_supplier_performance where carcases > 0 and (bruised_pct >= $1 or condemned_pct >= $2)`, [s.bruise_watch_pct, s.condemn_watch_pct]))
    add('info', r.code, `${r.name}: ${pct(r.bruised_pct)} bruised, ${pct(r.condemned_pct)} condemned over 90 days`, `draft-letter ${r.code} --kind=bruising`);
  const y = await db.query(`with w as (select date_trunc('week', run_on)::date as week, species, 100.0 * sum(saleable_kg) / sum(carcase_kg) as y from boning_runs where run_on >= current_date - 28 group by 1, 2)
    select a.species, round(a.y, 1) as now_pct, round(b.y, 1) as before_pct from w a join w b on b.species = a.species and b.week = a.week - 7
    where a.week = (select max(week) from w w2 where w2.species = a.species) and a.y < b.y - 1.5`);
  for (const r of y) add('info', `${r.species} boning`, `Yield fell to ${r.now_pct}% from ${r.before_pct}% the week before`, 'yields');
  const order = { breach: 0, action: 1, info: 2 };
  return items.sort((a, b) => order[a.level] - order[b.level]);
}

async function cmdAttention(db, { flags }) {
  const s = await settings(db);
  const items = await attentionItems(db, s);
  out(flags, items, (r) => {
    heading(`Needs attention (${r.length})`);
    table(r, [['level', 'Level'], ['subject', 'On'], ['what', 'What', (v) => truncate(v, 110)], ['command', 'Next']]);
  });
}

// ---------------------------------------------------------------- writes: producers

async function cmdAddSupplier(db, { args, flags }) {
  const actor = actorOf(flags);
  const code = str(args[0]).toUpperCase();
  if (!/^[A-Z0-9-]{2,12}$/.test(code)) throw new CliError('Give a short supplier code, for example BRK.');
  if (!str(flags.name)) throw new CliError('Give the supplier name: --name="Brookvale Pastoral Co".');
  const agent = flags.agent && flags.agent !== true ? await resolve(db, 'agent', flags.agent) : null;
  const [row] = await tx(db, async () => {
    const r = await db.query(`insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, quality_assurance_expires_on, bank_last4, agent_id, region, contact_name, email, phone)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
      [code, str(flags.name), str(flags.abn) || str(flags.nzbn) || null, !flags['no-gst'], str(flags.property) || null, str(flags.qa) || null, parseDate(flags['qa-expires']),
       str(flags.bank4) || null, agent?.id || null, str(flags.region) || null, str(flags.contact) || null, str(flags.email) || null, str(flags.phone) || null]);
    await record(db, actor, 'add supplier', code);
    return r;
  });
  out(flags, row, (r) => console.log(`Added ${r.code} ${r.name}.${r.gst_registered ? ' Record the buyer-created invoice agreement before the first settlement: agreement ' + r.code + ' --signed= --expires=' : ''}`));
}

async function cmdAgreement(db, { args, flags }) {
  const actor = actorOf(flags);
  const s = await resolve(db, 'supplier', args[0]);
  const signed = parseDate(flags.signed) || today();
  const expires = parseDate(flags.expires);
  await tx(db, async () => {
    await db.query('update suppliers set agreement_signed_on = $2, agreement_expires_on = $3 where id = $1', [s.id, signed, expires]);
    await record(db, actor, 'buyer-created invoice agreement', s.code, { signed, expires });
  });
  out(flags, { code: s.code, signed, expires }, () => console.log(`${s.code}: agreement signed ${signed}${expires ? `, ends ${expires}` : ', no end date'}.`));
}

async function cmdQa(db, { args, flags }) {
  const actor = actorOf(flags);
  const s = await resolve(db, 'supplier', args[0]);
  const no = str(flags.no) || s.quality_assurance_no;
  const expires = parseDate(flags.expires);
  if (!no || !expires) throw new CliError('Give the accreditation number and end date: --no="LPA 3301245" --expires=2027-10-01');
  await tx(db, async () => {
    await db.query('update suppliers set quality_assurance_no = $2, quality_assurance_expires_on = $3 where id = $1', [s.id, no, expires]);
    await record(db, actor, 'quality assurance', s.code, { no, expires });
  });
  out(flags, { code: s.code, no, expires }, () => console.log(`${s.code}: ${no}, ends ${expires}.`));
}

async function cmdSupplierStatus(db, { args, flags }) {
  const actor = actorOf(flags);
  const s = await resolve(db, 'supplier', args[0]);
  const status = str(args[1]);
  if (!['active', 'hold', 'closed'].includes(status)) throw new CliError('Status is active, hold or closed.');
  if (status === 'hold' && !str(flags.reason)) throw new CliError('A hold needs a reason: --reason="..."');
  await tx(db, async () => {
    await db.query('update suppliers set status = $2, hold_reason = $3 where id = $1', [s.id, status, status === 'hold' ? str(flags.reason) : null]);
    await record(db, actor, `supplier ${status}`, s.code, { reason: str(flags.reason) || null });
  });
  out(flags, { code: s.code, status }, () => console.log(`${s.code} is now ${status}.`));
}

async function cmdAddAgent(db, { args, flags }) {
  const actor = actorOf(flags);
  const name = args.join(' ');
  if (!name) throw new CliError('Name the agent.');
  const cents = flags.commission ? parseMoney(flags.commission, 'commission per head') : 0;
  const [row] = await tx(db, async () => {
    const r = await db.query('insert into agents (name, company, commission_cents_per_head, email) values ($1, $2, $3, $4) returning *', [name, str(flags.company) || null, cents, str(flags.email) || null]);
    await record(db, actor, 'add agent', name);
    return r;
  });
  out(flags, row, (r) => console.log(`Added agent ${r.name}, ${$(r.commission_cents_per_head)} a head.`));
}

// ---------------------------------------------------------------- writes: bookings, arrivals, the kill

async function cmdBook(db, { args, flags }) {
  const actor = actorOf(flags);
  const s = await resolve(db, 'supplier', args[0]);
  const sp = species(args[2] || flags.species);
  const head = parseInt0(args[1] || flags.head, 'head');
  if (!head) throw new CliError('Book at least one head.');
  const day = parseDate(flags.date || flags.kill);
  if (!day) throw new CliError('Give the kill date: --date=YYYY-MM-DD');
  const grid = flags.grid && flags.grid !== true ? await resolve(db, 'grid', flags.grid)
    : (await db.query('select * from grids where species = $1 and valid_from <= $2 and (valid_to is null or valid_to >= $2) order by valid_from desc limit 1', [sp, day]))[0];
  if (!grid) throw new CliError(`No ${sp} grid is valid on ${day}. Name one with --grid=.`);
  const agentId = flags.agent && flags.agent !== true ? (await resolve(db, 'agent', flags.agent)).id : s.agent_id;
  const st = await settings(db);
  const [{ booked }] = await db.query(`select coalesce(sum(head_booked), 0)::int as booked from bookings where kill_date = $1 and status in ('booked', 'arrived') and ${sp === 'cattle' ? "species = 'cattle'" : "species <> 'cattle'"}`, [day]);
  const cap = sp === 'cattle' ? st.cattle_per_day : st.smallstock_per_day;
  const number = str(flags.number) || `B${(await db.query("select coalesce(max(nullif(regexp_replace(number, '[^0-9]', '', 'g'), '')::int), 1000) + 1 as next from bookings"))[0].next}`;
  const [row] = await tx(db, async () => {
    const r = await db.query(`insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id, freight_cents, carrier, notes)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [number, s.id, agentId, sp, head, day, grid.id, flags.freight ? parseMoney(flags.freight, 'freight') : 0, str(flags.carrier) || null, str(flags.notes) || null]);
    await record(db, actor, 'book', number, { supplier: s.code, head, species: sp, kill_date: day, grid: grid.code });
    return r;
  });
  const over = booked + head > cap;
  out(flags, { ...row, grid_code: grid.code, day_total: booked + head, capacity: cap, over_capacity: over }, (r) =>
    console.log(`Booked ${r.number}: ${s.code} ${head} ${sp} on ${day}, grid ${grid.code}. Day total ${booked + head} of ${cap}${over ? ' (OVER CAPACITY)' : ''}.`));
}

async function cmdCancel(db, { args, flags }) {
  const actor = actorOf(flags);
  const b = await resolve(db, 'booking', args[0]);
  if (!str(flags.reason)) throw new CliError('Say why: --reason="..."');
  if (b.status !== 'booked') throw new CliError(`${b.number} is ${b.status}: only a booking whose stock has not arrived can be cancelled.`);
  await tx(db, async () => {
    await db.query("update bookings set status = 'cancelled', cancelled_reason = $2 where id = $1", [b.id, str(flags.reason)]);
    await record(db, actor, 'cancel', b.number, { reason: str(flags.reason) });
  });
  out(flags, { number: b.number, status: 'cancelled' }, () => console.log(`${b.number} cancelled.`));
}

async function cmdArrive(db, { args, flags }) {
  const actor = actorOf(flags);
  const b = await resolve(db, 'booking', args[0]);
  if (b.status !== 'booked') throw new CliError(`${b.number} is ${b.status}: its arrival is already recorded or it is closed.`);
  const head = parseInt0(flags.head ?? b.head_booked, 'head');
  const doa = parseInt0(flags.doa ?? 0, 'dead on arrival');
  const declNo = str(flags.declaration) || null;
  const clear = !flags['not-clear'];
  const [s] = await db.query('select property_id from suppliers where id = $1', [b.supplier_id]);
  await tx(db, async () => {
    await db.query(`insert into arrivals (booking_id, arrived_at, head_received, dead_on_arrival, declaration_no, declaration_received, withholding_clear, hgp_free, property_id_declared, lame_or_injured, pen, last_fed_at, notes, actor)
      values ($1, coalesce($2::timestamp, localtimestamp(0)), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [b.id, parseTimestamp(flags.at), head, doa, declNo, Boolean(declNo), clear, flags.hgp === undefined ? null : yesNo(flags.hgp), str(flags.property) || s.property_id,
       parseInt0(flags.lame ?? 0, 'lame or injured'), str(flags.pen) || null, parseTimestamp(flags['last-fed']), str(flags.notes) || null, actor]);
    await db.query("update bookings set status = 'arrived' where id = $1", [b.id]);
    await record(db, actor, 'arrive', b.number, { head, doa, declaration: declNo, withholding_clear: clear });
  });
  const warn = [];
  if (!declNo) warn.push('NO DECLARATION: do not kill until it is on file');
  if (!clear) warn.push('WITHHOLDING NOT CLEAR: hold these animals');
  if (head !== b.head_booked) warn.push(`${head} arrived against ${b.head_booked} booked`);
  out(flags, { number: b.number, head, doa, warnings: warn }, () => console.log(`${b.number}: ${head} head received, ${doa} dead on arrival.${warn.length ? '\n  ' + warn.join('\n  ') : ''}`));
}

async function cmdDeclaration(db, { args, flags }) {
  const actor = actorOf(flags);
  const b = await resolve(db, 'booking', args[0]);
  const no = str(flags.no);
  if (!no) throw new CliError('Give the declaration number: --no="NVD 5513520".');
  const [a] = await db.query('select * from arrivals where booking_id = $1', [b.id]);
  if (!a) throw new CliError(`${b.number} has no arrival recorded.`);
  await tx(db, async () => {
    await db.query('update arrivals set declaration_no = $2, declaration_received = true, withholding_clear = $3 where booking_id = $1', [b.id, no, flags['not-clear'] ? false : flags.clear ? true : a.withholding_clear]);
    await record(db, actor, 'declaration received', b.number, { no });
  });
  out(flags, { number: b.number, declaration_no: no }, () => console.log(`${b.number}: declaration ${no} on file.`));
}

async function readKillFile(file, b) {
  if (!existsSync(file)) throw new CliError(`No file at ${file}.`);
  const rows = parseCsv(readFileSync(file, 'utf8'));
  if (!rows.length) throw new CliError('The kill file is empty.');
  return rows.map((r, i) => {
    const where = `row ${i + 2}`;
    const body = Number(pick(r, 'Body', 'Body No', 'Body Number', 'Carcase No', 'Carcass No', 'Kill No'));
    if (!Number.isInteger(body) || body <= 0) throw new CliError(`${where}: no body number.`);
    const w = pick(r, 'HSCW', 'Hot Weight', 'Hot Std Carcase Weight', 'Carcase Weight', 'Carcass Weight', 'Weight', 'kg');
    if (w === '') throw new CliError(`${where}: no carcase weight.`);
    const condemned = yesNo(pick(r, 'Condemned', 'Condemn'));
    return {
      body_no: body,
      tag_id: pick(r, 'Tag', 'NLIS', 'NAIT', 'EID', 'RFID', 'Tag ID') || null,
      category: (pick(r, 'Category', 'Class', 'Grade', 'Sex') || (b.species === 'cattle' ? 'STEER' : b.species === 'sheep' ? 'MUTTON' : 'LAMB')).toUpperCase(),
      hot_kg: parseKg(w),
      fat_score: pick(r, 'Fat', 'Fat Score', 'P8', 'GR') === '' ? null : Number(pick(r, 'Fat', 'Fat Score', 'P8', 'GR')),
      teeth: Number(pick(r, 'Teeth', 'Dentition', 'Dent') || 0),
      bruise_score: Number(pick(r, 'Bruise', 'Bruise Score', 'Bruising') || 0),
      dark_cutter: yesNo(pick(r, 'Dark Cutter', 'Dark', 'DC')),
      condemned,
      condemn_reason: condemned ? pick(r, 'Reason', 'Condemn Reason', 'Condemnation') || 'Condemned by inspection' : null,
    };
  });
}

async function cmdKill(db, { args, flags }) {
  const b = await resolve(db, 'booking', args[0]);
  const file = path.resolve(str(args[1]));
  if (!['arrived', 'killed'].includes(b.status)) throw new CliError(`${b.number} is ${b.status}: record the arrival first.`);
  const [a] = await db.query('select * from arrivals where booking_id = $1', [b.id]);
  const lines = await readKillFile(file, b);
  const day = parseDate(flags.date) || b.kill_date;
  const dup = await db.query('select body_no from carcases where kill_date = $1 and species = $2 and body_no = any($3::int[])', [day, b.species, lines.map((l) => l.body_no)]);
  if (dup.length) throw new CliError(`Body numbers already on the ${day} ${b.species} kill: ${dup.map((d) => d.body_no).join(', ')}. Nothing written.`);
  const seen = new Set();
  for (const l of lines) { if (seen.has(l.body_no)) throw new CliError(`Body ${l.body_no} appears twice in the file. Nothing written.`); seen.add(l.body_no); }
  const [{ already }] = await db.query('select count(*)::int as already from carcases where booking_id = $1', [b.id]);
  const room = a.head_received - a.dead_on_arrival - already;
  if (lines.length > room) throw new CliError(`${lines.length} carcases in the file but only ${room} head of ${b.number} left to kill. Nothing written.`);
  const summary = { booking: b.number, kill_date: day, carcases: lines.length, kg: Math.round(lines.reduce((t, l) => t + l.hot_kg, 0) * 10) / 10, condemned: lines.filter((l) => l.condemned).length };
  if (flags['dry-run']) {
    out(flags, { dry_run: true, ...summary }, (d) => console.log(`Test run: ${d.carcases} carcases, ${kg(d.kg)} kg, ${d.condemned} condemned, onto ${b.number}. Nothing written.`));
    return;
  }
  const actor = actorOf(flags);
  await tx(db, async () => {
    for (const l of lines) {
      await db.query(`insert into carcases (booking_id, kill_date, body_no, species, category, tag_id, hot_kg, fat_score, teeth, bruise_score, dark_cutter, condemned, condemn_reason)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [b.id, day, l.body_no, b.species, l.category, l.tag_id, l.hot_kg, l.fat_score, l.teeth, l.bruise_score, l.dark_cutter, l.condemned, l.condemn_reason]);
    }
    await db.query("update bookings set status = 'killed' where id = $1", [b.id]);
    await record(db, actor, 'kill file', b.number, summary);
  });
  const [v] = await db.query('select killed, off_grid, unaccounted, value_cents from v_bookings where id = $1', [b.id]);
  out(flags, { ...summary, ...v }, (d) => console.log(`${b.number}: ${d.carcases} carcases recorded, ${d.off_grid} off grid, ${d.unaccounted} head still to account for. Value ${$(d.value_cents)}.`));
}

async function cmdCondemn(db, { args, flags }) {
  const actor = actorOf(flags);
  const b = await resolve(db, 'booking', args[0]);
  const body = parseInt0(args[1], 'body number');
  if (!str(flags.reason)) throw new CliError('Give the inspector\'s reason: --reason="..."');
  const res = await tx(db, async () => {
    const r = await db.query('update carcases set condemned = true, condemn_reason = $3 where booking_id = $1 and body_no = $2 returning body_no', [b.id, body, str(flags.reason)]);
    if (!r.length) throw new CliError(`No body ${body} on ${b.number}.`);
    await record(db, actor, 'condemn', `${b.number} body ${body}`, { reason: str(flags.reason) });
    return r;
  });
  out(flags, { booking: b.number, body: res[0].body_no, condemned: true }, () => console.log(`${b.number} body ${body} condemned: not paid.`));
}

async function cmdRegrade(db, { args, flags }) {
  const actor = actorOf(flags);
  const b = await resolve(db, 'booking', args[0]);
  const body = parseInt0(args[1], 'body number');
  const sets = []; const params = [b.id, body]; const changed = {};
  const put = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); changed[col] = v; };
  if (flags.kg !== undefined) put('hot_kg', parseKg(flags.kg));
  if (flags.fat !== undefined) put('fat_score', parseInt0(flags.fat, 'fat score'));
  if (flags.teeth !== undefined) put('teeth', parseInt0(flags.teeth, 'teeth'));
  if (flags.bruise !== undefined) put('bruise_score', parseInt0(flags.bruise, 'bruise score'));
  if (flags.category !== undefined) put('category', str(flags.category).toUpperCase());
  if (flags.dark !== undefined) put('dark_cutter', flags.dark === true ? true : yesNo(flags.dark));
  if (!sets.length) throw new CliError('Say what changed: --kg= --fat= --teeth= --bruise= --category= --dark=');
  if (!str(flags.reason)) throw new CliError('Say why: --reason="scale reading corrected by QA"');
  const [row] = await tx(db, async () => {
    const r = await db.query(`update carcases set ${sets.join(', ')} where booking_id = $1 and body_no = $2 returning body_no, cents_per_kg, value_cents`, params);
    if (!r.length) throw new CliError(`No body ${body} on ${b.number}.`);
    await record(db, actor, 'regrade', `${b.number} body ${body}`, { ...changed, reason: str(flags.reason) });
    return r;
  });
  out(flags, { booking: b.number, ...row }, (r) => console.log(`${b.number} body ${body}: ${ckg(r.cents_per_kg)}, ${$(r.value_cents)}.`));
}

async function cmdReported(db, { args, flags }) {
  const actor = actorOf(flags);
  const day = parseDate(args[0]);
  if (!day) throw new CliError('Give the kill date that was reported.');
  const ref = str(flags.ref);
  if (!ref) throw new CliError('Give the upload reference from NLIS or NAIT: --ref=');
  const sp = flags.species && flags.species !== true ? species(flags.species) : null;
  const rows = await tx(db, async () => {
    const r = await db.query('update carcases set trace_reported_at = localtimestamp(0) where kill_date = $1 and trace_reported_at is null and ($2::text is null or species = $2) returning id', [day, sp]);
    await record(db, actor, 'traceability reported', `${day}${sp ? ' ' + sp : ''}`, { ref, head: r.length });
    return r;
  });
  out(flags, { kill_date: day, species: sp, head: rows.length, ref }, (d) => console.log(`${d.head} head from ${day} recorded as reported (${ref}).`));
}

// ---------------------------------------------------------------- writes: money

async function cmdSettle(db, { args, flags }) {
  if (flags['dry-run']) return cmdPreview(db, { args, flags });
  const actor = actorOf(flags);
  const b = await resolve(db, 'booking', args[0]);
  const [s] = await db.query('select status, hold_reason, code from suppliers where id = $1', [b.supplier_id]);
  if (s.status === 'hold') throw new CliError(`${s.code} is on hold (${s.hold_reason}). Clear the hold before settling.`);
  const issued = parseDate(flags.on) || today();
  await tx(db, () => db.query('select issue_settlement($1, $2, $3)', [b.id, issued, actor]));
  return cmdSettlement(db, { args: [b.number], flags });
}

async function cmdPay(db, { args, flags }) {
  const actor = actorOf(flags);
  const st = await resolve(db, 'settlement', args[0]);
  if (st.status === 'paid') throw new CliError(`${st.number} was already paid on ${st.paid_on}.`);
  const [s] = await db.query('select status, hold_reason from suppliers where id = $1', [st.supplier_id]);
  if (s.status === 'hold') throw new CliError(`${st.supplier_code} is on hold (${s.hold_reason}). Do not pay until it is cleared.`);
  const on = parseDate(flags.on) || today();
  await tx(db, async () => {
    await db.query("update settlements set status = 'paid', paid_on = $2, payment_ref = $3 where id = $1", [st.id, on, str(flags.ref) || null]);
    await record(db, actor, 'paid', st.number, { on, ref: str(flags.ref) || null, net_cents: st.net_cents });
  });
  out(flags, { number: st.number, paid_on: on }, () => console.log(`${st.number}: ${$(st.net_cents)} recorded as paid ${on}.`));
}

async function cmdAdjust(db, { args, flags }) {
  const actor = actorOf(flags);
  const st = await resolve(db, 'settlement', args[0]);
  const amount = parseMoney(args[1], 'adjustment');
  if (!str(flags.reason)) throw new CliError('Say why: --reason="price agreed for body 409"');
  const [{ count }] = await db.query('select count(*)::int as count from settlements where adjusts_id = $1', [st.id]);
  const [cfg] = await db.query('select gst_pct from settings');
  const [sup] = await db.query('select gst_registered from suppliers where id = $1', [st.supplier_id]);
  const gst = sup.gst_registered && !flags['no-gst'] ? Math.round(amount * n(cfg.gst_pct) / 100) : 0;
  const number = `${st.number}-A${count + 1}`;
  await tx(db, async () => {
    const [row] = await db.query(`insert into settlements (number, kind, supplier_id, booking_id, adjusts_id, issued_on, due_on, gross_cents, gst_cents, deductions_cents, net_cents, actor)
      values ($1, 'adjustment', $2, $3, $4, current_date, current_date + 7, $5, $6, 0, $7, $8) returning id`, [number, st.supplier_id, st.booking_id, st.id, amount, gst, amount + gst, actor]);
    await db.query("insert into settlement_lines (settlement_id, sort, kind, description, amount_cents) values ($1, 1, 'adjustment', $2, $3)", [row.id, str(flags.reason), amount]);
    if (gst) await db.query("insert into settlement_lines (settlement_id, sort, kind, description, amount_cents) values ($1, 2, 'gst', 'GST on the adjustment', $2)", [row.id, gst]);
    await record(db, actor, 'adjustment', number, { amount_cents: amount, gst_cents: gst, reason: str(flags.reason) });
  });
  out(flags, { number, adjusts: st.number, amount_cents: amount, gst_cents: gst, net_cents: amount + gst }, (d) => console.log(`${number} issued against ${st.number}: ${$(d.net_cents)} including GST ${$(gst)}.`));
}

async function cmdBoning(db, { flags }) {
  const actor = actorOf(flags);
  const sp = species(flags.species);
  const row = {
    run_on: parseDate(flags.date) || today(), species: sp, category: str(flags.category).toUpperCase() || null,
    carcase_kg: parseKg(flags.in, 'carcase weight in'), saleable_kg: parseKg(flags.out, 'saleable weight out'), fat_bone_kg: flags['fat-bone'] ? parseKg(flags['fat-bone']) : 0, cartons: parseInt0(flags.cartons ?? 0, 'cartons'),
  };
  const [r] = await tx(db, async () => {
    const x = await db.query(`insert into boning_runs (run_on, species, category, carcase_kg, saleable_kg, fat_bone_kg, cartons, notes, actor) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      returning round(100.0 * saleable_kg / carcase_kg, 1) as yield_pct`, [row.run_on, sp, row.category, row.carcase_kg, row.saleable_kg, row.fat_bone_kg, row.cartons, str(flags.notes) || null, actor]);
    await record(db, actor, 'boning run', `${row.run_on} ${sp}`, row);
    return x;
  });
  out(flags, { ...row, yield_pct: r.yield_pct }, (d) => console.log(`Boning ${d.run_on} ${sp}: ${kg(d.carcase_kg)} kg in, ${kg(d.saleable_kg)} kg saleable, yield ${pct(d.yield_pct)}.`));
}

async function cmdLog(db, { args, flags }) {
  const actor = actorOf(flags);
  const ref = args[0];
  const body = args.slice(1).join(' ');
  if (!body) throw new CliError('Write the note: log <supplier|booking> "what happened"');
  let supplierId = null; let bookingId = null; let label;
  try { const b = await resolve(db, 'booking', ref); bookingId = b.id; supplierId = b.supplier_id; label = b.number; }
  catch { const s = await resolve(db, 'supplier', ref); supplierId = s.id; label = s.code; }
  await db.query('insert into notes (supplier_id, booking_id, body, actor) values ($1, $2, $3, $4)', [supplierId, bookingId, body, actor]);
  out(flags, { on: label, body }, () => console.log(`Noted on ${label}.`));
}

// ---------------------------------------------------------------- letters

async function cmdDraftLetter(db, { args, flags }) {
  const st = await settings(db);
  const s = await resolve(db, 'supplier', args[0]);
  const kind = str(flags.kind);
  const kinds = ['feedback', 'agreement', 'declaration', 'payment', 'bruising'];
  if (!kinds.includes(kind)) throw new CliError(`--kind is one of ${kinds.join(', ')}.`);
  const who = s.contact_name ? s.contact_name.split(' ')[0] : s.name;
  let subject; let bodyText;
  if (kind === 'feedback') {
    const b = flags.booking ? await resolve(db, 'booking', flags.booking) : (await db.query("select * from bookings where supplier_id = $1 and status in ('killed', 'settled') order by kill_date desc limit 1", [s.id]))[0];
    if (!b) throw new CliError(`${s.code} has no killed booking.`);
    const grades = await db.query(`select coalesce(grid_category, category) as category, count(*)::int as head, round(avg(hot_kg), 1) as avg_kg, round(avg(cents_per_kg), 0) as avg_c, sum(value_cents) as value_cents,
        count(*) filter (where bruise_score >= 2)::int as bruised, count(*) filter (where condemned)::int as condemned, count(*) filter (where off_grid)::int as off_grid
      from v_carcases where booking_id = $1 group by 1 order by 1`, [b.id]);
    subject = `Kill sheet for booking ${b.number}, killed ${b.kill_date}`;
    bodyText = [`Hi ${who},`, '', `Here is the kill sheet for your ${b.species} killed on ${b.kill_date} (booking ${b.number}).`, '',
      ...grades.map((g) => `- ${g.category}: ${g.head} head, average ${g.avg_kg} kg at ${g.avg_c ?? '-'} c/kg, ${$(g.value_cents)}${g.bruised ? `, ${g.bruised} bruised` : ''}${g.condemned ? `, ${g.condemned} condemned` : ''}${g.off_grid ? `, ${g.off_grid} off grid (price to be agreed)` : ''}`),
      '', 'The full carcase-by-carcase sheet is attached. Your settlement follows separately.', '', `${st.plant_name}`];
  } else if (kind === 'agreement') {
    subject = 'Buyer-created tax invoice agreement';
    bodyText = [`Hi ${who},`, '', `Our agreement that ${st.plant_name} issues the tax invoices for the livestock you supply us ${s.agreement_expires_on ? `ends on ${s.agreement_expires_on}` : 'is not on file'}. We need a current one before we can issue your next settlement.`, '',
      'The new agreement is attached. Please sign and return it.', '', `${st.plant_name}`];
  } else if (kind === 'declaration') {
    const b = flags.booking ? await resolve(db, 'booking', flags.booking) : (await db.query('select b.* from bookings b join arrivals a on a.booking_id = b.id where b.supplier_id = $1 and not a.declaration_received order by b.kill_date desc limit 1', [s.id]))[0];
    if (!b) throw new CliError(`${s.code} has no consignment missing its declaration.`);
    const decl = st.jurisdiction === 'NZ' ? 'Animal Status Declaration' : 'National Vendor Declaration';
    subject = `${decl} for booking ${b.number}`;
    bodyText = [`Hi ${who},`, '', `We have your ${b.species} from booking ${b.number} (kill date ${b.kill_date}) but no ${decl} for the consignment. Please send a copy today. We cannot settle the consignment until it is on file.`, '', `${st.plant_name}`];
  } else if (kind === 'payment') {
    const open = await db.query('select number, due_on, net_cents from v_settlements_open where supplier_code = $1 order by due_on', [s.code]);
    if (!open.length) throw new CliError(`${s.code} has no unpaid settlement.`);
    subject = 'Your settlement payment';
    bodyText = [`Hi ${who},`, '', ...open.map((o) => `Settlement ${o.number} for ${$(o.net_cents)} is being paid to your account ending ${s.bank_last4 || '----'}.`), '', `${st.plant_name}`];
  } else {
    const [p] = await db.query('select * from v_supplier_performance where supplier_id = $1', [s.id]);
    subject = 'Bruising and condemnations on your recent cattle';
    bodyText = [`Hi ${who},`, '', `Over the last 90 days ${p.carcases} of your carcases came through: ${pct(p.bruised_pct)} were bruised enough to be discounted, ${pct(p.dark_pct)} were dark cutters and ${pct(p.condemned_pct)} were condemned. Together that took ${$(p.deductions_cents)} off your payments.`, '',
      'Happy to walk through the kill sheets with you, and to look at loading and trucking for the next consignment.', '', `${st.plant_name}`];
  }
  const dir = path.join(REPO_ROOT, 'drafts');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${today()}-${s.code.toLowerCase()}-${kind}.md`);
  writeFileSync(file, `To: ${s.email || '(no email on file)'}\nSubject: ${subject}\n\n${bodyText.join('\n')}\n`);
  out(flags, { file, to: s.email, subject }, (d) => console.log(`Draft written to ${path.relative(REPO_ROOT, d.file)}. Nothing has been sent.`));
}

// ---------------------------------------------------------------- import and export

async function cmdImport(db, { args, flags }) {
  if (str(args[0]).toLowerCase() !== 'meatpro') throw new CliError('Usage: import meatpro <folder> [--dry-run] --actor=');
  const dir = path.resolve(str(args[1]));
  const f = (name) => path.join(dir, name);
  if (!existsSync(f('suppliers.csv'))) throw new CliError(`${dir} needs suppliers.csv (and optionally grids.csv and bookings.csv). See docs/replace-meatpro.md.`);
  const read = (name) => (existsSync(f(name)) ? parseCsv(readFileSync(f(name), 'utf8')) : []);
  const sup = read('suppliers.csv').map((r, i) => {
    const code = (pick(r, 'No.', 'No', 'Vendor No.', 'Vendor No', 'Supplier Code', 'Code') || '').toUpperCase();
    const name = pick(r, 'Name', 'Vendor Name', 'Supplier Name');
    if (!code || !name) throw new CliError(`suppliers.csv row ${i + 2}: needs a code (No.) and a Name.`);
    const gstReg = pick(r, 'GST Registered', 'Registered for GST', 'GST Reg');
    return { code, name, business_number: pick(r, 'ABN', 'NZBN', 'VAT Registration No.', 'Business Number') || null, gst_registered: gstReg === '' ? true : yesNo(gstReg),
      property_id: pick(r, 'PIC', 'Property Identification Code', 'NAIT Number', 'NAIT Location') || null, quality_assurance_no: pick(r, 'LPA', 'LPA Number', 'QA Number') || null,
      agreement_signed_on: parseDate(pick(r, 'RCTI Agreement Date', 'RCTI Signed', 'Agreement Signed')), agreement_expires_on: parseDate(pick(r, 'RCTI Expiry', 'RCTI Agreement Expiry', 'Agreement Expires')),
      region: pick(r, 'City', 'Region', 'Town') || null, contact_name: pick(r, 'Contact', 'Contact Name') || null, email: pick(r, 'E-Mail', 'Email') || null, phone: pick(r, 'Phone No.', 'Phone') || null,
      bank_last4: (pick(r, 'Bank Account No.', 'Bank Account') || '').replace(/\D/g, '').slice(-4) || null };
  });
  const gridRows = read('grids.csv').map((r, i) => {
    const code = (pick(r, 'Grid Code', 'Schedule Code', 'Price Schedule', 'Grid') || '').toUpperCase();
    const sp = species(pick(r, 'Species') || 'cattle');
    const c = Number(String(pick(r, 'Price c/kg', 'Cents per kg', 'c/kg', 'Price')).replace(/[^0-9.]/g, ''));
    if (!code || !Number.isFinite(c) || c <= 0) throw new CliError(`grids.csv row ${i + 2}: needs a Grid Code and a Price c/kg.`);
    return { code, species: sp, valid_from: parseDate(pick(r, 'Valid From', 'Starting Date', 'From')) || today(), category: (pick(r, 'Category', 'Class') || 'ALL').toUpperCase(),
      min_kg: Number(pick(r, 'Min Weight', 'Min kg', 'Weight From') || 0), max_kg: Number(pick(r, 'Max Weight', 'Max kg', 'Weight To') || 9999),
      min_fat: Number(pick(r, 'Min Fat', 'Fat From') || 0), max_fat: Number(pick(r, 'Max Fat', 'Fat To') || 99), max_teeth: Number(pick(r, 'Max Teeth', 'Dentition') || 8), cents_per_kg: Math.round(c) };
  });
  const bookRows = read('bookings.csv').map((r, i) => {
    const number = pick(r, 'Booking No.', 'Booking No', 'Booking', 'No.');
    const code = (pick(r, 'Vendor No.', 'Vendor No', 'Supplier Code', 'Supplier') || '').toUpperCase();
    const head = Number(pick(r, 'Head', 'Quantity', 'Head Booked'));
    const day = parseDate(pick(r, 'Kill Date', 'Slaughter Date', 'Date'));
    if (!number || !code || !Number.isInteger(head) || head <= 0 || !day) throw new CliError(`bookings.csv row ${i + 2}: needs Booking No., Vendor No., Head and Kill Date.`);
    return { number, code, species: species(pick(r, 'Species') || 'cattle'), head, kill_date: day, grid: (pick(r, 'Grid Code', 'Price Schedule', 'Grid') || '').toUpperCase() || null };
  });
  const existing = await db.query('select code from suppliers where code = any($1::text[])', [sup.map((s) => s.code)]);
  if (existing.length) throw new CliError(`Already here: ${existing.map((x) => x.code).join(', ')}. Nothing written.`);
  const codes = new Set(sup.map((s) => s.code));
  for (const b of bookRows) if (!codes.has(b.code) && !(await db.query('select 1 from suppliers where code = $1', [b.code])).length) throw new CliError(`bookings.csv: booking ${b.number} names supplier ${b.code}, which is in neither suppliers.csv nor this database. Nothing written.`);
  const grids = [...new Set(gridRows.map((g) => g.code))];
  const summary = { suppliers: sup.length, without_agreement: sup.filter((s) => s.gst_registered && !s.agreement_signed_on).length, grids: grids.length, grid_lines: gridRows.length, bookings: bookRows.length, head_booked: bookRows.reduce((t, b) => t + b.head, 0) };
  if (flags['dry-run']) { out(flags, { dry_run: true, ...summary }, (d) => console.log(`Test run: ${d.suppliers} suppliers (${d.without_agreement} with no agreement date), ${d.grids} grids with ${d.grid_lines} lines, ${d.bookings} bookings for ${d.head_booked} head. Nothing written.`)); return; }
  const actor = actorOf(flags);
  await tx(db, async () => {
    for (const s of sup) {
      await db.query(`insert into suppliers (code, name, business_number, gst_registered, property_id, quality_assurance_no, agreement_signed_on, agreement_expires_on, region, contact_name, email, phone, bank_last4)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [s.code, s.name, s.business_number, s.gst_registered, s.property_id, s.quality_assurance_no, s.agreement_signed_on, s.agreement_expires_on, s.region, s.contact_name, s.email, s.phone, s.bank_last4]);
    }
    for (const code of grids) {
      const lines = gridRows.filter((g) => g.code === code);
      const [g] = await db.query('insert into grids (code, species, name, valid_from, notes) values ($1, $2, $3, $4, $5) returning id', [code, lines[0].species, `${code} (from MeatPro)`, lines[0].valid_from, 'Imported from MeatPro']);
      let sort = 0;
      for (const l of lines) await db.query('insert into grid_lines (grid_id, sort, category, min_kg, max_kg, min_fat, max_fat, max_teeth, cents_per_kg) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [g.id, ++sort, l.category, l.min_kg, l.max_kg, l.min_fat, l.max_fat, l.max_teeth, l.cents_per_kg]);
    }
    for (const b of bookRows) {
      const [s] = await db.query('select id, agent_id from suppliers where code = $1', [b.code]);
      const [g] = b.grid ? await db.query('select id from grids where code = $1', [b.grid])
        : await db.query('select id from grids where species = $1 and valid_from <= $2 and (valid_to is null or valid_to >= $2) order by valid_from desc limit 1', [b.species, b.kill_date]);
      if (!g) throw new CliError(`Booking ${b.number}: no ${b.species} grid for ${b.kill_date}. Nothing written.`);
      await db.query('insert into bookings (number, supplier_id, agent_id, species, head_booked, kill_date, grid_id) values ($1, $2, $3, $4, $5, $6, $7)', [b.number, s.id, s.agent_id, b.species, b.head, b.kill_date, g.id]);
    }
    await record(db, actor, 'import meatpro', dir, summary);
  });
  out(flags, summary, (d) => console.log(`Imported ${d.suppliers} suppliers, ${d.grids} grids and ${d.bookings} bookings.${d.without_agreement ? ` ${d.without_agreement} suppliers have no agreement date: record each one before their first settlement.` : ''}`));
}

async function cmdExport(db, { flags }) {
  const file = path.resolve(str(flags.file) || path.join(REPO_ROOT, 'exports', `meat-processing-${today()}.json`));
  if (existsSync(file)) throw new CliError(`${file} already exists. Choose another --file.`);
  const tables = ['settings', 'levy_rates', 'agents', 'suppliers', 'grids', 'grid_lines', 'grid_deductions', 'bookings', 'arrivals', 'carcases', 'settlements', 'settlement_lines', 'boning_runs', 'notes', 'history'];
  const dump = { exported_at: new Date().toISOString(), tables: {} };
  const counts = {};
  for (const t of tables) { dump.tables[t] = await db.query(`select * from ${t}`); counts[t] = dump.tables[t].length; }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(dump, null, 2), { mode: 0o600 });
  out(flags, { file, counts }, (d) => console.log(`Exported to ${d.file}: ${Object.entries(d.counts).map(([k, v]) => `${v} ${k}`).join(', ')}.`));
}

const COMMANDS = {
  suppliers: [cmdSuppliers, 'suppliers [--all]', 'Every producer: status, agent, agreement end, 90-day head, price and bruising'],
  supplier: [cmdSupplier, 'supplier <code|name|PIC>', 'One producer: details, agreement, performance, bookings, unpaid settlements, notes'],
  agents: [cmdAgents, 'agents', 'Stock agents, their commission and the head they bring'],
  grids: [cmdGrids, 'grids', 'The price grids'],
  grid: [cmdGrid, 'grid <code>', 'One grid: its lines and discounts'],
  bookings: [cmdBookings, 'bookings [--from=] [--to=] [--status=] [--species=]', 'Bookings in a date range'],
  agenda: [cmdAgenda, 'agenda [<date>]', 'The kill agenda for a day, against capacity, with holds'],
  yards: [cmdYards, 'yards', 'Stock in the yards now: hours in lairage, hours off feed, declarations'],
  supply: [cmdSupply, 'supply [--days=28]', 'Forward bookings per day against kill floor capacity'],
  'kill-sheet': [cmdKillSheet, 'kill-sheet <booking> [--all]', 'The kill sheet for one booking, carcase by carcase'],
  carcases: [cmdCarcases, 'carcases [--date=]', 'A day\'s kill by species and category'],
  'off-grid': [cmdOffGrid, 'off-grid', 'Carcases no grid line fits, with the nearest line'],
  trace: [cmdTrace, 'trace', 'Kill dates not yet reported to NLIS or NAIT'],
  preview: [cmdPreview, 'preview <booking>', 'Settlement test run, and what is stopping it'],
  settlements: [cmdSettlements, 'settlements [--status=issued|paid]', 'Settlements issued in the last 60 days'],
  settlement: [cmdSettlement, 'settlement <number|booking>', 'One settlement line by line'],
  due: [cmdDue, 'due', 'Settlements to pay, and killed bookings not yet settled'],
  performance: [cmdPerformance, 'performance', 'Each producer\'s last 90 days: weights, price, bruising, dark cutters, condemnations'],
  'price-check': [cmdPriceCheck, 'price-check [--species=]', 'What each producer was paid per kilogram, and why'],
  yields: [cmdYields, 'yields [--weeks=4]', 'Boning yield by week and species'],
  levies: [cmdLevies, 'levies', 'Levy rates with their sources, and levies deducted by month'],
  calendar: [cmdCalendar, 'calendar [--days=60]', 'Agreements and accreditations ending, settlements due, the kill ahead'],
  compliance: [cmdCompliance, 'compliance', 'Checks the records against declarations, withholding, traceability, invoice and welfare rules'],
  attention: [cmdAttention, 'attention', 'What needs doing now'],
  history: [cmdHistory, 'history [--limit=30]', 'Who did what'],
  'add-supplier': [cmdAddSupplier, 'add-supplier <CODE> --name= [--abn=] [--no-gst] [--property=] [--qa=] [--qa-expires=] [--agent=] --actor=', 'Add a producer'],
  agreement: [cmdAgreement, 'agreement <supplier> --signed= [--expires=] --actor=', 'Record a buyer-created tax invoice agreement'],
  qa: [cmdQa, 'qa <supplier> --no= --expires= --actor=', 'Record a quality assurance accreditation'],
  'supplier-status': [cmdSupplierStatus, 'supplier-status <supplier> active|hold|closed [--reason=] --actor=', 'Put a producer on hold, or clear it'],
  'add-agent': [cmdAddAgent, 'add-agent "<name>" [--company=] [--commission=] --actor=', 'Add a stock agent'],
  book: [cmdBook, 'book <supplier> <head> <species> --date= [--grid=] [--agent=] [--freight=] --actor=', 'Book stock in to kill'],
  cancel: [cmdCancel, 'cancel <booking> --reason= --actor=', 'Cancel a booking before the stock arrives'],
  arrive: [cmdArrive, 'arrive <booking> [--head=] [--doa=] [--declaration=] [--not-clear] [--pen=] [--last-fed=] --actor=', 'Record stock arriving, with the vendor declaration'],
  declaration: [cmdDeclaration, 'declaration <booking> --no= [--clear|--not-clear] --actor=', 'Record a vendor declaration that arrived late'],
  kill: [cmdKill, 'kill <booking> <killfile.csv> [--dry-run] [--date=] --actor=', 'Load the kill file from the scales'],
  condemn: [cmdCondemn, 'condemn <booking> <body> --reason= --actor=', 'Record a condemnation'],
  regrade: [cmdRegrade, 'regrade <booking> <body> [--kg=] [--fat=] [--teeth=] [--bruise=] [--category=] [--dark] --reason= --actor=', 'Correct a carcase before settlement'],
  price: [cmdPrice, 'price <booking> <body> --cents= --reason= --actor=', 'Price an off-grid carcase as agreed'],
  reported: [cmdReported, 'reported <kill date> [--species=] --ref= --actor=', 'Record the NLIS or NAIT upload for a kill date'],
  settle: [cmdSettle, 'settle <booking> [--dry-run] [--on=] --actor=', 'Issue the settlement (buyer-created tax invoice)'],
  pay: [cmdPay, 'pay <settlement> [--on=] [--ref=] --actor=', 'Record that the bank paid a settlement'],
  adjust: [cmdAdjust, 'adjust <settlement> <amount> --reason= [--no-gst] --actor=', 'Issue an adjustment to a settlement'],
  boning: [cmdBoning, 'boning --species= --in=<kg> --out=<kg> [--fat-bone=] [--cartons=] [--date=] --actor=', 'Record a boning run'],
  log: [cmdLog, 'log <supplier|booking> "<note>" --actor=', 'A note on a producer or a booking'],
  'draft-letter': [cmdDraftLetter, 'draft-letter <supplier> --kind=feedback|agreement|declaration|payment|bruising [--booking=]', 'Draft a letter to drafts/'],
  import: [cmdImport, 'import meatpro <folder> [--dry-run] --actor=', 'Bring suppliers, grids and forward bookings across from MeatPro'],
  export: [cmdExport, 'export [--file=]', 'Everything to one JSON file'],
  help: [null, 'help', 'This list'],
};

async function main() {
  const { args, flags } = parseArgv(process.argv.slice(2));
  const name = args.shift() || 'help';
  if (name === 'help' || flags.help || !COMMANDS[name]) {
    const list = Object.entries(COMMANDS).map(([k, [, usage, what]]) => ({ command: k, usage, what }));
    if (flags.json) console.log(JSON.stringify(list, null, 2));
    else { heading('Meat Processing for Claude Code'); table(list, [['usage', 'Command'], ['what', 'What it does']]); }
    if (name !== 'help' && !flags.help && !COMMANDS[name]) { console.error(`Unknown command "${name}".`); process.exit(1); }
    return;
  }
  const db = await getDb();
  try {
    await settings(db).catch(() => {});
    await COMMANDS[name][0](db, { args, flags });
  } finally {
    await db.close();
  }
}

main().catch((e) => {
  const msg = e instanceof CliError ? e.message : String(e.message || e).replace(/^error: /, '');
  console.error(msg);
  process.exit(e.code && Number.isInteger(e.code) ? e.code : 1);
});
