# Deploying Blockchain Bullhorn

A zero-dependency Node.js app (Node 18+) that serves 21 pages, a REST API, and
stores all state in `data/` (JSON database + uploaded KYC/deposit-proof files).
It needs **one long-running Node process** and somewhere persistent to keep
`data/`.

**The recommended setup is Render's paid Starter plan with a persistent disk**
(~$7.25/mo). That is what `render.yaml` in this repo now describes, and it is the
only configuration in which the site is always on *and* keeps its data. A
zero-cost fallback is documented at the bottom of this file, with its trade-offs
spelled out.

---

## Why paid: what the free tier actually costs you

| | Render **free** | Render **Starter + disk** (this repo) |
|---|---|---|
| Cold starts | Sleeps after ~15 min idle; 30–60 s to wake. Visitors hit a dead site. | Never sleeps |
| `data/db.json` | **Wiped on every deploy and restart** | Survives everything |
| KYC / deposit-proof uploads | **Wiped on every deploy** | Survive everything |
| Admin settings (wallets, email, announcements) | Wiped; had to be re-injected from env on every boot | Persist in the database |
| Outbound SMTP (ports 25/465/587) | **Blocked platform-wide** — needs a SendGrid/HTTP-relay workaround | Works directly |
| CPU / RAM | 0.1 CPU, 512 MB | 0.5 CPU, 512 MB |
| Cost | $0 | $7.00 + $0.25 (1 GB disk) ≈ **$7.25/mo** |

On the free tier the app works around the ephemeral filesystem by mirroring
`data/` to a **private GitHub repository** (`lib/backup.js`). That is a genuine
engineering workaround, but it is still a workaround: it pushes user data and
password hashes to a third-party repo, it depends on a personal access token
staying valid, and any missed push is data loss. With a real disk attached it
demotes to an optional off-site safety net.

---

## Recommended — Render Starter + persistent disk (~10 minutes)

### 1. Deploy from the blueprint

