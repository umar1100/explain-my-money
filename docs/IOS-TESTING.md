# Testing on iPhone

No Mac, no App Store, no TestFlight needed. The app installs directly
from Safari as a home-screen app.

## Install

1. On the iPhone, open the deployed URL in **Safari**
   (e.g. `https://<username>.github.io/<repo>/`).
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open **My Money** from the home screen. It runs full-screen and works
   in airplane mode after the first load.

## Test checklist

- [ ] **Import the sample CSV** — Add → Choose statement files → pick
      `tests/fixtures/sample_statement_aug2026.csv` → Process files.
      Expect: 8 visible pipeline stages, then a clean statement.
- [ ] **Clean statement** — Statement tab: purchases separated from
      payments/transfers/refunds; reconciliation strip shows gross,
      refunds, net spending.
- [ ] **Review queue** — open an uncertain item, correct it, confirm the
      proposed household rule.
- [ ] **Your Month** — Month tab: headline total, what changed,
      where it went, evidence quality. Tap any claim → evidence drawer.
- [ ] **Ask** — Ask tab: try a suggested question; check the evidence
      footer (period, scope, confidence, sources).
- [ ] **Receipt** — Add → Add receipts → Take photo / choose image.
      Expect on-device OCR (may take ~30s first run while the engine
      warms up): merchant/date/total pre-filled for you to confirm,
      then "Find matches" suggests statement rows to link.
- [ ] **Persistence** — close the app fully, reopen: data is still there.
- [ ] **Offline** — airplane mode, reopen: everything works.
- [ ] **Export / wipe** — More → Export (JSON/CSV downloads), then
      delete all local data and confirm the app returns to empty.

## Notes

- First load downloads ~14 MB of on-device libraries (PDF parser, OCR
  engine); afterwards the service worker serves everything offline.
- iOS Safari supports everything the app uses: IndexedDB, Web Workers,
  WebAssembly, camera capture via file input.
- To remove: delete the home-screen icon, then in Safari settings clear
  website data for the app's domain.
