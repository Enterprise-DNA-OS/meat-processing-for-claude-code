<h1 align="center">Meat Processing for Claude Code</h1>

<p align="center">
  <strong>The open-source meat processing system that is just a database and Claude Code.</strong>
</p>

<p align="center">
  Created by <a href="https://www.enterprisedna.co"><strong>Enterprise DNA</strong></a>. Free and open source. Works with Claude Code, Codex, OpenCode or Cursor.
</p>

<!-- three-doors -->
<table align="center">
  <tr>
    <td align="center"><strong>Do it yourself</strong><br/>Clone it, run it, own it. Free, MIT.<br/><a href="#quick-start">Quick start</a></td>
    <td align="center"><strong>We customise it</strong><br/>Your fields, your rules, your Fujitsu MeatPro data brought across.<br/><a href="https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=meatpro">Book a call</a></td>
    <td align="center"><strong>We run it for you</strong><br/>Installed, connected and operated inside Omni. Setup fee, then a retainer.<br/><a href="https://enterprisedna.co/omni/instead-of/meatpro?utm_source=github&utm_medium=readme&utm_campaign=meatpro">How it works</a></td>
  </tr>
</table>

<p align="center">
  <a href="#what-is-this">What is this</a> &bull;
  <a href="#why-no-front-end">Why no front end</a> &bull;
  <a href="#quick-start">Quick start</a> &bull;
  <a href="#the-commands">Commands</a> &bull;
  <a href="#instead-of-meatpro">Instead of Fujitsu MeatPro</a> &bull;
  <a href="#want-it-installed-and-run-for-you">Installed for you</a> &bull;
  <a href="#license">License</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node-20+-339933?style=flat-square" alt="Node 20+" />
  <img src="https://img.shields.io/badge/PostgreSQL-any-336791?style=flat-square" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/PGlite-embedded-3ecf8e?style=flat-square" alt="PGlite" />
  <img src="https://img.shields.io/badge/License-MIT-yellow?style=flat-square" alt="MIT License" />
</p>

---

## What is this