On [render.com](https://render.com): **New → Blueprint** → connect your GitHub
account → pick this repo. Render reads `render.yaml` and creates the service
with the correct plan, disk, health check and environment variables.

> Prefer clicking instead? **New → Web Service** works too, but you must then set
> the instance type to **Starter**, add the disk manually, and enter every
> environment variable from the table below. The blueprint removes all of that
> guesswork — and the mount-path mistake described in step 2 is easy to make.

### 2. The disk mount path (the one thing that is easy to get wrong)

`render.yaml` mounts the disk at **`/var/data`** and sets **`DATA_DIR=/var/data`**.

The app resolves its data directory from `DATA_DIR` (`lib/db.js`, `lib/backup.js`,
`lib/jwt.js` and `lib/markets.js` all honour it), so a standalone mount point is
exactly what Render's own docs recommend.

Do **not** mount at `/app/data`. That is the *Docker* working directory; this
service uses Render's **native Node runtime**, whose source tree lives at
`/opt/render/project/src`. `/app` does not exist there, so the disk would be
mounted somewhere the app never writes and your data would stay ephemeral while
looking like it was persisted. These exact paths are also rejected as mount
points: `/`, `/opt`, `/opt/render`, `/opt/render/project`,
`/opt/render/project/src`, `/home`, `/home/render`, `/etc`, `/etc/secrets`.

If you switch the service to `runtime: docker`, change **both** values to
`/app/data` — the bundled `Dockerfile` already defaults `DATA_DIR` to that.

### 3. Verify persistence actually works

After the first deploy, open **`https://your-app.onrender.com/healthz`**. It
reports the resolved data directory and how large the database has grown:

```json
{
  "service": "bulltrade",
  "ok": true,
  "persistence": {
    "dataDir": "/var/data",
    "dbBytes": 184320,
    "uploads": "/var/data/uploads",
    "backupSync": false
  },
  "rateLimit": { "enabled": true }
}
```

- `dataDir` must read **`/var/data`**. Anything else means `DATA_DIR` and the
  disk mount disagree.
- Create a test user, note `dbBytes`, then **Manual Deploy → Clear build cache &
  deploy**. If `dbBytes` and the test user survive, persistence is real. On the
  free tier this is exactly where the data used to vanish.

### 4. Environment variables

`render.yaml` prompts for the secrets marked `sync: false` during the first
sync. `JWT_SECRET` uses `generateValue: true`, so Render mints a strong
256-bit secret automatically (an existing one is left untouched, so nobody gets
logged out).

### 5. Things that change once a disk is attached

These are Render platform rules, not app limitations — worth knowing before you
hit them:

- **One instance only.** A disk cannot be shared, so `numInstances` stays at 1
  and the service cannot autoscale horizontally.
- **No zero-downtime deploys.** Render stops the old instance before starting
  the new one, so each deploy has a few seconds of downtime. `server.js`
  installs SIGTERM/SIGINT handlers that flush `data/db.json` before exit, and
  the blueprint starts the app with `node server.js` rather than `npm start` so
  that signal reaches Node directly — no writes are lost in the handover.
- **The disk is not mounted during the build.** `buildCommand` runs on separate
  compute, so never read or write `DATA_DIR` from it.
- **Snapshots.** Render snapshots the disk every 24 h and keeps snapshots for
  7 days (service → **Disk** → Restore snapshot). Restoring reverts *everything*
  after the snapshot — treat it as disaster recovery, not as an undo button.

### 6. Scaling up

Change `plan: starter` → `plan: standard` ($25/mo, 1 CPU, 2 GB) in
`render.yaml` and sync. The static-asset cache budget follows available memory
via `STATIC_CACHE_MB` (default 64); at 512 MB the app idles around 70 MB RSS and
peaks near 115 MB with all 257 assets memoised, so there is a lot of headroom
before you need it.

### 7. Region

Region cannot be changed after a service is created, so set it at creation time.
For users in Nigeria / West Africa, **`frankfurt`** gives the lowest latency
(~120–150 ms from Lagos), ahead of `virginia` (~190 ms) and `oregon` (~230 ms).
It is commented out in `render.yaml`; uncomment only when creating a new service.

---

## Environment variables

Every one of these is already declared in `render.yaml`; this table is the
reference for other hosts (and for the VPS script in `deploy/vps-setup.sh`).

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no | HTTP port (default 3000) — hosts inject this automatically |
| `DATA_DIR` | **yes on Render** | Absolute path of the persistent data directory. Must match the disk's `mountPath` (`/var/data`). Defaults to `<repo>/data` when unset |
| `NODE_ENV` | yes | Set to `production`. Enables `Secure` session cookies, HSTS on HTTPS responses, suppression of password-reset tokens in API responses, and the request throttle |
| `JWT_SECRET` | recommended | Session-token key. Auto-generated to `DATA_DIR/.jwt-secret` if unset. `render.yaml` uses `generateValue: true` so Render mints a strong one |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first boot | Seed the admin account (a random password is printed to the console once if unset) |
| `SITE_URL` | recommended | Canonical origin for canonical/OG/JSON-LD tags, the sitemap, robots.txt and every link inside transactional email |
| `EMAIL_TRANSPORT` | no | `smtp` (default; works on paid instances), `sendgrid`, or `relay` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | for email | Direct SMTP credentials. Gmail needs a 16-char **App Password**, not the account password |
| `SENDGRID_API_KEY` | alt. transport | For `EMAIL_TRANSPORT=sendgrid` |
| `MAIL_RELAY_URL` / `MAIL_RELAY_SECRET` | alt. transport | For `EMAIL_TRANSPORT=relay` (Google Apps Script web app) |
| `SUPPORT_EMAIL` / `NOTIFY_EMAIL` | no | Public support address / where owner notifications go. Falls back to the database setting |
| `DEPOSIT_ADDRESSES` | no | JSON map of funding wallets. With a persistent disk, Admin → Settings is enough; setting it here too guarantees the addresses survive a rolled-back or empty disk (env always wins on boot) |
| `PRODUCT_PAYMENT_ADDRESSES` | no | JSON map for store checkout (USDT ERC-20). Same override behaviour |
| `RATE_LIMIT` | no | `on` / `off`. Unset means "on when `NODE_ENV=production`" |
| `RATE_LIMIT_<NAME>` | no | Per-route override as `max/windowMs`, e.g. `RATE_LIMIT_SIGNUP=20/3600000`. `<NAME>` is the uppercased rule name: `SIGNUP`, `TWOFA`, `FORGOT`, `RESET`, `LEADS`, `TICKET`, `CHATINIT`, `CHATSEND`. (Failed *logins* are throttled separately by `lib/auth.js`: 10 per email+IP per 15 min) |
| `STATIC_CACHE_MB` | no | In-memory static-asset cache budget (default 64). All 257 assets total ~21 MB, so the default holds the whole site |
| `BACKUP_REPO` / `BACKUP_TOKEN` | **optional now** | `owner/name` of a **private** GitHub repo + a PAT with repo scope. Off-site mirror of `data/`. No longer required once a disk is attached |
| `BACKUP_BRANCH` / `BACKUP_DIR` | no | Sync branch (`main`) / path prefix (`data`) |
| `HUBSPOT_ACCESS_TOKEN` | no | Enables optional CRM contact/ticket sync (`lib/hubspot.js`) |
| `NODE_VERSION` | Render only | Pins the Node runtime so builds stay reproducible (`render.yaml` sets 20.20.2) |

## ⚠️ After the first deploy

The repo ships with empty deposit wallet addresses on purpose (they are
runtime data, not code). Paste them into **Admin → Settings → Crypto Deposit
Addresses**, and set the **Product Payment Wallets** (USDT ERC-20) used for
product purchases. On a persistent disk these now stick across redeploys —
that is precisely what the free tier could not do.

Also: change the admin password, configure email and send a test message, paste
the Smartsupp key, and set the contest prize.

**If you enable the optional GitHub mirror:** one backup repo per instance (two
instances sharing a repo will fight), and never make that repo public — it
contains user data and password hashes.

## Health check

| Endpoint | Use |
|---|---|
| `GET /healthz` | Liveness. Always `200` once the HTTP server is listening. Reports uptime, record counts, `persistence.dataDir`, `persistence.dbBytes` and `rateLimit.enabled`. **This is what `render.yaml` points Render's health check at** |
| `GET /readyz` | Readiness. `200` only once the database is loaded *and* the market feed has populated; otherwise `503`. Point an external uptime monitor here if you want to be alerted on a half-booted instance |
| `GET /` | `200` — fine for a third-party pinger |

---

## Finishing Touches (recommended after first deploy)

### 1. Make emails actually send
All transactional emails (connection keys, purchase approvals, password resets) are already coded.

**On a paid instance, use plain SMTP** — paid plans can open outbound ports
25/465/587, which the free tier blocks platform-wide:

1. Admin → Settings → **Email Delivery** → Transport = **SMTP**.
2. Host `smtp.gmail.com`, port `465`, your address, and a **16-character App
   Password** from https://myaccount.google.com/apppasswords (2-Step
   Verification must be on — the ordinary account password will not work).
