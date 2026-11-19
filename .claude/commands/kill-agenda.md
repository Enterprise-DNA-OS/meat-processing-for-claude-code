---
description: The kill agenda for a day: every mob booked, what has arrived, against kill floor capacity, with any mob that must be held.
---

Run `npm run plant -- agenda [<date>] --json` (today if no date). Show the mobs, the totals against capacity, and the holds first: a mob with no vendor declaration or inside a withholding period is not killed until cleared. If the day is over capacity, say which bookings could move.
