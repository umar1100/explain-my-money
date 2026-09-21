"""Real-Chromium smoke test for Explain My Money (local-first PWA).

MANUAL / LOCAL-ONLY: requires Playwright + a local Chromium install, so it
is NOT run in CI. Serves nothing itself; expects the app at the base URL
(passed as argv[1] or EMM_SMOKE_URL, default http://localhost:8080).
Checks: boot, onboarding overlay, CSV import + pipeline, Month briefing, Statement detail,
Ask answer + AI-off default, Privacy screen, More (accounts + sample data + replay tour),
zero non-local requests, service worker registration. Screenshots to tests/shots/.
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
        check("boot: 4 tabs render", tabs == 4, f"found {tabs}")
        check("boot: Add screen first-run", page.locator("#stmt-file").count() == 1)
        page.screenshot(path=f"{SHOTS}/01-add.png")

        # 1b. Onboarding overlay (first run: zero statements, tour not done).
        # It covers the screen, so dismiss it before the import flow.
        check("onboarding: overlay shown on first run", page.locator("#onboard").count() == 1)
        page.screenshot(path=f"{SHOTS}/01b-onboarding.png")
        page.click('button[data-action="onboard-skip"]')
        page.wait_for_timeout(400)
        check("onboarding: skip dismisses overlay", page.locator("#onboard").count() == 0)

        # 2. CSV import
        page.set_input_files("#stmt-file", str(CSV))
        page.wait_for_selector('button[data-action="confirm-import"]', timeout=15000)
        check("import: preview shows", True)
        page.screenshot(path=f"{SHOTS}/02-preview.png")
        page.click('button[data-action="confirm-import"]')
        page.wait_for_selector("text=Net spend after refunds", timeout=30000)  # pipeline lands on Home
        check("import: pipeline completes to Home", True)
        page.screenshot(path=f"{SHOTS}/03-month.png")

        # 3. Home summary
        check("home: headline number", page.locator(".headline-num").count() >= 1)
        check("home: ask box", page.locator("#ask-free").count() == 1)
        body = page.inner_text("#view")
        for needle in ["Needs your review", "All clear", "Ask about your money"]:
            if needle in body:
                check(f"home: section '{needle}'", True)
                break
        else:
            check("home: summary section", False, body[:120])
        check("home: month details behind disclosure",
              page.locator('details.more summary:has-text("Month details")').count() >= 1)
        # expand Month details and check the detailed sections still render
        page.click('details.more summary:has-text("Month details")')
        page.wait_for_timeout(600)
        body = page.inner_text("#view")
        for needle in ["Where it went", "Evidence quality"]:
            check(f"home details: section '{needle}'", needle in body)

        # 4. Activity (statements + review queue)
        page.click('.tab[data-tab="activity"]')
        page.wait_for_selector('#view', timeout=10000)
        page.wait_for_timeout(800)
        body = page.inner_text("#view")
        check("activity: list renders", "Review" in body or "Purchases" in body)
        page.screenshot(path=f"{SHOTS}/04-statement.png")
        txn_btn = page.locator('button[data-action="open-txn"]').first
        if txn_btn.count():
            txn_btn.click()
            page.wait_for_timeout(800)
            body = page.inner_text("#view")
            check("activity: txn detail opens", "Normalized" in body or "Raw" in body or "Evidence" in body)
            page.screenshot(path=f"{SHOTS}/05-txn.png")
            back = page.locator('button[data-action="txn-back"]')
            if back.count(): back.click(); page.wait_for_timeout(500)
        else:
            check("activity: txn detail opens", False, "no txn buttons")

        # 5. Ask (one-line box on Home) — question chips live in "What can I ask?"
        page.click('.tab[data-tab="home"]')
        page.wait_for_timeout(800)
        page.click('details.more summary:has-text("What can I ask?")')
        page.wait_for_timeout(400)
        page.click('.chip[data-q="q-spend"]')
        page.wait_for_timeout(1200)
        body = page.inner_text("#view")
        check("ask: deterministic answer card", "actual spend after refunds" in body.lower())
        check("ask: evidence footer", "Evidence basis" in body)
        page.screenshot(path=f"{SHOTS}/06-ask.png")

        # 5b. More → AI phrasing settings (off by default)
        page.click('.tab[data-tab="more"]')
        page.wait_for_timeout(600)
        check("more: AI phrasing card present", page.locator('button[data-action="goto"][data-more="ai"]').count() == 1)
        page.click('button[data-action="goto"][data-more="ai"]')
        page.wait_for_timeout(800)
        check("ai: settings inputs exist but disabled by default",
              page.locator('input[data-change="llm-enabled"]').is_checked() == False)
        page.screenshot(path=f"{SHOTS}/06b-ai.png")
        page.click('button[data-action="back-more"]')
        page.wait_for_timeout(600)

        # 6. More → privacy
        page.click('button[data-action="goto"][data-more="privacy"]')
        page.wait_for_timeout(800)
        body = page.inner_text("#view")
        check("privacy: screen renders", "Your data never leaves this device" in body)
        check("privacy: network row honest", "Optional AI phrasing is the only network use" in body)
        page.screenshot(path=f"{SHOTS}/07-privacy.png")

        # 6b. More → accounts + sample data (Phase 4)
        page.click('button[data-action="back-more"]')
        page.wait_for_timeout(600)
        check("more: sample-data add button present", page.locator('button[data-action="sample-add"]').count() == 1)
        check("more: replay-tour button present", page.locator('button[data-action="onboard-replay"]').count() == 1)
        page.click('button[data-action="goto"][data-more="accounts"]')
        page.wait_for_timeout(800)
        body = page.inner_text("#view")
        check("accounts: screen renders", "Accounts" in body)
        check("accounts: per-account totals", "across" in body and "transaction" in body)
        check("accounts: coverage legend", "last 12 months" in body)
        page.screenshot(path=f"{SHOTS}/08-accounts.png")

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