3. Save → **Send Test Email**.

Or set it in the environment so it survives an empty disk:
`EMAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_FROM`.

Every message is journaled under **Admin → Emails** regardless of transport
(sent / failed / skipped, with the error), so delivery problems are diagnosable
without reading logs.

**Prefer an HTTP API?** Both alternatives are still fully supported and are the
only options that work on the free tier:

**Option A — SendGrid API (free 100/day, standard):**
1. Create a free SendGrid account (sendgrid.com) → Settings → Sender Authentication → verify a Single Sender
   using `blockchainbullhornfaqs@gmail.com` (click the confirmation email).
2. Settings → API Keys → Create (Full access) → copy the `SG.…` key.
3. On the site: Admin → Settings → Email Delivery → Transport = **SendGrid API** → paste the key → Save → **Send Test Email**.

**Option B — Gmail Relay via Google Apps Script (free, no new accounts, 100 emails/day):**
1. Go to https://script.google.com while logged into `blockchainbullhornfaqs@gmail.com` → New project.
2. Delete the default code and paste:

   ```js
   function doPost(e) {
     var SECRET = 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET';
     try {
       var b = JSON.parse(e.postData.contents);
       if (b.secret !== SECRET) return ContentService.createTextOutput('bad secret');
       MailApp.sendEmail({ to: b.to, subject: b.subject, htmlBody: b.html, name: 'Blockchain Bullhorn' });
       return ContentService.createTextOutput('sent');
     } catch (err) { return ContentService.createTextOutput('error: ' + err); }
   }
   ```

