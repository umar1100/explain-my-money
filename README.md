# Explain My Money

**Know where your money went — without connecting your bank.**

Upload credit-card statements (PDF/CSV) and optional receipts. The app
reconstructs your actual household spending on-device, shows its work at
every stage, and explains the month in plain language with evidence behind
every claim.

## Privacy contract

- **All data stays on this device.** Parsing, OCR, classification,
  matching, briefing, and storage run locally. No account, no cloud sync,
  no analytics, no telemetry.
- **Static hosting serves code only.** The deployed site contains no
  personal data.
- **AI is optional and bring-your-own-key.** The deterministic engine owns
  all facts; a language model may only phrase them, never compute them.
  Every outbound payload is previewed and confirmed first. See
  `docs/PRIVACY.md`.

## Project layout

```
apps/web/            The installable web app (this is what deploys)
  index.html         App shell — 6 screens, bottom tab bar
  manifest.webmanifest / sw.js / icons/   PWA packaging
  css/styles.css
  js/
    app.js           Screens, navigation, evidence drawers
    engine.js        Deterministic core: normalize → classify → match →
                     allocate → reconcile → briefing → Q&A (validated)
    parsers.js       Statement parsers: PC Financial + CIBC Costco PDF
                     templates, generic CSV (validated)
    store.js         IndexedDB persistence (localStorage fallback)
    ocr.js           On-device receipt OCR (vendored Tesseract.js)
    llm.js           Optional BYOK phrasing adapter (inert by default)
  vendor/            pdf.js, Tesseract.js + WASM + eng.traineddata (vendored,
                     zero network at runtime)
tests/               Synthetic fixtures + node test suites
docs/                PRIVACY.md, ARCHITECTURE.md, DEPLOY.md, IOS-TESTING.md
.github/workflows/  pages.yml (GitHub Pages deploy), test.yml (CI)
```

## Quick start

```bash
# Serve locally (any static server; the app needs http(s), not file://)
cd apps/web && python3 -m http.server 8080
# → http://localhost:8080
```

## Deploy

See `docs/DEPLOY.md` — push to GitHub, enable Pages with the included
workflow. No build step.

## Test on iPhone

See `docs/IOS-TESTING.md` — Safari → Add to Home Screen, full checklist.

## Validation status

Shipped in this repo (run from the repo root; CI-safe, no network, no private data):
- `tests/e2e.node.js` — 57/57 end-to-end integration checks pass
  (import → pipeline → briefing → Ask → corrections/rules → receipts →
  audit → export → wipe, against the real `engine.js` + `app.js`).
- `tests/new-modules.node.js` — OCR receipt-parser and LLM privacy-adapter
  checks pass (synthetic data only; AI path never touches the network).
- `tests/pdf-parse.node.js` — synthetic parser detection checks pass;
  private-specimen checks are opt-in/local-only via `EMM_PRIVATE_PDF_DIR`
  and skipped otherwise (CI passes without them).
- `tests/browser-smoke.py` — manual/local real-Chromium smoke test (Playwright),
  not run in CI.

Inherited from the earlier validated prototype (summarized, not shipped here):
- Core engine: 62/62 synthetic smoke checks passed.
- PDF integration: 26/26 checks passed.
- Real-statement validation (private specimens, never committed): PC Financial
  117 rows and CIBC Costco 54 rows parsed with zero unparsed rows and
  reconciliation gap zero.
- The app makes no network requests for financial processing or storage
  (fetch/XHR/WebSocket) at runtime. The sole exception: optional AI phrasing
  (off by default) only ever talks to the provider URL you enter, after
  per-call preview + approval.
