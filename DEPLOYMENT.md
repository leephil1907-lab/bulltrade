# Deploying Blockchain Bullhorn — including FREE options

A zero-dependency Node.js app (Node 18+) that serves 21 pages, a REST API, and
stores all state in `data/` (JSON database + uploaded KYC/deposit-proof files).
It needs **one long-running Node process** and somewhere persistent to keep
`data/`.

## Free options at a glance

| Option | Card needed | Always on | Data survives | Verdict |
|---|---|---|---|---|
| **Render free tier** | ❌ no | sleeps after 15 min idle* | ✅ via GitHub data-sync (built in) | **Best zero-cost start** |
| **Oracle Cloud Always Free** | ⚠️ card for verification (never charged) | ✅ | ✅ real disk | Best free production host |
| Railway / Fly.io / Koyeb | trial credits only | — | — | Not reliably free anymore |
| Deno Deploy / Vercel / Netlify functions | — | — | — | ❌ Unsuitable: ephemeral filesystem on every request + no raw TCP for SMTP |

\* A free uptime pinger (cron-job.org / UptimeRobot) hitting `/` every 10
minutes keeps the service awake — Render's 750 free hours/month cover a full
month of 24/7 uptime.

---

## Option A — Render FREE (zero cost, no card, ~10 minutes)

The free tier has no persistent disk — **the app handles this itself**: it
syncs `data/db.json` and `data/uploads/` to a **private GitHub repository**
after every change and restores them automatically on every boot
(`lib/backup.js`, activated by the `BACKUP_REPO` + `BACKUP_TOKEN` env vars).

1. **Create a private data repo** on GitHub (must be PRIVATE — it will hold
   user data and password hashes). One named `bulltrade-data` already exists
   on the project account; you can reuse it or create your own empty private
   repo with a README.

2. **Create a GitHub personal access token** with `repo` scope
   (Settings → Developer settings → Personal access tokens). This is
   `BACKUP_TOKEN`.

