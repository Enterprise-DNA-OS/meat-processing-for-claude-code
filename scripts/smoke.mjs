#!/usr/bin/env node
// End-to-end smoke test on a throwaway embedded database.
// Migrate, seed, then every CLI command, asserting on the JSON. Then the rules
// the database enforces, a booking taken from arrival through the kill file to
// a paid settlement, an import from a MeatPro-shaped export, the documents, the
// views and the export. Passes on Windows and Linux. No network.
//
// With TEST_DATABASE_URL set it runs the same steps against that Postgres
// (an empty, disposable database: the test writes demo data into it).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'plant-smoke-'));
const work = mkdtempSync(path.join(tmpdir(), 'plant-smoke-files-'));
const env = { ...process.env, DATA_DIR: dataDir, PLANT_ACTOR: 'Smoke Test' };
delete env.DATABASE_URL;
if (process.env.TEST_DATABASE_URL) env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let step = 0;
function run(label, args, { json = true, expectFail = false, script = 'plant.mjs' } = {}) {
  step++;
  const extra = script === 'seed.mjs' && env.DATABASE_URL ? ['--demo-database'] : [];
  const argv = [path.join(root, 'scripts', script), ...args, ...extra, ...(json ? ['--json'] : [])];
  const res = spawnSync(process.execPath, argv, { cwd: root, env, encoding: 'utf8' });
  const ok = expectFail ? res.status !== 0 : res.status === 0;
  if (!ok) {
    console.error(`\nFAIL step ${step} (${label}): exit ${res.status}\n--- stdout\n${res.stdout}\n--- stderr\n${res.stderr}`);
    process.exit(1);
  }
  console.log(`  ok  ${String(step).padStart(3)}  ${label}`);
  if (!json || expectFail) return { stdout: res.stdout, stderr: res.stderr };
  try { return JSON.parse(res.stdout); } catch {
    console.error(`\nFAIL step ${step} (${label}): output is not JSON\n${res.stdout}\n${res.stderr}`);
    process.exit(1);
  }
}
function assert(cond, msg) {
  if (!cond) { console.error(`\nFAIL assertion: ${msg}`); process.exit(1); }
}
const n = (v) => Number(v ?? 0);
const iso = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (k) => { const d = new Date(); d.setDate(d.getDate() + k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
void iso;

console.log(`smoke: data dir ${dataDir}`);
try {
  run('migrate', [], { json: false, script: 'migrate.mjs' });
  run('migrate again (idempotent)', [], { json: false, script: 'migrate.mjs' });
  run('seed', [], { json: false, script: 'seed.mjs' });
  run('seed again (idempotent)', [], { json: false, script: 'seed.mjs' });

  // ---- reads
  const help = run('help', ['help']);
  assert(help.length >= 45, `help lists every command (${help.length})`);
  const sups = run('suppliers', ['suppliers']);
  assert(sups.length === 8, `eight suppliers (${sups.length})`);
  const red = run('supplier by code', ['supplier', 'RED']);
  assert(red.supplier.name === 'Redbank Cattle Co' && n(red.performance.bruised_pct) >= 20, 'Redbank, bruising one in four');
  assert(run('supplier by property id', ['supplier', 'NA224681']).supplier.code === 'GLN', 'resolved by PIC');
  assert(run('supplier by part of the name', ['supplier', 'tallow']).supplier.code === 'TAL', 'resolved by name');
  const amb = run('an ambiguous name lists candidates and exits 1', ['supplier', 'Co'], { json: false, expectFail: true });
  assert(/matches \d+ supplier records/.test(amb.stderr), 'lists candidates rather than guessing');
  const none = run('an unknown supplier exits 1', ['supplier', 'Nobody Station'], { json: false, expectFail: true });
  assert(/No supplier matches/.test(none.stderr), 'and says so');
  assert(run('agents', ['agents']).length === 2, 'two agents');
  assert(run('grids', ['grids']).length === 3, 'three grids');
  const grid = run('grid', ['grid', 'CAT-SPRING']);
  assert(grid.lines.length === 9 && grid.deductions.length === 2, 'cattle grid lines and discounts');
  const bookings = run('bookings', ['bookings']);
  assert(bookings.length === 18, `eighteen bookings in range (${bookings.length})`);
  assert(run('bookings by status', ['bookings', '--status=killed']).length === 4, 'four killed, not settled');

  const agenda = run('agenda today', ['agenda']);
  assert(agenda.bookings.length === 2 && agenda.holds.some((h) => h.number === 'B1010'), 'today: two mobs, B1010 held on withholding');
  const over = run('agenda on the over-booked day', ['agenda', daysFromNow(2)]);
  assert(over.cattle_head === 345 && over.cattle_capacity === 300, 'day after tomorrow is over capacity');
  const yards = run('yards', ['yards']);
  assert(yards.find((y) => y.number === 'B1009' && n(y.hours_in_yards) > 24), 'B1009 over the lairage limit');
  const supply = run('supply', ['supply']);
  assert(supply.some((d) => d.over), 'supply shows an over-capacity day');

  const ks = run('kill sheet', ['kill-sheet', 'B1006']);
  assert(ks.carcases.length === 18 && ks.carcases.filter((c) => c.off_grid).length === 1, 'TAL kill sheet with one off grid');
  const ks7 = run('kill sheet with a head missing', ['kill-sheet', 'B1007']);
  assert(n(ks7.booking.unaccounted) === 1, 'B1007 has one head unaccounted for');
  const og = run('off grid', ['off-grid']);
  assert(og.length === 1 && og[0].body_no === 409 && /STEER/.test(og[0].nearest_line), 'off grid with the nearest line');
  const day = run('carcases for a day', ['carcases', `--date=${daysFromNow(-1)}`]);
  assert(day.grades.length >= 3, 'yesterday by category');
  const trace = run('trace', ['trace']);
  assert(trace.unreported.some((r) => r.late && r.species === 'cattle'), 'a late traceability report');

  const pv = run('settlement test run', ['preview', 'B1005']);
  assert(pv.blockers.some((b) => /agreement/.test(b)) && pv.lines.some((l) => l.kind === 'levy' && n(l.amount_cents) === -52500), 'KOO held on the agreement; lamb levy capped at $1.50 a head');
  assert(run('settlement test run, declaration', ['preview', 'B1008']).blockers.some((b) => /declaration/.test(b)), 'B1008 held on the declaration');
  const tal = run('settlement test run, no GST', ['preview', 'B1006']);
  assert(!tal.lines.some((l) => l.kind === 'gst') && tal.blockers.some((b) => /off grid/.test(b)), 'TAL: no GST line, held on the off-grid carcase');
  const sets = run('settlements', ['settlements']);
  assert(sets.length === 4, 'four settlements');
  const s3 = run('settlement', ['settlement', 'S-B1003']);
  assert(n(s3.settlement.net_cents) === n(s3.settlement.gross_cents) + n(s3.settlement.gst_cents) - n(s3.settlement.deductions_cents), 'settlement adds up');
  assert(run('settlement by booking number', ['settlement', 'B1004']).settlement.number === 'S-B1004', 'resolved by booking');
  const due = run('due', ['due']);
  assert(due.open.some((o) => o.number === 'S-B1003' && n(o.days_late) > 0) && due.killed_not_settled.length === 4, 'one late settlement, four killed not settled');
  const perf = run('performance', ['performance']);
  assert(perf.find((p) => p.code === 'RED').flags.includes('bruising'), 'Redbank flagged for bruising');
  const pc = run('price check', ['price-check', '--species=cattle']);
  assert(pc[0].supplier_code === 'TAL', 'Tallowood paid least per kg (older cows)');
  const yl = run('yields', ['yields']);
  assert(yl.some((y) => y.species === 'cattle' && y.change !== null && y.change < -1.5), 'cattle yield dropped');
  const lev = run('levies', ['levies']);
  assert(lev.rates.length === 3 && lev.collected.length >= 2, 'levy rates and levies collected');
  assert(run('calendar', ['calendar']).length >= 8, 'calendar');
  const comp = run('compliance', ['compliance']);
  for (const rule of ['declaration', 'withholding', 'rcti-agreement', 'quality-assurance', 'lairage', 'trace-report'])
    assert(comp.some((f) => f.rule === rule && f.level === 'breach'), `compliance breach: ${rule}`);
  const att = run('attention', ['attention']);
  assert(att.length >= 15 && att[0].level === 'breach', `attention, breaches first (${att.length})`);
  assert(att.some((a) => a.subject === 'S-B1003') && att.some((a) => /capacity/.test(a.what)) && att.some((a) => /boning/.test(a.subject)), 'late payment, capacity and yield on the list');

  // ---- the database's own rules
  run('a settlement is refused while a head is unaccounted for', ['settle', 'B1007'], { json: false, expectFail: true });
  const noAg = run('a settlement is refused with no agreement in date', ['settle', 'B1005'], { json: false, expectFail: true });
  assert(/agreement/.test(noAg.stderr), 'says why');
  const noDecl = run('a settlement is refused with no declaration', ['settle', 'B1008'], { json: false, expectFail: true });
  assert(/declaration/.test(noDecl.stderr), 'says why');
  const offg = run('a settlement is refused with a carcase off grid', ['settle', 'B1006'], { json: false, expectFail: true });
  assert(/off grid/.test(offg.stderr), 'says why');
  run('a settled kill sheet cannot be regraded', ['regrade', 'B1004', '305', '--kg=300', '--reason=test'], { json: false, expectFail: true });
  run('a booking for a supplier on hold is refused', ['book', 'WAR', '100', 'sheep', `--date=${daysFromNow(9)}`], { json: false, expectFail: true });
  run('a booking on a grid for another species is refused', ['book', 'BRK', '10', 'cattle', `--date=${daysFromNow(9)}`, '--grid=LAMB-SPRING'], { json: false, expectFail: true });
  

  // ---- clearing the holds
  assert(run('record the agreement', ['agreement', 'KOO', `--signed=${daysFromNow(0)}`, `--expires=${daysFromNow(730)}`]).code === 'KOO', 'agreement');
  const sk = run('settle KOO now', ['settle', 'B1005']);
  assert(sk.settlement.number === 'S-B1005' && sk.lines.length === 5, 'KOO settled');
  run('settling twice is refused', ['settle', 'B1005'], { json: false, expectFail: true });
  run('declaration arrives late', ['declaration', 'B1008', '--no=NVD 5513999']);
  assert(run('settle MIL', ['settle', 'B1008']).settlement.status === 'issued', 'MIL settled');
  const pr = run('price the off-grid carcase as agreed', ['price', 'B1006', '409', '--cents=610', '--reason=agreed with June by phone']);
  assert(n(pr.cents_per_kg) === 610 && n(pr.value_cents) === Math.round(299 * 610), 'priced');
  const stal = run('settle TAL (no GST, no agreement needed)', ['settle', 'B1006']);
  assert(n(stal.settlement.gst_cents) === 0, 'no GST for a supplier not registered');
  run('regrade before settlement', ['regrade', 'B1007', '505', '--bruise=2', '--reason=QA check']);
  run('condemn', ['condemn', 'B1007', '510', '--reason=Pleurisy, whole carcase']);
  const ks7b = run('kill sheet after the condemnation', ['kill-sheet', 'B1007']);
  assert(n(ks7b.booking.condemned) === 1, 'one condemned');
  run('pay', ['pay', 'S-B1003', '--ref=EFT 20511']);
  run('paying twice is refused', ['pay', 'S-B1003'], { json: false, expectFail: true });
  const adj = run('adjustment', ['adjust', 'S-B1004', '250', '--reason=Body 317 dark cutter reading overturned']);
  assert(adj.number === 'S-B1004-A1' && n(adj.gst_cents) === 2500, 'adjustment with GST');
  assert(run('traceability reported', ['reported', daysFromNow(-2), '--species=cattle', '--ref=NLIS 77812']).head === 18, '18 head reported');

  // ---- a booking end to end: book, arrive, kill file, settle, pay
  const bk = run('book', ['book', 'GLN', '6', 'cattle', `--date=${daysFromNow(10)}`, '--freight=420']);
  assert(bk.grid_code === 'CAT-SPRING' && !bk.over_capacity, 'booked on the current grid');
  run('arrive with no declaration', ['arrive', bk.number, '--head=6', '--pen=P2']);
  const kf = path.join(work, 'kill.csv');
  writeFileSync(kf, 'Body No,NLIS,Category,HSCW,Fat,Teeth,Bruise,Dark Cutter,Condemned,Reason\r\n901,982 0009 00001,STEER,301.4,3,2,0,No,No,\r\n902,982 0009 00002,STEER,288.0,3,0,2,No,No,\r\n903,982 0009 00003,HEIFER,262.5,2,0,0,Yes,No,\r\n904,982 0009 00004,STEER,355.0,4,4,0,No,No,\r\n905,982 0009 00005,STEER,312.2,7,2,0,No,No,\r\n906,982 0009 00006,COW,240.0,3,8,0,No,Yes,Arthritis\r\n');
  const kdry = run('kill file test run', ['kill', bk.number, kf, '--dry-run', `--date=${daysFromNow(10)}`]);
  assert(kdry.dry_run && kdry.carcases === 6 && kdry.condemned === 1, 'test run reads the kill file');
  const kill = run('kill file', ['kill', bk.number, kf, `--date=${daysFromNow(10)}`]);
  assert(kill.off_grid === 1 && kill.unaccounted === 0, 'one fat-7 carcase off grid, every head accounted for');
  run('the same kill file twice is refused', ['kill', bk.number, kf, `--date=${daysFromNow(10)}`], { json: false, expectFail: true });
  const pv2 = run('preview the new booking', ['preview', bk.number]);
  assert(pv2.blockers.length === 2, `held on the declaration and the off-grid carcase (${pv2.blockers})`);
  run('declaration', ['declaration', bk.number, '--no=NVD 9900001', '--clear']);
  run('price it', ['price', bk.number, '905', '--cents=650', '--reason=over fat, agreed']);
  const fin = run('settle it', ['settle', bk.number]);
  const lines = fin.lines;
  const gross = lines.filter((l) => l.kind === 'carcases').reduce((t, l) => t + n(l.amount_cents), 0);
  assert(lines.some((l) => l.kind === 'levy' && n(l.amount_cents) === -3000) && lines.some((l) => l.kind === 'freight' && n(l.amount_cents) === -42000), 'levy on all six head killed, freight recovered');
  assert(n(fin.settlement.gross_cents) === gross && n(fin.settlement.net_cents) === gross + n(fin.settlement.gst_cents) - n(fin.settlement.deductions_cents), 'settlement totals');
  run('pay it', ['pay', fin.settlement.number, '--ref=EFT 1']);

  // ---- direct database checks
  const { getDb } = await import('./lib/db.mjs');
  process.env.DATA_DIR = dataDir;
  if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL; else delete process.env.DATABASE_URL;
  const db = await getDb();
  let refused = false;
  try { await db.exec("update settlement_lines set amount_cents = 1"); } catch (e) { refused = /append only/.test(e.message); }
  step++; assert(refused, 'settlement lines refuse an edit'); console.log(`  ok  ${String(step).padStart(3)}  settlement lines refuse an edit`);
  refused = false;
  try { await db.exec("update settlements set net_cents = net_cents + 100, gross_cents = gross_cents + 100 where number = 'S-B1001'"); } catch (e) { refused = /cannot be changed/.test(e.message); }
  step++; assert(refused, 'an issued settlement refuses an edit'); console.log(`  ok  ${String(step).padStart(3)}  an issued settlement refuses an edit`);
  refused = false;
  try { await db.exec("delete from settlements where number = 'S-B1001'"); } catch (e) { refused = /never deleted/.test(e.message); }
  step++; assert(refused, 'a settlement cannot be deleted'); console.log(`  ok  ${String(step).padStart(3)}  a settlement cannot be deleted`);
  refused = false;
  try { await db.exec("delete from history"); } catch (e) { refused = /append only/.test(e.message); }
  step++; assert(refused, 'history is append only'); console.log(`  ok  ${String(step).padStart(3)}  history is append only`);
  await db.close();

  // ---- writes on producers, agents, notes, boning, cancel, letters
  run('add agent', ['add-agent', 'Highland Stock Agents', '--commission=12']);
  run('add supplier', ['add-supplier', 'HIL', '--name=Hillcrest Angus', '--abn=11 222 333 444', '--property=NA999001', '--agent=Highland Stock Agents']);
  run('a duplicate supplier code is refused', ['add-supplier', 'HIL', '--name=Other'], { json: false, expectFail: true });
  run('qa', ['qa', 'HIL', '--no=LPA 4400001', `--expires=${daysFromNow(300)}`]);
  const hb = run('book the new supplier', ['book', 'HIL', '12', 'cattle', `--date=${daysFromNow(12)}`]);
  run('cancel it', ['cancel', hb.number, '--reason=Sold privately']);
  run('supplier on hold', ['supplier-status', 'HIL', 'hold', '--reason=QA audit pending']);
  run('a hold with no reason is refused', ['supplier-status', 'BRK', 'hold'], { json: false, expectFail: true });
  run('clear the hold', ['supplier-status', 'HIL', 'active']);
  run('log', ['log', 'RED', 'Greg moved the loading ramp. Watch the next kill sheet.']);
  run('log on a booking', ['log', 'B1009', 'Killed first thing to come under the lairage limit.']);
  const bon = run('boning run', ['boning', '--species=cattle', '--in=8800', '--out=6150', '--fat-bone=2560', '--cartons=241']);
  assert(n(bon.yield_pct) > 69, 'yield recorded');
  for (const kind of ['feedback', 'agreement', 'payment', 'bruising']) {
    const d = run(`draft letter ${kind}`, ['draft-letter', kind === 'agreement' ? 'GLN' : kind === 'payment' ? 'RED' : kind === 'bruising' ? 'RED' : 'KOO', `--kind=${kind}`]);
    assert(existsSync(d.file), `${kind} draft written`);
  }
  const dd = run('draft letter declaration', ['draft-letter', 'MIL', '--kind=declaration'], { json: false, expectFail: true });
  assert(/no consignment missing/.test(dd.stderr), 'nothing missing any more');
  assert(run('history', ['history', '--limit=100']).length >= 25, 'every change recorded');

  // ---- import from a MeatPro-shaped export
  const imp = path.join(work, 'meatpro');
  mkdirSync(imp);
  writeFileSync(path.join(imp, 'suppliers.csv'), 'No.,Name,ABN,PIC,LPA Number,RCTI Agreement Date,RCTI Expiry,City,E-Mail,Bank Account No.,GST Registered\r\nV0101,Mount Ida Pastoral,22 333 444 555,NA700101,LPA 5000101,01/03/2026,28/02/2028,Armidale,ida@example.com,062-000 1234 5678,Yes\r\nV0102,Bald Hill Lamb,33 444 555 666,NG700102,,,,Bathurst,,,Yes\r\nV0103,Riverbend Hobby Farm,,NA700103,,,,Uralla,,,No\r\n');
  writeFileSync(path.join(imp, 'grids.csv'), 'Grid Code,Species,Category,Min Weight,Max Weight,Min Fat,Max Fat,Max Teeth,Price c/kg,Valid From\r\nMP-CAT,Cattle,STEER,200,420,1,5,4,712,' + daysFromNow(-5) + '\r\nMP-CAT,Cattle,COW,160,400,1,5,8,548,' + daysFromNow(-5) + '\r\n');
  writeFileSync(path.join(imp, 'bookings.csv'), 'Booking No.,Vendor No.,Species,Head,Kill Date,Grid Code\r\nMP5501,V0101,Cattle,40,' + daysFromNow(15).split('-').reverse().join('/') + ',MP-CAT\r\nMP5502,V0103,Cattle,8,' + daysFromNow(16) + ',MP-CAT\r\n');
  const idry = run('import test run', ['import', 'meatpro', imp, '--dry-run']);
  assert(idry.dry_run && idry.suppliers === 3 && idry.without_agreement === 1 && idry.grid_lines === 2 && idry.head_booked === 48, 'test run reads all three files');
  const imported = run('import', ['import', 'meatpro', imp]);
  assert(imported.bookings === 2, 'imported');
  const ida = run('imported supplier', ['supplier', 'V0101']);
  assert(ida.supplier.agreement_expires_on === '2028-02-28' && ida.supplier.bank_last4 === '5678' && ida.bookings.length === 1, 'agreement date, bank and booking carried in');
  assert(run('imported supplier not GST registered', ['supplier', 'V0103']).supplier.gst_registered === false, 'GST flag mapped');
  run('importing the same suppliers again is refused', ['import', 'meatpro', imp], { json: false, expectFail: true });
  writeFileSync(path.join(imp, 'suppliers.csv'), 'No.,Name\r\nV0999,Nobody Ltd\r\n');
  writeFileSync(path.join(imp, 'grids.csv'), 'Grid Code,Species,Price c/kg\r\n');
  writeFileSync(path.join(imp, 'bookings.csv'), 'Booking No.,Vendor No.,Species,Head,Kill Date\r\nMP9999,V9999,Cattle,5,' + daysFromNow(20) + '\r\n');
  const ibad = run('an unknown supplier on a booking refuses the import, nothing written', ['import', 'meatpro', imp], { json: false, expectFail: true });
  assert(/V9999/.test(ibad.stderr), 'names the supplier');
  run('nothing was written', ['supplier', 'V0999'], { json: false, expectFail: true });

  // ---- documents, views, export
  const docs = run('npm run docs', [], { json: false, script: 'docs.mjs' });
  assert(/\d+ document\(s\) rendered/.test(docs.stdout), 'documents rendered');
  const setDocs = readdirSync(path.join(root, 'docs-out', 'settlement'));
  assert(setDocs.length >= 8, `settlements rendered (${setDocs.length})`);
  const talDoc = readFileSync(path.join(root, 'docs-out', 'settlement', setDocs.find((f) => /-tal-/.test(f))), 'utf8');
  assert(/not registered for GST/.test(talDoc), 'a supplier not registered for GST gets a settlement statement, not a tax invoice');
  const kooDoc = readFileSync(path.join(root, 'docs-out', 'settlement', setDocs.find((f) => /s-b1005-koo/.test(f))), 'utf8');
  assert(/Recipient created tax invoice/.test(kooDoc), 'a registered supplier gets a recipient created tax invoice');
  assert(readdirSync(path.join(root, 'docs-out', 'kill-sheet')).length >= 9, 'kill sheets rendered');
  const views = run('npm run view', [], { json: false, script: 'view.mjs' });
  assert(/views[\\/]week\.html/.test(views.stdout) && /views[\\/]plant\.html/.test(views.stdout), 'both views rendered');
  const exp = run('export', ['export', `--file=${path.join(work, 'backup.json')}`]);
  assert(exp.counts.carcases > 1300 && exp.counts.settlements >= 8 && exp.counts.suppliers === 12, 'every record type exported');
  run('export refuses to overwrite', ['export', `--file=${path.join(work, 'backup.json')}`], { json: false, expectFail: true });

  console.log(`\nPASS: ${step} steps`);
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
