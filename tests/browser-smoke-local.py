"""Local-file smoke test for Explain My Money's auto-categorization + Month-aggregate
work (Problem A + Problem B).

MANUAL / LOCAL-ONLY: requires Playwright + a local Chromium install, so it
is NOT run in CI. Opens apps/web/index.html over file:// (no server) at a
390x844 iPhone-ish viewport. Checks: boot, onboarding dismissal, CSV import,
auto-categories stamped by the import pipeline (via the on-device Store),
Month tab navigator + per-account breakdown + coverage note, uncategorized
review queue with "Needs a category", and the More-menu backfill action.
Zero console errors and zero external http(s) requests required.
Run: python3 tests/browser-smoke-local.py
"""
import sys, os, json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
WEB = (HERE.parent / "apps" / "web" / "index.html").resolve()
BASE = WEB.as_uri()
CSV = HERE / "fixtures" / "sample_statement_aug2026.csv"
SHOTS = HERE / "shots"

results, console_errors, page_errors, ext_requests = [], [], [], []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS " if cond else "FAIL ") + name + ((" — " + str(extra)) if extra and not cond else ""))

def main():
    assert WEB.exists(), f"missing {WEB}"
    assert CSV.exists(), f"missing {CSV}"
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844},  # iPhone-ish
                                  is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("request", lambda r: ext_requests.append(r.url)
                if urlparse(r.url).scheme in ("http", "https") else None)

        # 1. Boot over file://
        page.goto(BASE, wait_until="load")
        page.wait_for_selector(".tabbar .tab", timeout=20000)
        check("boot: 4 tabs render", page.locator(".tabbar .tab").count() == 4)
        check("boot: Add screen first-run", page.locator("#stmt-file").count() == 1)
        page.screenshot(path=f"{SHOTS}/local-01-add.png")

        # 1b. Dismiss onboarding overlay
        if page.locator("#onboard").count():
            page.click('button[data-action="onboard-skip"]')
            page.wait_for_timeout(400)
        check("onboarding: dismissed", page.locator("#onboard").count() == 0)

        # 2. CSV import through the real pipeline; the completion screen offers
        # "See your month" (case-insensitive text matching means we must not
        # rely on a "Your Month" substring wait here).
        page.set_input_files("#stmt-file", str(CSV))
        page.wait_for_selector('button[data-action="confirm-import"]', timeout=15000)
        page.screenshot(path=f"{SHOTS}/local-02-preview.png")
        page.click('button[data-action="confirm-import"]')
        page.wait_for_selector(".banner.ok", timeout=30000)  # pipeline done
        banner = page.inner_text(".banner.ok")
        check("import: pipeline completes", "25 transactions cleaned" in banner, banner)
        page.click('button[data-action="tab"][data-tab="home"]')  # "See your month" -> Home
        page.wait_for_selector(".month-nav", timeout=15000)
        check("import: Home opens", True)
        page.screenshot(path=f"{SHOTS}/local-03-home.png")

        # 3. Auto-categories stamped by the import pipeline (on-device Store)
        cats = page.evaluate("""(async () => {
          const ts = await Store.all('txns');
          const out = {};
          for (const t of ts) {
            const d = String(t.rawDescription || '');
            if (/LOBLAWS/.test(d)) out.loblaws = [t.category, t.categorySource];
            else if (/STARBUCKS/.test(d)) out.starbucks = [t.category, t.categorySource];
            else if (/COSTCO WHOLESALE/.test(d)) out.costco = [t.category, t.categorySource];
            else if (/PRESTO/.test(d)) out.presto = [t.category, t.categorySource];
            else if (/ANNUAL FEE/.test(d)) out.fee = [t.category, t.categorySource];
          }
          return out;
        })()""")
        check("auto-cat: LOBLAWS -> groceries (auto)", cats.get("loblaws") == ["groceries", "auto"], cats.get("loblaws"))
        check("auto-cat: STARBUCKS -> dining (auto)", cats.get("starbucks") == ["dining", "auto"], cats.get("starbucks"))
        check("auto-cat: COSTCO WHOLESALE -> groceries (auto)", cats.get("costco") == ["groceries", "auto"], cats.get("costco"))
        check("auto-cat: PRESTO -> transport (auto)", cats.get("presto") == ["transport", "auto"], cats.get("presto"))
        check("auto-cat: ANNUAL FEE -> fees (auto)", cats.get("fee") == ["fees", "auto"], cats.get("fee"))

        # 4. Home tab: navigator, coverage note; detail sections one tap down
        body = page.inner_text("#view")
        check("home: navigator renders", page.locator(".month-nav").count() == 1)
        check("home: prev/next buttons", page.locator('button[data-action="month-prev"]').count() == 1
              and page.locator('button[data-action="month-next"]').count() == 1)
        check("home: month dropdown", page.locator("#month-select").count() == 1)
        opts = page.evaluate("Array.from(document.querySelectorAll('#month-select option')).map(o => o.value)")
        check("home: dropdown lists the imported month", "2026-08" in opts, opts)
        check("home: coverage note", "1 statement contributes to August 2026" in body, "")
        check("home: ask box present", page.locator("#ask-free").count() == 1)
        # Detail sections live inside the "Month details" disclosure: open it.
        page.click('details.more summary:has-text("Month details")')
        page.wait_for_timeout(600)
        body = page.inner_text("#view")
        check("home details: per-account breakdown", "Per-account breakdown" in body)
        check("home details: per-account row shows balance check state", "check:" in body)
        check("home details: aggregate balance check honest", "n/a (per-account above)" in body)
        check("home details: sections present",
              all(s in body for s in ["What changed", "Where it went", "Refunds & money movement", "Evidence quality"]))
        page.screenshot(path=f"{SHOTS}/local-04-home-full.png")

        # 5. Activity review queue: uncategorized rows listed with "Needs a category"
        page.click('.tab[data-tab="activity"]')
        page.wait_for_timeout(900)
        body = page.inner_text("#view")
        review_count = page.evaluate("""(() => {
          const el = document.querySelector('button[data-action="sfilter"][data-f="review"]');
          return el ? el.innerText : '';
        })()""")
        check("statement: review chip rendered", "review" in review_count.lower(), review_count)
        page.click('button[data-action="sfilter"][data-f="review"]')
        page.wait_for_timeout(900)
        body = page.inner_text("#view")
        check("review: 'Needs a category' section visible", "Needs a category" in body)
        check("review: 'no category' pill on rows", "no category" in body)
        page.screenshot(path=f"{SHOTS}/local-05-review.png")

        # 5b. User correction E2E: open an uncategorized txn, set its category,
        # verify user-source metadata and the rule offer with category picker.
        nocat_id = page.evaluate("""(async () => {
          const ts = await Store.all('txns');
          const t = ts.find(t => !t.category && (t.kind === 'purchase' || t.kind === 'refund') && !t.excluded);
          return t ? t.id : null;
        })()""")
        check("correction: an uncategorized txn exists to fix", bool(nocat_id), nocat_id)
        if nocat_id:
            page.click(f'button[data-action="open-txn"][data-id="{nocat_id}"]')
            page.wait_for_selector("#cat-sel", timeout=10000)
            page.select_option("#cat-sel", "dining")
            page.wait_for_selector("text=Make this a rule?", timeout=10000)
            check("correction: rule offer appears", True)
            check("correction: rule offer has category picker",
                  page.locator("#rule-cat-sel").count() == 1)
            page.screenshot(path=f"{SHOTS}/local-05b-rule-offer.png")
            saved = page.evaluate("""(async () => {
              const t = await Store.get('txns', %s);
              return [t.category, t.categorySource, t.categoryConfidence];
            })()""" % json.dumps(nocat_id))
            check("correction: saved as user category", saved == ["dining", "user", 1.0], saved)
            page.click('button[data-action="cancel-rule"]')
            page.wait_for_timeout(600)
            body = page.inner_text("#view")
            check("correction: offer dismisses", "Make this a rule?" not in body)

        # 6. More -> Auto-categorize backfill (never overwrites user categories)
        page.click('.tab[data-tab="more"]')
        page.wait_for_timeout(700)
        check("more: backfill button present", page.locator('button[data-action="autocat-backfill"]').count() == 1)
        # set a user category first so we can prove backfill never overwrites it
        user_marked = page.evaluate("""(async () => {
          const ts = (await Store.all('txns')).filter(t => !t.category && t.kind === 'purchase' && !t.excluded);
          if (!ts.length) return null;
          const t = ts[0];
          t.category = 'shopping'; t.categorySource = 'user'; t.categoryConfidence = 1.0;
          await Store.put('txns', t);
          return [t.id, t.rawDescription];
        })()""")
        before = page.evaluate("""(async () => (await Store.all('txns'))
          .filter(t => t.categorySource === 'user' || t.classificationSource === 'user')
          .map(t => [t.id, t.category, t.kind]))()""")
        page.click('button[data-action="autocat-backfill"]')
        page.wait_for_timeout(1200)
        body = page.inner_text("#view")
        check("backfill: report message", "Auto-categorized" in body and "never touched" in body)
        after = page.evaluate("""(async () => (await Store.all('txns'))
          .filter(t => t.categorySource === 'user' || t.classificationSource === 'user')
          .map(t => [t.id, t.category, t.kind]))()""")
        check("backfill: user categories untouched",
              json.dumps(sorted(map(str, before))) == json.dumps(sorted(map(str, after))),
              f"before={before} after={after}")
        page.screenshot(path=f"{SHOTS}/local-06-more.png")

        # 7. Hygiene: no console errors, no external requests
        check("console: zero errors", len(console_errors) == 0, "; ".join(console_errors[:3]))
        check("page: zero page errors", len(page_errors) == 0, "; ".join(page_errors[:3]))
        check("network: zero external http(s) requests", len(ext_requests) == 0, "; ".join(ext_requests[:5]))

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
