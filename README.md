# Blockchain Bullhorn — Full Platform

A complete rebuild & enhancement of **blockchainbullhorn.com**: brand-faithful frontend
(Quattrocento Sans + PT Serif, espresso/gold/bull-green palette), live market data,
a working trading engine, gated community, copy trading, manual KYC, crypto-only
funding and a full admin back office. Zero npm dependencies — Node.js 18+ only.

## Run

```bash
node server.js        # http://localhost:3000
```

- Website: `/`
- Trading terminal: `/trade` (demo ⇄ live toggle)
- Markets: `/markets` · Copy trading: `/copy-trading` · Community (gated): `/community`
- Dashboard: `/dashboard` · Funding: `/funding` · KYC: `/kyc`
- Admin console (not linked anywhere on the public site): `/admin`

## Default admin account

On first boot the server seeds an admin account. Set `ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env` to control the credentials; if no password is set,
a random one is generated and **printed to the console once** — save it and
change it after first login at `/admin` (Users → Manage).


## Secrets

- Session cookies are **JWTs (HS256)** signed with a server-side secret.
- The secret comes from `JWT_SECRET` in `.env` (see `.env.example`) or is
  auto-generated into `data/.jwt-secret` (file mode 0600).
- `data/` (DB, KYC uploads, secret) lives **outside** `public/` and is never
  served or sent to browsers.

## Tests

```bash
ADMIN_PASSWORD=<your-admin-password> node tests/e2e.js
```

137 end-to-end assertions: pages, assets, auth + 2FA, trading, copy trading,
community gating, funding (deposit proof + admin approval), KYC, chat and
every admin flow.

## Live data

- Crypto: CoinGecko public API (prices, 7d sparkline, market caps)
- Stocks / commodities (RWA) / indices: Yahoo Finance
- Both refresh every 45s server-side; clients poll every 15–20s.
- If upstream feeds fail, the platform serves cached quotes and keeps working.

## Features

- Step-by-step signup wizard (account → profile → experience → KYC upload)
- Login / forgot-password / reset-password (JWT links, 1h expiry)
- Manual KYC verification (admin approves/rejects with documents viewer)
- Demo ($10k, resettable) & live trading across 60+ assets with real branding
- Market / limit orders, leverage, TP/SL, liquidation engine, live P/L
- Custom candlestick charts + official TradingView embed
- Copy trading: leader applications (admin approved), proportional mirroring
- Community: application + onboarding quiz (admin approved), 9-lesson academy
- Funding: crypto-wallet deposits (QR codes) & KYC-gated withdrawals (admin approved)
- Live chat: built-in branded widget (logo avatar) — or real Smartsupp by
  pasting your key in Admin → Settings
- Admin: overview, users (balance adjust, ban, roles), KYC, transactions,
  positions/trades, community apps, copy leaders, chat, settings, audit log