3. On [render.com](https://render.com) (no card needed): **New → Web Service**
   → connect your GitHub account → pick this repo. Then:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**

4. **Environment variables** (Render → your service → Environment):

   | Key | Value |
   |---|---|
   | `ADMIN_EMAIL` | your admin email |
   | `ADMIN_PASSWORD` | a strong password (seeds the admin on first boot) |
   | `JWT_SECRET` | long random string (32+ chars) |
   | `BACKUP_REPO` | `yourname/bulltrade-data` |
   | `BACKUP_TOKEN` | the token from step 2 |
   | `NODE_ENV` | `production` |

5. Deploy. First boot seeds the admin account; every deploy/restart restores
   the latest data from the backup repo automatically.

6. **Keep it awake** (optional but recommended): create a free account at
   [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com)
   and ping `https://your-app.onrender.com/` every 10 minutes.

Free-tier limits: 0.1 CPU / 512 MB RAM (plenty for this app), 5 GB
bandwidth/month, 500 build minutes/month.

## Option B — Oracle Cloud Always Free (real VPS, never sleeps)

Genuinely free forever; requires a credit/debit card for identity verification
(**never charged**). You get up to 2 ARM OCPUs / 12 GB RAM (or tiny x86
instances) + 200 GB storage.

1. Sign up at [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) →
   create a VM (Ubuntu 22.04, the free "Always Free" shape).
2. Open ports 80/443 in the Oracle Security List for your instance.
3. SSH in and run:

   ```bash
   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/leephil1907-lab/bulltrade/main/deploy/vps-setup.sh)" your-domain.com
   ```

   (or clone the repo and run `deploy/vps-setup.sh`). It installs Node 20,
   pm2, Caddy (automatic HTTPS) and starts the app. Works on any Ubuntu VPS.

## Option C — paid upgrade later

When you outgrow free: on Render switch the plan to Starter + add a 1 GB disk
(uncomment the block in `render.yaml`) — no code changes needed, the GitHub
sync simply becomes an extra safety net.

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no | HTTP port (default 3000) — hosts inject this automatically |
| `JWT_SECRET` | recommended | Session-token key. Auto-generated to `data/.jwt-secret` if unset |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | first boot | Seed the admin account (a random password is printed to the console if unset) |
| `BACKUP_REPO` | ephemeral hosts | `owner/name` of a **private** GitHub repo for data sync |
| `BACKUP_TOKEN` | ephemeral hosts | PAT with repo scope (used by the sync) |
| `BACKUP_BRANCH` / `BACKUP_DIR` | no | Sync branch (`main`) / path prefix (`data`) |

## ⚠️ After the first deploy

The repo ships with empty deposit wallet addresses on purpose (they are
runtime data, not code). On a fresh deployment either let the backup restore
them or paste them in **Admin → Settings → Crypto Deposit Addresses** — and set
the **Product Payment Wallets** (USDT ERC-20) used for product purchases.
Also:
change the admin password, configure SMTP (test email), paste the Smartsupp
key, and set the contest prize.

**Data-sync rules:** one backup repo per instance (two instances sharing a
repo would fight). Never make the backup repo public — it contains user data.

## Health check

`GET /` returns `200` — point your host's health check / uptime pinger at it.

---

## Finishing Touches (recommended after first deploy)

### 1. Make emails actually send
All transactional emails (connection keys, purchase approvals, password resets) are already coded.
**Render's FREE tier blocks ALL outbound SMTP ports (25/465/587)** — a platform-wide policy since
September 2025 — so direct SMTP cannot work there no matter the credentials. Use an HTTPS-based
transport instead (Admin → Settings → **Email Delivery** → Transport):

**Option A — Gmail Relay via Google Apps Script (free, no new accounts, 100 emails/day):**
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

**Option B — SendGrid API (free 100/day, standard):**
1. Create a free SendGrid account (sendgrid.com) → Settings → Sender Authentication → verify a Single Sender
   using `blockchainbullhornfaqs@gmail.com` (click the confirmation email).
2. Settings → API Keys → Create (Full access) → copy the `SG.…` key.
3. On the site: Admin → Settings → Email Delivery → Transport = **SendGrid API** → paste the key → Save → **Send Test Email**.

**Option C — Render paid instance (from ~$7/mo):** upgrades unblock SMTP ports; the already-working
Gmail SMTP settings (smtp.gmail.com:465 + App Password) then send directly.

All emails are journaled under Admin → Emails regardless of transport (sent/failed/skipped + errors).

### 2. Eliminate cold starts (~1 min delay after idle)
Render's free tier sleeps the service after ~15 min without traffic. Fix with a free uptime pinger:
1. Create a free account at UptimeRobot (uptimerobot.com) or cron-job.org.
2. Add an HTTP monitor for `https://blockchainbullhorn.onrender.com/` every **10 minutes**.
3. That's it — the site stays warm 24/7 and loads instantly for every visitor.

### 3. Custom domain (optional, works on Render free tier)
1. In the Render dashboard open the service → **Settings → Custom Domains** → add e.g. `app.yourdomain.com`.
2. Render shows the DNS records to create at your domain registrar (a CNAME to the Render target).
3. Wait for DNS propagation; Render issues free TLS automatically.
Remember to also update any hardcoded links if you switch the primary domain.

### 4. Watch the bots work
The Trading Bots page has a **Live Bot Activity** feed (recent opens/closes with P/L, refreshed
every 20s), and Admin → Trading Bots shows key requests, allocations and per-bot stats.

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
- No hreflang: translations are client-side on the same URLs (Google indexes the English source; JSON-LD remains the global signal).
- Flag emoji note: Windows desktop Chrome renders regional-letter pairs instead of flag emoji (a Windows limitation); all mobile platforms and macOS show real flags.