Meat Processing for Claude Code does the office job you pay Fujitsu MeatPro for, as a Postgres database and a set of agent commands. There is no web front end. You open the folder in [Claude Code](https://claude.com/claude-code) (or Codex, OpenCode, Cursor: see `AGENTS.md`) and ask for what you want in plain language. It runs the right query, and it can answer questions the MeatPro screens cannot.

Fujitsu publishes no price for MeatPro. It is built on Microsoft Dynamics 365 Business Central and sold with Fujitsu's implementation and support to medium and large meat processing plants in Australia and New Zealand, quoted to each plant ([Fujitsu's MeatPro page, archived January 2026](https://web.archive.org/web/20260112171419/https://www.fujitsu.com/au/services/data-applications/enterprise-applications/connecting-with-microsoft/meatpro/index.html)). So the bill is Business Central licences per user, plus the MeatPro layer, plus a partner to implement and change it.

Want the same thing with a web front end, or built on a different stack? That is a customisation, and it is exactly what Enterprise DNA does: [book a call](https://enterprisedna.co/omni/book/?utm_source=github&utm_medium=readme&utm_campaign=meatpro).

It is for a red meat plant's office in Australia or New Zealand: a service kill, a domestic abattoir, an export plant or a boning room buying cattle, lambs, sheep or goats from producers. It holds the producers and their stock agents, the price grids, kill bookings, arrivals with the vendor declaration (NVD or ASD), the kill sheet off the scales, the price of every carcase off the grid with its bruising and dark cutting discounts, condemnations, levies, freight and commission, each producer's settlement as a buyer-created tax invoice, boning yields and the traceability report to NLIS or NAIT.

The rules sit in the database itself: every carcase is priced off the grid agreed for its booking or flagged off grid, a settlement is refused while any head is unaccounted for, any carcase is off grid, the vendor declaration is missing or the producer has no buyer-created invoice agreement in date, a settled kill sheet cannot be edited, an issued settlement cannot be changed or deleted (corrections are adjustments), and settlement lines and history are append only.

It does not run the kill floor. Your scales, grading and carton systems keep running and hand it a kill file. It does not pay anyone or upload anything: payments go out through your bank and kill data goes to NLIS or NAIT, then both are recorded here.

## Why no front end

- The front end was only ever there because the database was hard to talk to. That is no longer true.
- Your data sits in plain Postgres tables you own. Any tool can read them. No export, no lock-in.
- No seats, no tiers, no add-ons. Read [docs/why-no-front-end.md](docs/why-no-front-end.md) for the honest trade-offs too.

## Quick start

Sixty seconds, no database install (an embedded Postgres runs inside Node):

```bash
git clone https://github.com/Enterprise-DNA-OS/meat-processing-for-claude-code.git
cd meat-processing-for-claude-code
npm install
npm run demo
```

Then open the folder in Claude Code and type `/attention`. The demo is Tablelands Meat Co, a fictional cattle and lamb plant in regional New South Wales, and its week is deliberately messy: a settlement four days past the payment terms, 350 lambs that cannot be settled because the producer's invoice agreement ran out, a fat score 6 steer off the grid, a head unaccounted for between the yards and the kill sheet, 450 lambs killed with no vendor declaration on file, a cattle mob whose declaration says it is still inside an export slaughter interval, 30 head in the yards for 30 hours, a kill not reported to NLIS within 48 hours, a day booked 45 head over the kill floor's capacity, a producer bruising one carcase in four, and a beef boning yield down 2.6 points.

`npm test` runs every command against a throwaway database (103 steps). Set `TEST_DATABASE_URL` to an empty disposable Postgres to run the same steps there.

### Use it with your own Postgres or Supabase

Copy `.env.example` to `.env`, set `DATABASE_URL`, then `npm run migrate`. Same commands, shared data, no per-seat fee.

## The commands

49 slash commands, each a short recipe over one CLI (`npm run plant -- help` lists its verbs). Every read takes `--json`. Producers match by code, name, ABN or PIC; bookings by number; settlements by number or booking. An ambiguous match lists the candidates and stops. Every write needs a person: `--actor="Name"` or `PLANT_ACTOR`.

### The working week

1. `/kill-agenda` and `/yards` each morning: what is booked, what has arrived, what is held, what has been waiting too long.
2. `/arrive` records each mob with its declaration; `/kill` loads the kill file from the scales; `/off-grid` lists carcases that need a price agreed.
3. `/trace` before the 48 hours are up; `/feedback` sends each producer their kill sheet.
4. `/settle` issues each settlement once every head is accounted for; `/due` and `/pay` keep producers paid on time.
5. `/weekly-review` writes the Monday review; `/performance`, `/price-check` and `/yields` show where the money went.

| Command | What it does |
|---|---|
| `/adjust` | Issue an adjustment to a settlement already issued: a price agreed late, a regrade, a correction. |
| `/agents` | Stock agents, their commission per head and the head they bring in. |
| `/agreement` | Record a producer's signed buyer-created tax invoice agreement, or its renewal. |
| `/arrive` | Record a mob arriving at the yards, with its vendor declaration. |
| `/attention` | What needs doing now across the plant: holds, late payments, settlements held, traceability reports, capacity, bruising and yields. |
| `/boning` | Record a boning run: carcase kilograms in, saleable kilograms out, fat and bone, cartons. |
| `/book` | Book a producer's stock in to kill, on the grid valid for the kill date. |
| `/bookings` | Bookings in a date range, with head booked, arrived and killed and the settlement. |
| `/calendar` | What is coming up: agreements and accreditations ending, settlements due, the kill ahead, levy rates due a check. |
| `/cancel` | Cancel a booking before the stock arrives. |
| `/carcases` | One day's kill by species and category: head, average weight, price, condemned and off grid. |
| `/compliance` | Check the records against vendor declarations, withholding periods, the 48-hour traceability report, buyer-created invoice rules, quality assurance and the plant's lairage limit, each finding cited. |
| `/condemn` | Record a condemnation the inspector made. |
| `/customise` | Make this system yours in plain language. Add a field, rename stages, change a rule, add a column to a document. Writes the migration, applies it, updates the commands that touch it. |
| `/declaration` | Record a vendor declaration that arrived after the stock. |
| `/documents` | Render the paperwork: a settlement (recipient created tax invoice, or settlement statement) per settlement, and a kill sheet per booking. |
| `/draft-letter` | Draft a letter to a producer: kill sheet cover, invoice agreement renewal, missing declaration, payment advice, or bruising and condemnations. |
| `/due` | What the plant owes producers: settlements to pay with days late, and killed bookings not yet settled. |
| `/export` | Export every record to one JSON file. |
| `/feedback` | Send a producer their kill sheet: a short covering note and the kill sheet document. |
| `/grid` | One price grid line by line: categories, weight and fat bands, dentition, cents per kilogram and the discounts. |
| `/grids` | The price grids, with their species, dates and price range. |
| `/help` | Every CLI command and its arguments. |
| `/history` | Who changed what, and when. |
| `/hold` | Put a producer on hold (no new bookings, no payments) or clear the hold. |
| `/import` | Bring producers, price grids and forward bookings across from MeatPro. |
| `/kill-agenda` | The kill agenda for a day: every mob booked, what has arrived, against kill floor capacity, with any mob that must be held. |
| `/kill-sheet` | The kill sheet for one booking: the summary by category and every carcase with its price. |
| `/kill` | Load the day's kill file from the scales or grading system onto a booking: test run, then record. |
| `/levies` | Levy rates with their sources and the date each was checked, and levies deducted from producers by month. |
| `/log` | A note on a producer or a booking: a call, a complaint, a promise. |
| `/new-view` | Add a read-only HTML view (a dashboard page) from a plain-language description, rendered in the operator's brand by `npm run view`. |
| `/off-grid` | Carcases no grid line fits, with the nearest line, so a price can be agreed. |
| `/onboard` | Set up a new producer: the record, the buyer-created invoice agreement and quality assurance. |
| `/pay` | Record that the bank has paid a settlement. |
| `/performance` | Each producer's last 90 days: average weight, price per kilogram, bruising, dark cutters, condemnations and what the discounts cost them. |
| `/price-check` | What each producer was really paid per kilogram over 90 days, and why: weight, fat, age and discounts. |
| `/regrade` | Correct a carcase's weight, fat score, teeth, bruise score, category or dark cutting before the booking is settled. |
| `/settle` | Issue a producer's settlement for a booking (the buyer-created tax invoice): test run, then issue. |
| `/settlement` | One settlement line by line: carcases, GST, levies, freight, commission and the net. |
| `/settlements` | Settlements issued in the last 60 days, with gross, GST, deductions, net and whether paid. |
| `/supplier` | Everything about one producer: details, agreement, quality assurance, 90-day performance, bookings, unpaid settlements and notes. |
| `/suppliers` | Every producer: status, agent, buyer-created invoice agreement end, 90-day head, price and bruising. |
| `/supply` | Forward bookings per day against the kill floor's capacity for the next four weeks. |
| `/trace` | Kill dates not yet reported to NLIS or NAIT as slaughtered, and how close each is to the 48-hour limit. |
| `/views` | Render the read-only dashboards: this week on the kill floor, and plant performance. |
| `/weekly-review` | The Monday plant review, written from the attention list, the money owed to producers and producer performance. |
| `/yards` | Stock in the yards now: hours since arrival, hours off feed, declaration and withholding status. |
| `/yields` | Boning yield by week and species, and any drop worth looking at. |

## Ten questions MeatPro's screens do not answer in one step

Each one is a single ask here, answered from the demo data by a shipped command.

1. Which mobs in the yards must not be killed today, and why? (`/kill-agenda`)
2. Which killed bookings cannot be settled yet, and what is holding each one? (`/attention`, `/settle`)
3. Which carcases fell off the grid, and what is the nearest line to price them on? (`/off-grid`)
4. Which kill dates have not been reported to NLIS or NAIT, and how many hours are left? (`/trace`)
5. Which settlements are past our payment terms, and by how many days? (`/due`)
6. Which producers' buyer-created invoice agreements have run out or end in the next 60 days? (`/compliance`)
7. Which producers bruise or lose carcases above our watch level, and what did it cost them? (`/performance`)
8. Which producer was paid least per kilogram over 90 days, and was it weight, fat, age or bruising? (`/price-check`)
9. Which days in the next four weeks are booked over the kill floor's capacity? (`/supply`)
10. Which week did the boning yield drop, and by how much? (`/yields`)

## Documents and views

`npm run docs` renders a settlement for every settlement issued (headed "Recipient created tax invoice" for a producer registered for GST, "Settlement statement" with no GST for one who is not) and a kill sheet for every booking killed, into docs-out/, in the plant's name, colours and logo from brand.json. `npm run view` renders views/week.html (the kill ahead, the yards, settlements held and owed, traceability) and views/plant.html (producers, kill by category, boning yield, levies). `/draft-letter` writes kill sheet covers, agreement renewals, missing declaration requests, payment advices and bruising letters to drafts/. Nothing is ever sent from here.

## Your first hour: ten things to ask for

1. Put our plant name, establishment number, colours and logo in settings and brand.json.
2. Set our payment terms, kill floor capacity and lairage limit.
3. Import our producers, grids and forward bookings from MeatPro, test run first.
4. Check our levy rates against the current schedules.
5. Which producers have no buyer-created invoice agreement on file?
6. Show me what needs attention.
7. What is on the kill agenda for tomorrow, and is anything held?
8. Load today's kill file onto booking B1011.
9. Which settlements can I issue today?
10. Write this week's plant review.

## Instead of Fujitsu MeatPro

Export your vendor list, your price grids and your open bookings from MeatPro as spreadsheets (Business Central, which MeatPro runs on, opens most lists in Excel), save them as CSV in one folder and run:

```bash
npm run plant -- import meatpro imports/cutover --dry-run
npm run plant -- import meatpro imports/cutover --actor="Your name"
```

Each field accepts the column names Business Central and MeatPro lists commonly use. Layouts depend on how your MeatPro is set up, so check yours against the list in [the switching guide](docs/replace-meatpro.md) and rename any that differ (or ask Claude Code to). A problem anywhere refuses the whole import and writes nothing. Past kills and settlements stay in MeatPro's archive; this picks up from the cutover.

## Architecture

```
meat-processing-for-claude-code/
  CLAUDE.md                 how the operator wants this run (routing table + house rules)
  AGENTS.md                 the same, for Codex / OpenCode / Cursor / Gemini CLI
  .claude/commands/         the slash commands
  scripts/                  the CLI the commands drive
  scripts/lib/db.mjs        one adapter: DATABASE_URL (pg) or embedded PGlite
  supabase/migrations/      plain SQL schema
  supabase/seed.sql         demo data
  docs/                     the thesis and the migration guide
```

## Built for coding agents

The database, CLI and command recipes work with Claude Code, Codex, OpenCode or Cursor. Ask your coding agent for a new command and have it implement and test the change against the same records.

## Contributing

Issues and pull requests are welcome. Keep the shape: plain SQL, a small CLI, a slash command per recurring job, no front end.

## Want it installed and run for you?

Enterprise DNA installs Meat Processing for Claude Code for your business, migrates your Fujitsu MeatPro data, connects it to the rest of your tools, and runs it for you as part of **Omni**, our managed Command Center. One setup fee, then a monthly retainer.

- Book a call: [enterprisedna.co/omni/book](https://enterprisedna.co/omni/book/?offer=replace-software&utm_source=github&utm_medium=readme&utm_campaign=meatpro)
- Read more: [enterprisedna.co/omni/instead-of/meatpro](https://enterprisedna.co/omni/instead-of/meatpro?utm_source=github&utm_medium=readme&utm_campaign=meatpro)

## License

MIT. Copyright (c) 2026 Enterprise DNA.
