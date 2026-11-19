# Moving from Fujitsu MeatPro

MeatPro runs on Microsoft Dynamics 365 Business Central, and Business Central opens most lists in Excel. Save three lists as CSV in one folder and import them. Past kills, settlements and ledgers stay in MeatPro (keep read access, or export them for the archive): this system picks up from the cutover.

## 1. Export

| File | From MeatPro | Needed |
|---|---|---|
| `suppliers.csv` | The vendor (producer) list | Yes |
| `grids.csv` | The price schedules or grids in use, one row per band | No: you can enter grids by asking Claude Code |
| `bookings.csv` | Open bookings with a kill date after the cutover | No |

Do the export at the end of a kill day, after the last settlement has been issued in MeatPro.

## 2. Test run, then import

```bash
npm run plant -- import meatpro imports/cutover --dry-run
npm run plant -- import meatpro imports/cutover --actor="Your name"
```

The test run prints the number of suppliers (and how many have no invoice agreement date), grid lines, bookings and head booked. Compare them with MeatPro's own list counts before you import. Anything wrong anywhere (a booking naming a supplier that is not in the file, a supplier code already here, a grid line with no price) refuses the whole import and writes nothing.

## 3. What maps

Column names are matched without regard to case. The first name in each list that is present wins.

**suppliers.csv**

| Field here | Column names accepted |
|---|---|
| code | No., No, Vendor No., Supplier Code, Code |
| name | Name, Vendor Name, Supplier Name |
| ABN or NZBN | ABN, NZBN, VAT Registration No., Business Number |
| registered for GST | GST Registered, Registered for GST, GST Reg (yes/no; blank means yes) |
| property (PIC or NAIT) | PIC, Property Identification Code, NAIT Number, NAIT Location |
| quality assurance | LPA, LPA Number, QA Number |
| agreement signed / ends | RCTI Agreement Date, RCTI Signed, Agreement Signed / RCTI Expiry, RCTI Agreement Expiry, Agreement Expires |
| region, contact, email, phone | City, Region, Town / Contact, Contact Name / E-Mail, Email / Phone No., Phone |
| bank account | Bank Account No., Bank Account (only the last four digits are kept) |

**grids.csv**: Grid Code (or Schedule Code, Price Schedule), Species, Category (or Class), Min Weight, Max Weight, Min Fat, Max Fat, Max Teeth (or Dentition), Price c/kg (or Cents per kg), Valid From. Rows are kept in file order: a carcase takes the first band it fits.

**bookings.csv**: Booking No., Vendor No., Species, Head, Kill Date, Grid Code. A booking with no grid code takes the grid valid for its species on the kill date.

Dates can be YYYY-MM-DD or DD/MM/YYYY.

## 4. What does not carry over

- Past kill sheets, settlements and payments. Keep them in MeatPro's archive.
- Agent commission rates and freight per booking: add agents with `/onboard` or by asking, and set freight when you book.
- Bank account numbers in full: this system keeps the last four digits only, to match a payment advice. Payments are made from your bank.
- The floor systems: scales, grading and carton labelling keep running. Each day's kill file comes in through `/kill`.
- Your layout may differ from these names, depending on how your MeatPro was set up. Rename the columns, or ask Claude Code to map yours. Mapping your exact export is part of what Enterprise DNA does when it moves you across.

## 5. After the import

1. `/suppliers`: check every registered producer has an agreement date. Record missing ones with `/agreement`.
2. `/levies`: check the rates against the current schedules.
3. Set payment terms, kill floor capacity and the lairage limit in `settings`.
4. Load the first kill file with `/kill`, test run first, and compare the settlement with what MeatPro would have paid.
