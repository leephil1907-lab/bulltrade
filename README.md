# 🐂 The Blockchain Bullhorn

Crypto education, live markets and a multi-asset trading platform — plain
Node.js 18+ serving 21 pages, a REST API and a file-backed database. One runtime
dependency (`web-push`); no framework, no build step, no database server.

## Features

**Markets & data**
- 62 live-tracked assets — crypto (CoinGecko), stocks, indices & real-world assets (Yahoo Finance), auto-refreshing
- Watchlists, top gainers/losers, price alerts, live ticker bar

**Trading**
- Full trading terminal: market & limit orders, leverage, take-profit / stop-loss, trailing stops, liquidation
- Candlestick chart with EMA, Bollinger Bands, RSI and MACD panes + TradingView embed
- Demo ($10,000 virtual) ⇄ live trading toggle

**Copy trading**
- Leader applications, admin approval, proportional trade mirroring

**Community & education**
- Application-gated community with admin onboarding flow
- Courses, products, mentorship and the CMF engine pages

**Finance (admin-controlled)**
- Crypto deposits for 11 coins (USDT TRC-20/ERC-20, BTC, ETH, SOL, BNB, XRP, LTC, DOGE, TRX, ZEC) with TXID + mandatory proof upload
- Manual admin verification → balance credit; withdrawals gated by KYC
- Step-by-step KYC with document uploads
- Append-only money journal (`lib/ledger.js`) with wallet-vs-ledger reconciliation

**Gamification**
- XP, levels & badges, weekly demo trading contest, referral program

**Platform & security**
- JWT sessions, TOTP two-factor auth, login history, admin console (users, balances, KYC, transactions, chat, email outbox, settings)
- Request throttling on the anonymously abusable endpoints (`lib/ratelimit.js`)
- Smartsupp live chat + branded built-in fallback, responsive mobile ↔ desktop, scroll-reveal animations, page transitions and loading skeletons
- Installable PWA with VAPID web push

---

## Run it locally

```bash
npm ci          # or: npm install
npm start       # -> http://localhost:3000  (admin panel at /admin)
```

```bash
npm test        # 457 checks: e2e API/UI suite + link crawl + hardening suite
```

`npm test` boots throwaway servers on free ports with a temporary `DATA_DIR`, so
it never touches your local `data/` directory and needs no `ADMIN_PASSWORD`.

## Deploy it

**`render.yaml` is configured for a paid, always-on deployment with a persistent
disk** — Starter instance ($7/mo) + 1 GB disk ($0.25/mo) ≈ **$7.25/mo**.

On Render: **New → Blueprint** → connect GitHub → pick this repo. It creates the
service with the right plan, disk, health check and environment variables.

The two settings that must agree are the disk's `mountPath` and `DATA_DIR` — both
`/var/data`. Mounting at `/app/data` is the classic mistake: that is the *Docker*
working directory, and this service uses Render's native Node runtime, whose
source tree is `/opt/render/project/src`. Confirm it after the first deploy at
**`/healthz`**, which reports the resolved `persistence.dataDir` and the current
`dbBytes`.

Full guide, free-tier fallback, VPS script and email setup:
**[DEPLOYMENT.md](DEPLOYMENT.md)** · production checklist and architecture
boundary: **[PRODUCTION_READINESS.md](PRODUCTION_READINESS.md)**

## Performance notes

Static assets are memoised in memory (validated by mtime + size) and served with
an ETag, so a returning visitor gets a `304` instead of the bytes. Measured
against the previous read-from-disk-every-time implementation:

| | before | after |
|---|---|---|
| homepage throughput | 577 req/s | 927 req/s (**1.6×**) |
| homepage p50 latency | 1.50 ms | 0.84 ms (**1.8×** faster) |
| 2.4 MB hero image p50 | 5.34 ms | 3.31 ms |
| 25 concurrent clients | 1,304 req/s | 1,942 req/s |
| egress, 400 revisits | 12.98 MB | **0 KB** |

Egress matters on Render: bandwidth is metered past the workspace allowance at
$0.15/GB. RSS stays near 70 MB idle and ~115 MB with all 257 assets cached,
against the Starter plan's 512 MB.
