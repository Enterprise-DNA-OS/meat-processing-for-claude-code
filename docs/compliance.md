# Compliance rules this system checks

`/compliance` (and `npm run plant -- compliance`) checks the records against the rules below. Each rule says where it comes from, what a breach looks like in the data, and what the check does. Sources were read on 19 November 2026. Rules and rates change: confirm each one against its source before you rely on it, and update this file and the check together.

This is not legal advice. It records the rules the plant has told the system to enforce, with their sources.

## 1. A vendor declaration with every consignment

- **Australia:** "The current LPA National Vendor Declaration (LPA NVD) is required for all livestock movements", including direct to processors. Source: Integrity Systems Company, [Processors](https://www.integritysystems.com.au/processors).
- **New Zealand:** "You must complete an ASD form if you move any of these animals to another property, a saleyard or for processing", except bobby calves. Source: OSPRI, [About Animal Status Declarations](https://www.ospri.co.nz/farmers-and-livestock-owners/moving-animals/animal-status-declarations-asds/about-animal-status-declarations-asds).
- **Breach:** an arrival with `declaration_received` false.
- **What the system does:** lists it as a breach, holds the mob on the kill agenda, and refuses the settlement until the declaration is recorded (`/declaration`).

## 2. No slaughter inside a withholding period or export slaughter interval

- An export slaughter interval is the "minimum time that should elapse between administration of a veterinary medicine to animals and their slaughter for export". Source: FutureBeef, [Export slaughter intervals and chemical withholding periods](https://futurebeef.com.au/resources/export-slaughter-intervals-and-chemical-withholding-periods/). The vendor declaration asks the producer to declare treatments inside these periods.
- **Breach:** an arrival recorded with `withholding_clear` false.
- **What the system does:** lists it as a breach and holds the mob on the kill agenda. The decision on the animals is the plant's and the inspector's.

## 3. Report slaughter to NLIS or NAIT within 48 hours

- **Australia:** processors "report all movements of cattle, sheep, goats and pigs to the NLIS database within 48 hours of slaughter", with the tag, the property the animal came from, carcase and chain numbers, kill date and establishment number. Source: Business Queensland, [NLIS for abattoirs](https://www.business.qld.gov.au/industries/farms-fishing-forestry/agriculture/livestock/nlis/abattoirs). Wording may differ by state; check your state's NLIS rules.
- **New Zealand:** processors "must declare animal death information for each animal processed at your location to NAIT", and "You must do this within 48 hours from the date of slaughter." Source: OSPRI, [Recording slaughter information](https://ospri.co.nz/farming-industry-providers/meat-processors/recording-slaughter-information).
- **Breach:** carcases with no `trace_reported_at` more than `settings.trace_report_hours` (48) after the start of the kill date. The check counts from midnight of the kill date, so it warns early rather than late.
- **What the system does:** lists each unreported kill date with the hours left; `/trace` and `reported` record the upload reference. It never uploads anything itself.

## 4. A current agreement before a buyer-created tax invoice

- **Australia:** A New Tax System (Goods and Services Tax): Recipient Created Tax Invoice Determination 2023 ([F2023L00785](https://www.legislation.gov.au/F2023L00785/asmade/2023-06-14/text/original/epub/OEBPS/document_1/document_1.html)). Both parties must be registered for GST. The written agreement must "specify the taxable supplies to which it relates" and "be current when an RCTI is issued", and must state that "the recipient can issue RCTIs in respect of the supplies" and "the supplier will not issue tax invoices in respect of the supplies". The determination sets no fixed term; the plant's own agreements set an end date.
- **New Zealand:** "any GST registered buyer purchasing from a GST registered seller can provide buyer-created taxable supply information", with no Inland Revenue approval needed since 1 April 2023, provided both agree that only the buyer issues it. Source: Inland Revenue, [Buyer-created taxable supply information](https://ird.govt.nz/gst/tax-invoices-for-gst/buyer-created-taxable-supply-information).
- **Breach:** a supplier registered for GST with no `agreement_signed_on`, or an `agreement_expires_on` in the past. Due soon: ending within `settings.agreement_warn_days` (60).
- **What the system does:** the database refuses to issue a settlement to a registered supplier without an agreement in date. A supplier not registered for GST gets a settlement statement with no GST instead, and needs no agreement.

## 5. The buyer-created invoice reaches the producer within 28 days

- **Australia:** the RCTI goes to the supplier "within 28 days" (Determination 2023, section 7) and is kept "for five years".
- **Breach:** a booking killed more than 28 days ago with no settlement. Due: more than 21 days.
- **What the system does:** lists it. Settlements are never deleted, so the five-year record is the database itself (back it up).

## 6. Quality assurance accreditation in date

- Livestock supplied for processing in Australia comes from properties accredited under the Livestock Production Assurance programme, whose NVD the producer signs. Source: Integrity Systems Company, [Processors](https://www.integritysystems.com.au/processors). In New Zealand, record the farm assurance programme your plant requires.
- **Breach:** an active supplier with no `quality_assurance_no`, or a `quality_assurance_expires_on` in the past.
- **What the system does:** lists it for the livestock buyer to chase before the next booking.

## 7. Time in the yards (plant welfare policy)

- The plant sets `settings.lairage_max_hours` (24 in the demo) from its own animal welfare programme and the standard it is audited against. This is the plant's policy, not a figure from law: set it to yours.
- **Breach:** a mob arrived and not yet killed for longer than the limit.
- **What the system does:** lists it and shows hours in the yards and hours off feed on `/yards`.

## 8. The declaration matches the producer

- The property on the declaration (PIC or NAIT number) should be the producer's own. A mismatch means stock from another property, which changes what the NLIS or NAIT report must say.
- **Breach:** `arrivals.property_id_declared` differs from `suppliers.property_id`.

## 9. Levy rates checked

- **Australia:** levies are imposed under the Primary Industries (Excise) Levies Act 2024 and collected under the Primary Industries Levies and Charges Collection Act 2024, with the processor as collection agent. Cattle: "All other cattle $5.00 per head" ([cattle transaction levy](https://www.agriculture.gov.au/ag-farm-food/levies/rates/cattle-livestock-transaction)). Lambs: 2% of the sale price from $5 to $75 a head, $1.50 a head over $75. Sheep: 2% from $5 to $10 a head, 20 cents a head over $10 ([sheep and lamb transaction levy](https://www.agriculture.gov.au/agriculture-land/farm-food-drought/levies/rates/sheep-and-lamb-transaction)). The demo loads these.
- **New Zealand:** Commodity Levies (Meat) Order 2021. For 2025 to 2026, excluding GST: "all sheep slaughtered 75 cents per head", "all cattle slaughtered (including beef cattle and dairy cattle but excluding bobby calves) $5.20 per head". Source: [Beef + Lamb New Zealand, current levies](https://beeflambnz.com/about/your-levy-organisation/current-levies). Load these as `per_head` rates in `levy_rates` for a New Zealand plant.
- **Due:** a rate last checked more than a year ago.
- **What the system does:** deducts each active rate on every settlement, shows the source and date on `/levies`, and totals what was deducted by month.

## Plant policies (not law)

Payment terms (`payment_days`), the kill sheet turnaround (`feedback_days`), kill floor capacity, the bruising and condemnation watch levels and the lairage limit are the plant's own settings. Change them with `/customise`.
