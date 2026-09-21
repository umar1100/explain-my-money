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

## Option C — cPanel shared hosting (one-click updates)

Used for `https://finance.raavtek.com` (Namecheap Stellar shared hosting,
`server309.web-hosting.com`). The site is password-gated with cPanel
**Directory Privacy** on the domain's document root
(`/home/newekopu/finance.raavtek.com`).

One-time setup in cPanel:

1. Open **Git Version Control** → **Create**:
   - Clone URL: `https://github.com/umar1100/explain-my-money.git`
   - Repository Path: `/home/newekopu/emm-repo` (a working folder — **not**
     the domain's document root)
   - Repository Name: `explain-my-money`
2. The repo's `.cpanel.yml` defines the deployment: it copies `apps/web/`
   into the `finance.raavtek.com` document root.

Updating later: **Git Version Control** → **Manage** the repo →
**Pull or Deploy** → **Update from Remote**, then **Deploy**.

Deploys only copy files over the top, so the Directory Privacy
`.htaccess`/`.htpasswd` in the document root — and the password gate —
survive every update untouched.
