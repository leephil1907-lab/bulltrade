# Deploying Blockchain Bullhorn

A zero-dependency Node.js app (Node 18+) that serves 21 pages, a REST API,
and stores all state in `data/` (JSON database + uploaded KYC/deposit-proof
files). It needs **one long-running Node process with a persistent disk
mounted at `data/`**.

## Where to host it

| Host | Fit | Notes |
|---|---|---|
| **Render.com** (recommended) | ✅ | GitHub auto-deploy on every push, Docker support, persistent disk. Blueprint included (`render.yaml`). |
| Fly.io | ✅ | `fly launch --dockerfile Dockerfile` + attach a volume at `/app/data`. |
| VPS (Hetzner, DigitalOcean, …) | ✅ | `git pull && pm2 start server.js` behind nginx. Cheapest full control. |
| Railway / Koyeb | ⚠️ | Works, but add a persistent volume or state is lost on redeploy. |
| **Deno Deploy / Vercel / Netlify functions** | ❌ | **Not suitable** — see below. |

### Why not Deno Deploy (or any serverless platform)

Even though this app has zero npm dependencies and could technically boot on
Deno's Node compat layer, two hard blockers make it unworkable in production:

1. **Ephemeral filesystem.** Serverless platforms reset the filesystem on
   every cold start and redeploy. This app keeps its entire database
   (`data/db.json` — users, balances, wallet addresses, settings) and all
   uploaded KYC documents / deposit proofs in `data/`. On Deno Deploy every
   user registration, deposit and upload would be silently wiped.
2. **No arbitrary outbound TCP.** The built-in SMTP mailer (welcome emails,
   2FA notifications, admin test emails) speaks raw SMTP over TCP, which
   serverless platforms block (HTTP fetch only).

The app needs exactly one always-on Node process with persistent storage —
which is what Render/Fly/VPS provide.

## Option A — Render.com (easiest, auto-deploys on every git push)

1. Go to [render.com](https://render.com) → **New → Blueprint** and pick this repo.
   Render reads `render.yaml` automatically: web service + 1 GB persistent
   disk at `/app/data`.
2. When prompted, set the secret environment variables (see table below).
3. Deploy. Every future `git push` to `main` auto-deploys.

## Option B — Fly.io

```bash
fly launch --dockerfile Dockerfile --name blockchain-bullhorn
fly volumes create bb_data --size 1
# map the volume to /app/data in fly.toml, then:
fly deploy
```

## Option C — any VPS

```bash
git clone https://github.com/<you>/<repo>.html && cd <repo>
npm i -g pm2
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='strong-password' pm2 start server.js --name bullhorn
# put nginx (or caddy) in front as an HTTPS reverse proxy to :3000
```

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no | HTTP port (default 3000). Hosts inject this automatically. |
| `JWT_SECRET` | recommended | Session-token signing key. If unset, one is generated and stored in `data/.jwt-secret`. Set it so restarts/multiple instances don't invalidate sessions. |
| `ADMIN_EMAIL` | first boot only | Seeds the admin account. |
| `ADMIN_PASSWORD` | first boot only | Seeds the admin account. If unset, a random password is printed to the console once — save it. |

## ⚠️ After the first deploy (important)

The repository deliberately ships with **empty deposit wallet addresses**
(they are runtime data, not code, so they are never committed). On a fresh
deployment:

1. Log in at `/admin` with the seeded admin account and **change the password**.
2. **Admin → Settings → Crypto Deposit Addresses** — paste the real wallet
   addresses (USDT TRC-20/ERC-20, BTC, ETH, SOL, BNB, XRP, LTC, DOGE, TRX,
   ZEC). Each coin activates instantly once its address is saved.
3. Configure **SMTP** (host, port, user, password, from) and send a test email.
4. Paste the **Smartsupp live-chat key**.
5. Configure the weekly contest prize if desired.

Everything above lives in `data/db.json` on the persistent disk — it survives
redeploys and restarts, and it is excluded from git on purpose.

## Health check

`GET /` returns `200` — point your host's health check at it.
