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
