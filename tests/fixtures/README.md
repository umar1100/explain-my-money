# Fixtures

**All files in this directory are 100% synthetic test data.** The institution
("Harbourline Credit Union ····4242"), the merchants, the dates, and every
amount are invented for exercising the Gate 1 prototype. There is no real
customer data here — these files are safe to share, copy, or delete.

`sample_statement_aug2026.csv` is a 25-row August 2026 credit-card statement
with header columns `date,description,amount,currency`, which the generic CSV
importer maps to the pipeline's `raw_date_text`, `raw_description`,
`raw_amount_text`, and `raw_currency` fields. Sign convention: negative =
money out (purchases, fees), positive = money in (refunds, card payments).
All amounts are in CAD.

It is designed to walk the full pipeline: grocery rows (including two Costco
rows that hint at mixed-merchant categorisation), a restaurant, a subscription
(NETFLIX.COM), an Amazon purchase, a `COSTCO REFUND` row, a
`PAYMENT RECEIVED - THANK YOU` row (excluded from spend), an
`INTERAC E-TRANSFER SENT` row, an `ANNUAL FEE` row, and one deliberately
ambiguous `MISC ADJUSTMENT 0882` row that should land in the CLI's
REVIEW QUEUE rather than being silently classified.
