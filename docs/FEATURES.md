# Explain My Money — Feature Inventory

Every user-facing feature, where it lives, and how it is verified.
Suites: `tests/e2e.node.js` (57), `tests/new-modules.node.js` (25),
`tests/pdf-parse.node.js`, `tests/v2.node.js` (132), `tests/browser-smoke.py`
(real Chromium, local-only, not run in CI).

Conventions: local-first (zero network for financial data), integer minor
units everywhere (`parseFloat` never touches money), ES2019 only.

## Shell & tabs

| Feature | Where (file + function) | Verified |
|---|---|---|
| 6 tabs: Month, Statement, Plan, Ask, Add, More | `apps/web/js/app.js` `App.render`, `TABS`; tab bar in `apps/web/index.html` | browser smoke ("boot: 6 tabs render") |
| Tab routing + global event delegation (`data-action`/`data-change`) | `app.js` `App.Actions['tab']`, `App.Actions['goto']`, `wireGlobalEvents` | browser smoke |
| First-run starts on the Add tab; otherwise Month | `app.js` `App.boot` | e2e.node.js (boot state) |

## Add tab — import

| Feature | Where (file + function) | Verified |
|---|---|---|
| CSV import — two validated statement layouts | `apps/web/js/parsers.js` + `app.js` `App.Changes['statement-file']` | e2e.node.js (25-row fixture import) |
| Generic CSV fallback for unvalidated layouts (honest "uncertain" rows, never guesses) | `parsers.js` generic reader | pdf-parse style? no — **not yet** automated; manual |
| PDF import — validated CIBC layout (metadata, payments-table sign handling) + generic heuristic reader for any bank layout (honest "uncertain" rows, never guesses) | `parsers.js` CIBC parser + generic PDF reader | pdf-parse.node.js (synthetic; CIBC + generic template); private-PDF checks opt-in (`EMM_PRIVATE_PDF_DIR`) |
| Duplicate-import detection (SHA-256 of file) | `app.js` `sha256Hex`, import commit path | e2e.node.js (`isDup === true`) |
| Import preview before commit (rows, errors, kinds) | `app.js` `App.vImportPreview` | browser smoke ("import: preview shows") |
| 8-stage visible pipeline: Ingest → Extract → Normalize → Classify → Match → Allocate → Reconcile → Explain | `app.js` `STAGE_DEFS`, `App.vProcessing`, `App.setStage` | browser smoke ("import: pipeline completes to Month"); e2e (pipe.done) |
| Manual transaction entry (per-month "Manual entries" account) | `app.js` `App.vManualEntry`, `App.Actions['manual-save']` | **not yet** automated |
| Receipt photo capture + on-device OCR (Tesseract) | `app.js` `App.vReceipts`, `App.Changes['receipt-file']`; `apps/web/js/ocr.js` | new-modules.node.js ("OCR receipt parsing (synthetic)") |
| Receipt ↔ transaction matching (≥0.85 confidence, precision-first) | `app.js` `App.Actions['find-matches'/'confirm-match']`; `engine.js` receipt matching | e2e.node.js (score ≥ 0.85, deterministic, link + coverage) |

## Statement tab

| Feature | Where (file + function) | Verified |
|---|---|---|
| Statement list, statement switcher | `app.js` `App.vStatement`, `App.Changes['statement-select']` | browser smoke |
| Full-text search across description/merchant/category/amount/date | `app.js` `App.Changes['txn-search']`, `App.searchTxns` | v2.node.js (10 searchTxns checks) |
| Pagination, 60 rows per page ("Show more") | `app.js` `App._paginate`, `App.Actions['txn-more']`, `App.TXN_PAGE_SIZE` | v2.node.js (7 _paginate checks) |
| Review queue (needs-review filter) | `app.js` `App.Actions.sfilter` | browser smoke ("statement: list renders") |
| Transaction detail (raw vs normalized, evidence, kind/category editing) | `app.js` `App.vTxnDetail` | browser smoke ("statement: txn detail opens") |
| Corrections: kind, category, exclude-from-spend (audited) | `app.js` `App.Actions['confirm-kind'/'toggle-exclude']`, `App.Changes['kind-select'/'cat-select']` | e2e.node.js (correction → user source) |
| "Make this a rule" from a correction (kind + category rules, auto-applied to future imports) | `app.js` `App.Actions['make-rule'/'confirm-rule'/'cancel-rule']`; `engine.js` `Engine.makeRuleFromCorrection`, `Engine.applyRules` | e2e.node.js (rule created, applied to fresh row) |
| Split a transaction across categories (integer shares, exact-sum enforced) | `app.js` `App.Actions['split-*']`; `engine.js` `Engine.splitEvenly`, `Engine.expandSplits` | v2.node.js (splitEvenly/expandSplits/split-aware totals/briefing) |
| Duplicate-transaction detection + keep / mark-duplicate resolution | `app.js` dup pairs, `App.Actions['dup-keep'/'dup-markdup']` | v2.node.js (dup-cache key); resolution UI **not yet** automated (import-level dedupe covered by e2e) |
| Refund links ("money back" evidence on txn detail) | `app.js` `App.vTxnDetail` (reads `refundLinks` store) | **not yet** automated |
| Balance check: reported vs computed (ok / gap / unavailable — never hidden) | `engine.js` `Engine.reconcile`; `app.js` `App.applyBalanceCheckPolicy` | v2.node.js (policy mapping); e2e (netSpendMinor) |

## Month tab

