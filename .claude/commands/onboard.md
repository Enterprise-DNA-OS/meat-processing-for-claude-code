---
description: Set up a new producer: the record, the buyer-created invoice agreement and quality assurance.
---

Ask for code, name, ABN or NZBN, GST registration, property identification code (PIC) or NAIT number, LPA or farm assurance number and end date, agent, contact and the last four digits of the bank account. Run `npm run plant -- add-supplier <CODE> --name= ... --actor="Name"`, then `npm run plant -- agreement <CODE> --signed= --expires=` once the agreement is signed (registered suppliers only), then `npm run plant -- qa <CODE> --no= --expires=`. Draft the agreement letter with `/draft-letter <CODE> agreement` if it is not signed yet.
