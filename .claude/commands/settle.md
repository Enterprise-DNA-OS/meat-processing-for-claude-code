---
description: Issue a producer's settlement for a booking (the buyer-created tax invoice): test run, then issue.
---

Run `npm run plant -- preview <booking> --json`. Show every line and the net. If anything blocks it (an unaccounted head, a carcase off grid, no declaration, no agreement in date, a hold), list it with the command that clears it and stop. With a yes, run `npm run plant -- settle <booking> --actor="Name"`. Once issued it cannot be edited: corrections are `/adjust`.