| Feature | Where (file + function) | Verified |
|---|---|---|
| Monthly briefing in plain language with evidence | `app.js` `App.vMonth`; `engine.js` `Engine.buildBriefing`, `Engine.renderBriefingText` | e2e.node.js (briefing facts + "can't give you a final number" honesty); browser smoke |
| 6-month net-spend trend chart (hand-rolled canvas, no chart lib) | `app.js` `App.trendsHtml`, `App.drawTrends`; `engine.js` `Engine.monthlyNetSpend` | v2.node.js (monthlyNetSpend); **not yet** browser-verified |
| Biggest movers (top-3 month-over-month category deltas) | `app.js` `App.moversHtml` | **not yet** automated |
| Budget progress summary on Month | `app.js` `App.vMonth` (budgets section) | **not yet** automated |
| "This explanation is wrong" → routes to the underlying transactions | `app.js` `App.Actions.wrong` | **not yet** automated |

## Plan tab

| Feature | Where (file + function) | Verified |
|---|---|---|
| Budgets: per-category monthly limits, create/edit/delete/copy-from-previous-month | `app.js` `App.vPlanBudgets`, `App.Actions['budget-*']`, `App.Changes['budget-month']`; `engine.js` `Engine.categorySpendMinor` | v2.node.js (categorySpendMinor, defaultBudgetMonth, parseDollarsToMinor); CRUD UI **not yet** automated |
| Goals: save toward a target, log contributions | `app.js` `App.vPlanGoals`, `App.Actions['goal-*']` | **not yet** automated |
| Subscriptions: recurring-charge detection (monthly/weekly/yearly, price-change flag), dismiss | `app.js` `App.vPlanSubs`, `App.Actions['sub-dismiss']`; `engine.js` `Engine.detectSubscriptions` | v2.node.js (20+ detectSubscriptions checks); UI wiring **not yet** automated |

## Ask tab

| Feature | Where (file + function) | Verified |
|---|---|---|
| Natural-language Q&A with cited transactions (offline templates, deterministic) | `app.js` `App.vAsk`, `App.matchQuestion`, `App.Actions['ask-submit'/'ask-chip']` | e2e.node.js (answer ctx, spend answer, question matching); browser smoke |
| Optional BYO-key AI phrasing (off by default; per-call approval bound to provider URL, model, privacy mode, exact payload) | `apps/web/js/llm.js`; `app.js` `App.Actions['llm-rephrase-answer'/'llm-send-answer'/'llm-rephrase-briefing'/'llm-send-briefing']`, `App.Changes['llm-*']` | new-modules.node.js ("LLM settings", "LLM privacy packets"); browser smoke ("AI phrasing", off-by-default) |

## More tab

| Feature | Where (file + function) | Verified |
|---|---|---|
| Household rules manager (enable/disable, two-tap delete, audit-logged) | `app.js` `App.vRules`, `App.Changes['rule-toggle']`, `App.Actions['rule-delete']` | **not yet** automated (engine rule application covered by e2e) |
| Accounts manager: inline rename (audited), per-account totals ("spent $X across N transactions"), 12-month statement coverage strip with missing-month legend | `app.js` `App.vAccounts`, `App.Changes['account-rename']`; `engine.js` `Engine.monthCovered` | v2.node.js (monthCovered, 13 checks); browser smoke (screen renders, totals, legend) |
| Sample data: deterministic generator (seed 42, 3 months, ~25–35 txns/mo, clearly labeled, honest `unavailable` balance check) | `engine.js` `Engine.sampleData`, `Engine._mulberry32`; `app.js` `App.Actions['sample-add']`, `App.insertSampleData` | v2.node.js (sampleData 16 checks + mulberry32 3 checks); browser smoke (add button present) |
| Remove sample data: two-tap confirm, deletes exactly the `v2-sample` batch | `app.js` `App.Actions['sample-remove']` | v2.node.js (tagging); UI flow **not yet** automated |
| Privacy & data: what's stored where, audit-trail viewer | `app.js` `App.vPrivacy` | browser smoke ("privacy: screen renders") |
| Export: ledger JSON + transactions CSV (offline Blob download) | `app.js` `App.Actions['export-json'/'export-csv']` | e2e.node.js (export data shape); download mechanics **not yet** automated |
| Delete everything (typed `DELETE` confirm, full IndexedDB wipe) | `app.js` `App.Actions['wipe-go']` | e2e.node.js (store empty after wipe) |
| Replay tour | `app.js` `App.Actions['onboard-replay']` | browser smoke (button present) |

## Onboarding

| Feature | Where (file + function) | Verified |
|---|---|---|
| First-run 3-step overlay (Add a statement → See your month → Ask anything), shown only when zero statements and tour never finished/skipped | `app.js` `App.maybeOnboard`, `App.renderOnboarding`, `ONBOARD_STEPS`, `App.Actions['onboard-*']`, `App.finishOnboarding`; CSS `#onboard` in `apps/web/css/styles.css` | browser smoke (overlay shown on first run, Skip dismisses it) |

## PWA / offline

| Feature | Where (file + function) | Verified |
|---|---|---|
| Installable PWA (manifest, icons, "Add to Home Screen") | `apps/web/manifest.webmanifest`, `apps/web/index.html` | **not yet** automated |
| Service worker: offline shell caching, versioned cache cleanup (OCR/LLM vendor blobs lazy, not precached) | `apps/web/sw.js` | browser smoke ("pwa: service worker registered") |
| Zero network for financial data (network audit in smoke test) | whole app; enforced by smoke interceptor | browser smoke ("network: zero requests outside the app server") |

## Notes / known gaps

- Sample data is allowed alongside real statements; sample records are always
  tagged `sampleBatch: 'v2-sample'` (scopeLabel "Sample data · YYYY-MM") and the
  More menu offers one-tap removal. Decisions documented per feature in
  `docs/ARCHITECTURE.md` where relevant.
- "Not yet" items above are honest gaps — no automated coverage claims are made
  for them. Manual verification: see `docs/IOS-TESTING.md`.
