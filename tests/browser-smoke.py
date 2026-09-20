"""Real-Chromium smoke test for Explain My Money (local-first PWA).

MANUAL / LOCAL-ONLY: requires Playwright + a local Chromium install, so it
is NOT run in CI. Serves nothing itself; expects the app at the base URL
(passed as argv[1] or EMM_SMOKE_URL, default http://localhost:8080).
Checks: boot, CSV import + pipeline, Month briefing, Statement detail,
Ask answer + AI-off default, Privacy screen, zero non-local requests,
service worker registration. Screenshots to tests/shots/.
Run: python3 tests/browser-smoke.py [url]
"""
import sys, os, json
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("EMM_SMOKE_URL")
        or "http://localhost:8080")
BASE_HOST = urlparse(BASE).netloc or "localhost:8080"
CSV = HERE / "fixtures" / "sample_statement_aug2026.csv"
SHOTS = HERE / "shots"

results, console_errors, page_errors, ext_requests = [], [], [], []

def check(name, cond, extra=""):
    results.append((name, bool(cond), extra))
    print(("PASS " if cond else "FAIL ") + name + ((" — " + str(extra)) if extra and not cond else ""))

def main():
    os.makedirs(SHOTS, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844},  # iPhone-ish
                                  is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("request", lambda r: ext_requests.append(r.url)
                if urlparse(r.url).netloc != BASE_HOST else None)

        # 1. Boot
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_selector(".tabbar .tab", timeout=15000)
        tabs = page.locator(".tabbar .tab").count()
        check("boot: 5 tabs render", tabs == 5, f"found {tabs}")
        check("boot: Add screen first-run", page.locator("#stmt-file").count() == 1)
        page.screenshot(path=f"{SHOTS}/01-add.png")

        # 2. CSV import
        page.set_input_files("#stmt-file", str(CSV))
        page.wait_for_selector('button[data-action="confirm-import"]', timeout=15000)
        check("import: preview shows", True)
        page.screenshot(path=f"{SHOTS}/02-preview.png")
        page.click('button[data-action="confirm-import"]')
        page.wait_for_selector("text=Your Month", timeout=30000)  # pipeline lands on Month
        check("import: pipeline completes to Month", True)
        page.screenshot(path=f"{SHOTS}/03-month.png")

        # 3. Month briefing
        check("month: headline number", page.locator(".headline-num").count() >= 1)
        body = page.inner_text("#view")
        for needle in ["Where it went", "Needs your review", "Evidence quality"]:
            check(f"month: section '{needle}'", needle in body)

        # 4. Statement
        page.click('.tab[data-tab="statement"]')
        page.wait_for_selector('#view', timeout=10000)
        page.wait_for_timeout(800)
        body = page.inner_text("#view")
        check("statement: list renders", "Review" in body or "Purchases" in body)
        page.screenshot(path=f"{SHOTS}/04-statement.png")
        txn_btn = page.locator('button[data-action="open-txn"]').first
        if txn_btn.count():
            txn_btn.click()
            page.wait_for_timeout(800)
            body = page.inner_text("#view")
            check("statement: txn detail opens", "Normalized" in body or "Raw" in body or "Evidence" in body)
            page.screenshot(path=f"{SHOTS}/05-txn.png")
            back = page.locator('button[data-action="txn-back"]')
            if back.count(): back.click(); page.wait_for_timeout(500)
        else:
            check("statement: txn detail opens", False, "no txn buttons")

        # 5. Ask
        page.click('.tab[data-tab="ask"]')
        page.wait_for_timeout(800)
        page.click('.chip[data-q="q-spend"]')
        page.wait_for_timeout(1200)
        body = page.inner_text("#view")
        check("ask: deterministic answer card", "actual spend after refunds" in body.lower())
        check("ask: evidence footer", "Evidence basis" in body)
        check("ask: AI phrasing present", "AI phrasing" in body)
        ai_on = page.locator('#llm-base').count()
        check("ask: AI settings inputs exist but disabled by default",
              page.locator('input[data-change="llm-enabled"]').is_checked() == False)
        page.screenshot(path=f"{SHOTS}/06-ask.png")

        # 6. More → privacy
        page.click('.tab[data-tab="more"]')
        page.wait_for_timeout(600)
        page.click('button[data-action="goto"][data-more="privacy"]')
        page.wait_for_timeout(800)
        body = page.inner_text("#view")
        check("privacy: screen renders", "Your data never leaves this device" in body)
        check("privacy: network row honest", "Optional AI phrasing is the only network use" in body)
        page.screenshot(path=f"{SHOTS}/07-privacy.png")

        # 7. Network audit
        check("network: zero requests outside the app server", len(ext_requests) == 0,
              "; ".join(ext_requests[:5]))

        # 8. Service worker
        sw = page.evaluate("""async () => {
          if (!('serviceWorker' in navigator)) return 'unsupported';
          const r = await navigator.serviceWorker.getRegistration();
          return r ? (r.active ? 'active' : 'registered') : 'none';
        }""")
        check("pwa: service worker registered", sw in ("active", "registered"), sw)

        # Console / page errors
        real_errors = [e for e in console_errors if "favicon" not in e.lower()]
        check("no console errors", len(real_errors) == 0, "; ".join(real_errors[:3]))
        check("no page errors", len(page_errors) == 0, "; ".join(page_errors[:3]))

        browser.close()

    fails = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(fails)}/{len(results)} checks passed")
    return 1 if fails else 0

sys.exit(main())
