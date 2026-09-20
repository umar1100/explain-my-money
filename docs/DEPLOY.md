# Deploying Explain My Money

The app is a static site — HTML, CSS, JavaScript, and vendored libraries.
It makes **zero network requests for financial processing and storage** at
runtime: parsing, OCR, storage, and the deterministic engine all run on the
device. The only exception is optional bring-your-own-key AI phrasing (off by
default), which contacts only the provider URL you configure, and only after
you preview and approve the exact payload for each call. Deployment is just
putting the `apps/web/` folder on any static host.

## Option A — GitHub Pages (recommended, free)

1. Push this repo to GitHub (branch `main`).
2. Go to **Settings → Pages → Build and deployment**.
3. Under **Source**, choose **GitHub Actions**.
4. Push any change under `apps/web/` (or run the workflow manually from
   the **Actions** tab). The `Deploy to GitHub Pages` workflow publishes
   `apps/web/` automatically.
5. Your app is live at `https://<username>.github.io/<repo>/`.

No build step, no server, no environment variables. Updating is `git push`.

## Option B — Any static host

Copy the contents of `apps/web/` to Netlify Drop, Cloudflare Pages,
an S3 bucket, or any static file server. Everything the app needs is
inside that folder, referenced with relative paths.

## Privacy note

The host serves **application code only**. Statements, receipts,
transactions, rules, and briefings live in the device's own storage
(IndexedDB) and are never transmitted anywhere. See `docs/PRIVACY.md`.
