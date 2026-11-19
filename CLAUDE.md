# Meat Processing for Claude Code: operating instructions

This file is the brain. Claude Code reads it at the start of every session. It says who this is for, how work gets done, and the one right way to do each recurring job.

## Who this is for

- **Plant:** [YOUR PLANT] (the demo is Tablelands Meat Co, fictional)
- **Operator:** [YOUR NAME], [your role: livestock buyer, plant office, accounts, plant manager]
- **What matters most:** every head accounted for from the yards to the settlement, every producer paid right and on time, and nothing killed or settled without its vendor declaration and paperwork

Fill this in once. A worker with context knows. A worker without it guesses.

## How to work

1. **Take a brief, not a script.** The operator describes the outcome. You run the right command and present the answer.
2. **Read before you write.** Before drafting anything about a record, read its full history first.
3. **Plain language.** Short sentences. No filler. Numbers in tables.
4. **Silent success, loud problems.** No play-by-play. Say what broke and what you did about it.
5. **Stop at the line.** Anything that sends, deletes, or faces a customer waits for a yes in this session.

## Routing table: one right way for each recurring job

| When the operator asks for... | Use this |
|---|---|
| issue an adjustment to a settlement already issued: a price agreed late, a regrade, a correction | `/adjust` |
| stock agents, their commission per head and the head they bring in | `/agents` |
| record a producer's signed buyer-created tax invoice agreement, or its renewal | `/agreement` |
| record a mob arriving at the yards, with its vendor declaration | `/arrive` |
| what needs doing now across the plant: holds, late payments, settlements held, traceability reports, capacity, bruising and yields | `/attention` |
| record a boning run: carcase kilograms in, saleable kilograms out, fat and bone, cartons | `/boning` |
| book a producer's stock in to kill, on the grid valid for the kill date | `/book` |
| bookings in a date range, with head booked, arrived and killed and the settlement | `/bookings` |
| what is coming up: agreements and accreditations ending, settlements due, the kill ahead, levy rates due a check | `/calendar` |
| cancel a booking before the stock arrives | `/cancel` |
| one day's kill by species and category: head, average weight, price, condemned and off grid | `/carcases` |
| check the records against vendor declarations, withholding periods, the 48-hour traceability report, buyer-created invoice rules, quality assurance and the plant's lairage limit, each finding cited | `/compliance` |
| record a condemnation the inspector made | `/condemn` |
| make this system yours in plain language. Add a field, rename stages, change a rule, add a column to a document. Writes the migration, applies it, updates the commands that touch it | `/customise` |
| record a vendor declaration that arrived after the stock | `/declaration` |
| render the paperwork: a settlement (recipient created tax invoice, or settlement statement) per settlement, and a kill sheet per booking | `/documents` |
| draft a letter to a producer: kill sheet cover, invoice agreement renewal, missing declaration, payment advice, or bruising and condemnations | `/draft-letter` |
| what the plant owes producers: settlements to pay with days late, and killed bookings not yet settled | `/due` |
| export every record to one JSON file | `/export` |
| send a producer their kill sheet: a short covering note and the kill sheet document | `/feedback` |
| one price grid line by line: categories, weight and fat bands, dentition, cents per kilogram and the discounts | `/grid` |
| the price grids, with their species, dates and price range | `/grids` |
| every CLI command and its arguments | `/help` |
| who changed what, and when | `/history` |
| put a producer on hold (no new bookings, no payments) or clear the hold | `/hold` |
| bring producers, price grids and forward bookings across from MeatPro | `/import` |
| the kill agenda for a day: every mob booked, what has arrived, against kill floor capacity, with any mob that must be held | `/kill-agenda` |
| the kill sheet for one booking: the summary by category and every carcase with its price | `/kill-sheet` |
| load the day's kill file from the scales or grading system onto a booking: test run, then record | `/kill` |
| levy rates with their sources and the date each was checked, and levies deducted from producers by month | `/levies` |
| a note on a producer or a booking: a call, a complaint, a promise | `/log` |
| add a read-only HTML view (a dashboard page) from a plain-language description, rendered in the operator's brand by `npm run view` | `/new-view` |
| carcases no grid line fits, with the nearest line, so a price can be agreed | `/off-grid` |
| set up a new producer: the record, the buyer-created invoice agreement and quality assurance | `/onboard` |
| record that the bank has paid a settlement | `/pay` |
| each producer's last 90 days: average weight, price per kilogram, bruising, dark cutters, condemnations and what the discounts cost them | `/performance` |
| what each producer was really paid per kilogram over 90 days, and why: weight, fat, age and discounts | `/price-check` |
| correct a carcase's weight, fat score, teeth, bruise score, category or dark cutting before the booking is settled | `/regrade` |
| issue a producer's settlement for a booking (the buyer-created tax invoice): test run, then issue | `/settle` |
| one settlement line by line: carcases, GST, levies, freight, commission and the net | `/settlement` |
| settlements issued in the last 60 days, with gross, GST, deductions, net and whether paid | `/settlements` |
| everything about one producer: details, agreement, quality assurance, 90-day performance, bookings, unpaid settlements and notes | `/supplier` |
| every producer: status, agent, buyer-created invoice agreement end, 90-day head, price and bruising | `/suppliers` |
| forward bookings per day against the kill floor's capacity for the next four weeks | `/supply` |
| kill dates not yet reported to NLIS or NAIT as slaughtered, and how close each is to the 48-hour limit | `/trace` |
| render the read-only dashboards: this week on the kill floor, and plant performance | `/views` |
| the Monday plant review, written from the attention list, the money owed to producers and producer performance | `/weekly-review` |
| stock in the yards now: hours since arrival, hours off feed, declaration and withholding status | `/yards` |
| boning yield by week and species, and any drop worth looking at | `/yields` |

If an ask fits nothing here, run the CLI directly (`npm run plant -- help`) and then propose a new command for it.

## Hard rules

- Never send email or messages from here. Draft to `drafts/`, a person sends.
- Never delete records without an explicit yes in this session. Prefer marking closed or archived.
- Never invent a record. If a name is ambiguous, list the candidates and ask.
- The database is the source of truth. If the answer is not in it, say so.
- Every write names a person (`--actor` or `PLANT_ACTOR`). Never invent an actor, a weight, a declaration number, a payment or an agreed price.
- Never record a vendor declaration, a condemnation, an agreed off-grid price or a payment the operator has not given you. These come off a form, an inspector, a phone call with the producer, or the bank.
- Never run `settle`, `pay`, `adjust` or `kill` (without `--dry-run`) without a yes in this session.
- An issued settlement is a tax invoice and never changes. Corrections are adjustments.
- A mob with no declaration, or inside a withholding period or export slaughter interval, is held. Say so plainly; never suggest killing it.
- This system pays no one and uploads nothing. Payments go out through the bank and kill data to NLIS or NAIT; record them after they happen.
- Read docs/compliance.md before answering a question about what the law requires. Do not guess at law.

## Where things live

- `scripts/` the CLI. `scripts/lib/db.mjs` picks `DATABASE_URL` (Postgres, Supabase) or the embedded database in `.data/`.
- `supabase/migrations/` the schema, plain SQL. `npm run migrate` applies it.
- `.claude/commands/` the slash commands. Add one every time the same ask comes twice.
- `docs/` the thesis, the compliance rules and the guide for moving off Fujitsu MeatPro.

Built by Enterprise DNA. Installed and run for you as part of Omni: https://enterprisedna.co/omni/instead-of/meatpro
