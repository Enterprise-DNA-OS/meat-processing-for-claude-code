---
description: Load the day's kill file from the scales or grading system onto a booking: test run, then record.
---

The operator gives a CSV from the scales (body number, tag, category, hot weight, fat, teeth, bruise, dark cutter, condemned). Run `npm run plant -- kill <booking> <file.csv> --dry-run --json` first and show the count, kilograms and condemnations. With a yes, run it without `--dry-run` and `--actor="Name"`. Report what came out off grid and any head still unaccounted for.