3. Change `CHANGE_THIS_TO_A_LONG_RANDOM_SECRET` to any long random text (keep it — you'll paste it below).
4. Deploy → New deployment → type **Web app** → Execute as: **Me** → Who has access: **Anyone** → Deploy → copy the Web App URL.
5. On the site: Admin → Settings → Email Delivery → Transport = **Gmail Relay** → paste the URL + the secret → Save → **Send Test Email**.

### 2. Monitor uptime (not keep-awake)
Cold starts are gone on a paid plan — nothing sleeps, so the old "ping it every
10 minutes" trick is no longer needed. Monitoring is still worth 5 minutes:
1. Create a free account at UptimeRobot (uptimerobot.com) or cron-job.org.
2. Add an HTTP monitor for `https://your-app.onrender.com/readyz` every **5 minutes**,
   alerting on anything other than `200`.
3. `/readyz` fails when the market feed is empty, so this catches a
   half-healthy instance that `/healthz` alone would report as fine.

Render restarts the instance automatically when the configured
`healthCheckPath` stops answering, so this monitor is your *notification* layer,
not your recovery layer.

### 3. Custom domain
1. In the Render dashboard open the service → **Settings → Custom Domains** → add e.g. `app.yourdomain.com`.
2. Render shows the DNS records to create at your domain registrar (a CNAME to the Render target).
3. Wait for DNS propagation; Render issues free TLS automatically.
4. **Update `SITE_URL`** to the new origin — it drives canonical/OG tags, the
   sitemap, robots.txt and every link in transactional email.
5. HSTS is sent automatically once the edge terminates TLS (the app checks
   `X-Forwarded-Proto`). It deliberately omits `includeSubDomains`, so adding a
   non-HTTPS subdomain later will not break.

### 4. Watch the bots work
The Trading Bots page has a **Live Bot Activity** feed (recent opens/closes with P/L, refreshed
every 20s), and Admin → Trading Bots shows key requests, allocations and per-bot stats.

---

## Zero-cost alternatives (and what you give up)

Use these only if $7.25/mo genuinely is not available. Both are documented here
because the app supports them, not because they are recommended for a site that
takes deposits and holds KYC documents.

| Option | Card needed | Always on | Data survives | Verdict |
|---|---|---|---|---|
| **Render Starter + disk** | ✅ yes | ✅ | ✅ real disk | **Recommended** |
| Render free + GitHub data-sync | ❌ no | ❌ sleeps after ~15 min | ⚠️ only as well as the last successful push | Demo/preview only |
| Oracle Cloud Always Free | ⚠️ card for verification, never charged | ✅ | ✅ real disk | Best genuinely-free production host |
| Vercel / Netlify / Deno Deploy functions | — | — | ❌ ephemeral per request | Unsuitable — no persistent filesystem |

### Render free tier

Set `plan: free` in `render.yaml` and **remove the `disk:` block** (Render
rejects a disk on a free instance). Persistence then falls back entirely to
`lib/backup.js`:

1. Create a **private** GitHub repo (one named `bulltrade-data` already exists on
   the project account). It will hold user data and password hashes — it must
   never be public.
2. Create a GitHub personal access token with `repo` scope → `BACKUP_TOKEN`.
3. Set `BACKUP_REPO=yourname/bulltrade-data` and `BACKUP_TOKEN` on the service.
4. The app pushes `data/db.json` (debounced 12 s) and uploaded files (immediately)
   after every change, flushes on SIGTERM, keeps a 10-minute safety-net interval,
   and restores automatically on boot when `data/` is empty.
5. Keep it awake with a free pinger (cron-job.org / UptimeRobot) hitting `/` every
   10 minutes — Render's 750 free instance-hours cover 24/7 for one service.
6. Email must use an HTTP transport (`sendgrid` or `relay`); SMTP ports are blocked.

Free-tier limits: 0.1 CPU / 512 MB RAM, 5 GB bandwidth/month, 500 build
minutes/month. The real risk is not the limits — it is that every deploy wipes
`data/`, so you are one failed push away from losing KYC uploads and balances.

### Oracle Cloud Always Free (real VPS, never sleeps)

Genuinely free forever; requires a card for identity verification (**never
charged**). Up to 2 ARM OCPUs / 12 GB RAM + 200 GB storage.

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) →
   create a VM (Ubuntu 22.04, the "Always Free" shape).
