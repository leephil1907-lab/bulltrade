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

### 1. Make emails actually send (SMTP)
All transactional emails (connection keys, purchase approvals, password resets) are already coded —
they send through SMTP the moment credentials are configured. No code changes needed:

1. Create a FREE Brevo account (brevo.com, 300 emails/day free) — or use a Gmail account with an
   App Password (Google Account → Security → 2-Step Verification → App passwords).
2. Log into the site as admin → **Admin → Settings → SMTP** and fill in:
   - Brevo: host `smtp-relay.brevo.com`, port `587`, user = your Brevo login email, pass = Brevo SMTP key, from = `blockchainbullhornfaqs@gmail.com`
   - Gmail: host `smtp.gmail.com`, port `587`, user = your Gmail, pass = the App Password (not your normal password), from = the same Gmail
3. Click **Send Test Email** to verify. Done — key approvals, purchase confirmations and resets
   now arrive in real inboxes (they also stay logged under Admin → Emails).

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
