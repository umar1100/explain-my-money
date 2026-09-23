# Architecture

Adapted from the Application Design (Sept 2026) for a zero-backend,
installable web app. All trust boundaries from the design are preserved;
only the deployment shape changed (static PWA instead of Python localhost).

## Layers

```
┌─────────────────────────────────────────────────────────┐
│ PRESENTATION  apps/web: 6 screens, evidence drawers     │
│               Your Month · Clean statement · Ask ·       │
│               Add · Processing · Settings               │
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│ DETERMINISTIC DOMAIN ENGINE  js/engine.js (validated)    │
│ Normalize · Classify · Match · Allocate · Reconcile ·   │
│ Briefing facts · Q&A queries · Rules · Audit log        │
│ The engine owns ALL financial truth. Works fully offline│
└───────────────────────┬─────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────┐
│ ADAPTERS (typed interfaces, outside the core)            │
│ parsers.js  PC Financial + CIBC Costco PDF templates (exact),│
│             generic heuristic PDF reader, generic CSV mapper,│
│             file hashing                                     │
│ ocr.js      On-device receipt OCR (vendored Tesseract)   │
│ llm.js      Optional BYOK phrasing; inert by default    │
│ store.js    IndexedDB persistence, localStorage fallback│
└─────────────────────────────────────────────────────────┘
```

## The AI boundary

The language model may **explain** facts; it may never **establish** them.
`llm.js` receives only an evidence packet (precomputed totals, deltas,
contributing IDs, confidence) — never raw account identifiers, never the
full ledger. Model output is presentation-only: it cannot reclassify a
transaction, change a total, or write ledger state. With no key configured
(the default), the app serves deterministic wording and every feature works.

## Storage

IndexedDB holds the ledger (source files metadata, statements,
transactions, receipts, matches, allocations, rules, corrections, audit
events, briefings). Receipt images are stored as blobs in IndexedDB.
A localStorage fallback covers private-browsing modes. Export (JSON/CSV)
and full wipe are one-screen actions in Settings.

(Design note: the Sept 2026 design specified SQLCipher for a Python
backend. In this zero-backend web shape there is no application-level
encryption equivalent: IndexedDB is origin-scoped storage protected by the
device/browser security model (same as any app's local data on the phone) —
it is NOT SQLCipher-equivalent encryption, and we don't claim it is. The
trust boundary that matters here is different: data never leaves the device,
there is no server copy to breach, and deletion is a predictable cascade.)

## Processing pipeline (8 idempotent stages)

Ingest → Extract → Normalize → Classify → Match → Allocate →
Reconcile → Explain. Each stage persists a checkpoint; re-importing the
same file (SHA-256) is a no-op; re-running after rule changes writes
audit events, never silent rewrites.

## Key invariants (enforced in code)

- Raw extracted values are immutable; normalization writes new fields.
- Payments and transfers are not purchases by default.
- Every normalized row links to its source file + page/row.
- Allocations for a transaction sum exactly to its spend amount.
- Refunds reduce net spending but remain visible as events.
- `Net spending = gross purchases − linked/unlinked refunds.`
- Corrections create audit events and may create scoped, reversible rules.

## Canonical spend accounting (v16)

One computation feeds every Home/Month figure (hero, category bars,
briefing, receipt coverage, movers, per-account totals, trends, Ask
answers, reconciliation strip). There is no per-view spend math.

Stored rows arrive in two amount-sign conventions, and the ledger keeps
each row's printed sign as-is. Every row carries its `signConvention`
provenance stamp (`pdf-card` for PDF card statements, `csv` for CSV
imports and manual entries), set at import and backfilled once for older
rows by a boot migration:

- PDF imports (e.g. President's Choice): purchases positive, refunds/payments negative.
- CSV imports and manually added rows: purchases negative, refunds/payments positive.

Canonical rules (`Engine.canonicalSpendMinor`, `Engine.spendMagnitudeOf`,
`Engine.purchaseSignContradicts`):

- genuine purchase → +|amount| (spend magnitude)
- refund → −|amount| (reduces spend)
- mis-signed purchase (v17: kind=`purchase` but the stored sign contradicts
  the row's `signConvention` — a credit the keyword rules didn't catch) →
  −|amount| (a *statement credit*: reduces spend, never adds to it)
- payment / transfer / fee / cash advance / uncertain → 0 (money movement, never spend)
- excluded / duplicate rows → 0 (invisible to every spend figure)

Rows whose kind a human set explicitly (`classificationSource` `user` or
`manual`) are trusted as-is and never treated as statement credits.

`Engine.reconcile()` reports `grossPurchasesMinor` (genuine purchases only),
`refundsTotalMinor` (always ≥ 0), `statementCreditsMinor` /
`statementCreditCount` (v17, always ≥ 0), and
`netSpendMinor = gross − refunds − statementCredits`. All user-facing
spend labels show magnitudes (`You spent $X`, never `You spent -$X`); a
negative net is labeled **Net credit** honestly instead of "Net spend".
`excludedTotalMinor` is the sum of printed magnitudes left out of spend —
informational only, never subtracted.

View inclusion rules:

- Hero build-up always resolves: purchases − attributed refunds − statement credits = net.
- Category bars net refunds and statement credits (same figures the movers compare); their
  signed sum equals the unattributed net. A net-negative category is tagged "credit".
- Receipt coverage denominator is the canonical genuine-purchase gross over the
  same rows — identical to the hero's purchases figure (statement credits excluded).
- Biggest movers compare net category totals and say plainly when there
  is no previous-month baseline (never deltas vs zero).
- Plan budgets count genuine purchases *before refunds* (split-aware, statement
  credits excluded) and are labeled as such; the Home bars net refunds out.
- Cash advances are money movement (like ATM withdrawals): excluded from
  spend, shown separately.