2. Open ports 80/443 in the Oracle Security List for your instance.
3. SSH in and run:

   ```bash
   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/leephil1907-lab/bulltrade/main/deploy/vps-setup.sh)" your-domain.com
   ```

   (or clone the repo and run `deploy/vps-setup.sh`). It installs Node 20, pm2,
   Caddy (automatic HTTPS) and starts the app. Works on any Ubuntu VPS, and
   `DATA_DIR` defaults to the repo's `data/` on a real disk — no GitHub sync
   needed.

---

## 26. PWA (installable app) & Web Push notifications
- The site is a full **Progressive Web App**: `public/manifest.webmanifest` (standalone display, 192/512 + maskable icons, app shortcuts), `public/sw.js` (service worker: offline shell + `offline.html` fallback, cache-first for `/assets/*`, network-only for `/api/*` and `/admin`), and an install banner (`beforeinstallprompt` on Android/desktop; Share → Add to Home Screen instructions on iOS).
- Users install via the banner, the footer **Install App** link, or the browser's own install button — no app store needed. For a Play Store presence later, wrap the PWA with PWABuilder (free) into an APK/AAB.
- **Web Push** (VAPID) is wired end-to-end: users enable via **Notifications** (footer link / user menu) → subscription stored in `push_subs`. Admin → Settings → **Push Notifications**: generate keys, see subscriber count, broadcast a pop-up notification to everyone. Broadcasts are also the mechanism for future per-user event pushes.
- The platform's one runtime dependency (`web-push`) is declared in package.json AND **vendored at `vendor/node_modules/`** (17 packages, ~0.5MB) — `lib/push.js` requires node_modules first and falls back to the vendored copy, so deploys work even when the host runs no `npm install` (Render services created before dependencies existed may have an empty build command). If you ever set a Build Command in Render, use `npm install` — either path works.
- If keys are missing or web-push is not installed, `/api/push/config` returns `ready:false` and the UI degrades gracefully — nothing else breaks.
- **iOS/iPadOS**: web push works only when the site is installed to the home screen (an OS limitation); the UI explains this to iOS users automatically.

