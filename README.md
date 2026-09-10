# 🐂 The Blockchain Bullhorn

A production-grade crypto education and multi-asset **trading platform** — live markets, demo & live trading, copy trading, community onboarding and manual KYC/finances, wrapped in the brand look of [blockchainbullhorn.com](https://blockchainbullhorn.com) (light theme, Quattrocento Sans + PT Serif).

Built with **zero npm dependencies** — plain Node.js 18+ serving 21 pages, a REST API and a file-backed database.

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

**Gamification**
- XP, levels & badges, weekly demo trading contest, referral program

**Platform & security**
- JWT sessions, TOTP two-factor auth, login history, admin console (users, balances, KYC, transactions, chat, email outbox, settings)
- Smartsupp live chat + branded built-in fallback, responsive mobile ↔ desktop, scroll-reveal animations, page transitions and loading skeletons

---

🚀 **Run it:** `npm start` (or `node server.js`) → http://localhost:3000 · Deploy guide: [DEPLOYMENT.md](DEPLOYMENT.md)
