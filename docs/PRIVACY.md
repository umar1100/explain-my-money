# Privacy & Deletion — Gate 1 Contract (on-device)

This is the operative privacy contract for the prototype. It applies to Gate 1 now, not to some
future production release. Concrete behaviors, in this order.

**The one-line guarantee:** your financial data never leaves your device. There is no server,
no account, no sync, no telemetry. The only exception is the *optional* BYO-key LLM phrasing
(section 4) — disabled by default, with a pre-send scope preview, and nothing is sent until
you explicitly approve it.

## 1. Where data lives

- **On-device app (`web/`):** all records live in the phone browser's IndexedDB
  (`emmdb` database, 16 object stores mirroring the ledger data model), with a localStorage
  fallback where IndexedDB is unavailable. Receipt images are stored as blobs in the same
  on-device storage. Nothing is transmitted anywhere: the app makes zero network calls
  for financial processing and storage after the page loads (no CDNs, no fonts,
  no analytics — verifiable by inspecting the source). The sole exception is the
  optional bring-your-own-key AI phrasing (off by default), which contacts only
  the provider URL you configure, only after you preview and approve the exact
  payload for that call.
- **Validation harness (Python, this workspace):** plain SQLite files you create explicitly
  (e.g. `/tmp/ledger.db`). The sample PDFs under `~/workspace/user/files/` are read-only
  inputs for parser development and are never copied into code, fixtures, or docs.

## 2. Deletion protocol

**In the app:** More → Privacy → "Delete everything" (typed confirmation) wipes all on-device
stores — transactions, receipts, rules, corrections, audit trail, briefings — in one action.
Deleting a single source (statement or receipt) removes its transactions, match links,
allocations, and refund links, and unlinks (never deletes) other sources' data.

**Cascade order** (this order, every time):

1. `matches` whose transaction belongs to the source's statements — removed.
2. `refundLinks` touching the source's transactions — removed.
3. `allocations` for the source's transactions — removed.
4. `receipts` from the source (if a receipt file), plus line items — removed.
   Note: receipts matched to a *different* surviving statement's transactions are only
   unlinked, not deleted — deleting a receipt does not delete someone else's statement data.
5. `txns` for the source's statements — removed (raw and normalized together).
6. `statements` for the source — removed.
7. `sourceFiles` row — removed.
8. **Retained, marked:** any household rule learned from a deleted correction keeps its
   condition/action (e.g. `"AMZN" -> household`) but its provenance is rewritten to
   `"learned from deleted source"`. The raw transaction, merchant text, and correction that
   seeded it do not survive.
9. **Recorded:** an audit event records the source file's hash, original name, deletion
   timestamp, and the counts removed at each step. It records that a deletion happened —
   never the deleted content.

**What the user is told before confirming:** the file name, period covered, transaction count,
receipt count, number of rules that will lose their provenance link (with human-readable scope
descriptions), and that the deletion is permanent and cannot be undone.

## 3. Redaction at import

- Account numbers are truncated to **last4 at import**. The full PAN never enters storage,
  logs, or audit events.
- Unnecessary identifiers are dropped at the parser level: statement reference numbers, auth
  codes, and loyalty IDs are not extracted. If a future parser needs one, it is named in the
  fixture and reviewed before use.
- Raw description text *is* kept (it is the classification evidence), but it lives only in
  on-device storage — it never leaves the device.

## 4. The only exception: optional BYO-key LLM phrasing

- **Default: offline.** Briefings and answers are computed deterministically on-device.
- The AI-phrasing toggle is **disabled** until the user provides their own API key. Enabling it
  shows a **pre-send scope preview**: exactly which fields would leave the device (aggregated
  facts only — totals, deltas, category names — never raw account numbers, never the full
  transaction table, never credentials), to which provider, with what stated retention.
- Nothing is sent until the user approves that specific preview. Model output is
  presentation-only: it cannot recompute totals, reclassify transactions, or rewrite ledger
  state. Denying or revoking the key returns the app to fully offline behavior.

## 5. Export

One action, one complete archive, initiated by the user from the Privacy screen:

- **Ledger JSON** — transactions, allocations, categories, household rules, audit trail:
  everything needed to verify or migrate.
- **Transactions CSV** — the clean statement as a flat file.

There is no partial or "settings only" export that hides state. Exports are files the user
saves; they are never uploaded anywhere by the app.

## 6. Local-first guarantees

- **Zero outbound network connections** in default operation. No update checks, no telemetry,
  no crash reports, no cloud OCR fallback, no LLM calls. Verifiable: the app's source contains
  no `fetch`/`XMLHttpRequest`/external URLs, and it works with the device offline.
- **API keys (future/optional):** live in OS key storage when the platform supports it, never in
  the ledger database, never in logs, never in exports.
- **No account, no sync.** There is nothing to opt out of because nothing is collected.

## 7. Retention minimalism

- Keep only what the ledger needs: extracted transactions, their provenance (source file,
  page/row), rules, corrections, audit events, generated briefings.
- Derived artifacts (briefings, evidence packets) are recomputable from the ledger and may be
  regenerated rather than stored indefinitely.
- **Define deletion before importing real data.** This file exists precisely so the deletion
  behavior is specified, tested, and confirmed before any real statement touches the prototype.

## 8. What Gate 1 does not yet do

- No per-field redaction UI; redaction rules are parser-level and fixed.
- No multi-device anything, so no sync-conflict or remote-wipe story exists.
- The harness CLI currently implements `run` only; harness-side export/deletion helpers are
  follow-ups — the app's Privacy screen is the operative deletion path in Gate 1.