## 27. SEO is deliberately GLOBAL (no country targeting)
- The site carries **zero geo signals**: no `geo.region`/`geo.placename` meta, no `og:locale`, no hreflang, no country names in titles/descriptions. The signup country dropdown is the full A–Z world list with a neutral "Select country…" placeholder — it is not geo-targeting.
- Homepage has **Organization JSON-LD** (`sameAs` → TikTok/Instagram/X/YouTube) — country-neutral structured data that helps global brand recognition in search. If the domain changes, update the absolute `og:*`, JSON-LD and sitemap URLs (one-line sed).
- **Google Search Console**: when the property is added, leave *International Targeting → Country* **unset** (this is the default) — "unlisted" means worldwide. Do NOT select a target country. Skip Google Business Profile unless a local presence is specifically wanted (it is a local-SEO tool).
- Marketing keywords should be worldwide ("best demo trading app", "how to trade gold online", "crypto trading for beginners") rather than any single country.
- Future multi-language: only add `hreflang` + translated pages when non-English audiences justify it.

## 28. Languages & display currencies (globe picker)
- **Header globe button (🌐 EN)** opens the language + currency picker. Languages (flag-matched): 🇬🇧 English, 🇪🇸 Español, 🇫🇷 Français, 🇵🇹 Português, 🇩🇪 Deutsch, 🇨🇳 中文, 🇮🇳 हिन्दी. Currencies (flag-matched, 19): USD, EUR, GBP, CAD, AUD, JPY, CNY, INR, NGN, ZAR, BRL, MXN, AED, SAR, TRY, CHF, KES, GHS, PHP.
- Translation coverage (client-side, `I18N` dictionary in common.js + `data-i18n`/`data-i18n-html` attributes): site chrome (nav, user menu, footer incl. fraud alert), homepage hero/CTAs/stats, login/signup headings, install banner. Page bodies beyond the homepage remain English this pass — extend by adding `data-i18n` attributes + dictionary keys.
- **Currency is display-only**: all accounts, wallets and trading remain USD; `BB.fmtUSD`/`BB.fmtPrice` convert at render time using `/api/fx` (open.er-api.com, 12h server cache in `settings.fx`, hardcoded seed fallback). Static marketing prices use `<span data-usd="10000">$10,000</span>`. Switching currency dispatches `bb:fx` (pages re-render on their poll cycles). The admin panel intentionally stays USD/English.
- Choice persists in localStorage (`bbLang`, `bbCur`); `<html lang>` updates for accessibility/SEO.
- **Smart pairing:** language and currency are deliberately independent (a French speaker in Lagos legitimately wants FR + NGN — same as Amazon/Booking). To keep it intuitive, picking a language auto-switches the display currency to that locale's default (EN→USD, ES/FR/PT/DE→EUR, ZH→CNY, HI→INR) with a toast — but ONLY until the user manually picks a currency (`bbCurSet`), after which manual choice always wins. The picker note explains the independence in all 7 languages.
- **Country works invisibly (v18, revised in S30):** country is chosen at **signup** (flag dropdown that switches the display currency live) or comes from the account at login; on a first-ever visit a **silent IP-location detector** (`GET /api/geo`: reads `X-Forwarded-For`, looks up country via ipwho.is, caches by SHA-256-hashed IP for 30 days in `settings.geoCache`, private IPs → null) applies the matching display currency with **no UI and no prompt** — and it never overrides a manual currency pick (`bbCurSet`) or a signup/login country. The header button no longer shows country; it is now TWO independent pickers: 🌐 **language** (pure translation — never touches currency) and 💰 **currency** (precise, site-wide, exact symbol per row; shared glyphs disambiguated: CNY `CN¥` vs JPY `¥`, CHF `CHF `). Swap modal fee/value on /trade render in the display currency (`BB.fmtUSD`). The `COUNTRY_CUR` map (196 ISO→currency) still backs signup, login and the geo detector.
- No hreflang: translations are client-side on the same URLs (Google indexes the English source; JSON-LD remains the global signal).
- Flag emoji note: Windows desktop Chrome renders regional-letter pairs instead of flag emoji (a Windows limitation); all mobile platforms and macOS show real flags.

