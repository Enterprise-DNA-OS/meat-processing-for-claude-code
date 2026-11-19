---
description: Bring producers, price grids and forward bookings across from MeatPro.
---

Read `docs/replace-meatpro.md`. Put suppliers.csv (and grids.csv and bookings.csv if you have them) in a folder. Run `npm run plant -- import meatpro <folder> --dry-run --json` and compare the counts with MeatPro's own lists. With a yes, run it without `--dry-run` and with `--actor="Name"`. A problem anywhere refuses the whole import.
