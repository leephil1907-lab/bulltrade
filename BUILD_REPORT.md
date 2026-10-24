# Bulltrade — Build & Fix Report

**Repo:** `leephil1907-lab/bulltrade` (package name: `blockchain-bullhorn` v1.0.0)
**Date:** 2026-10-24
**Result:** builds and runs clean. `npm test` → **exit 0**, 311/311 e2e + 119/119 link checks.

---

## 1. Stack

Not a framework app — plain **Node.js 18+** with a hand-rolled HTTP server. No bundler, no
transpile step. `server.js` serves 21 static pages + a REST API, with a file-backed JSON
database (`data/db.json`) and one optional dependency (`web-push`).

So "the build" is: `npm ci` → `node server.js`. Both were already sound.

## 2. Verification performed

| Check | Result |
|---|---|
| `npm ci` (lockfile install) | ✅ 17 packages, **0 vulnerabilities** |
| `node --check` on all server/lib/test files | ✅ 0 syntax errors |
| Cold boot, fresh DB | ✅ seeds admin, 4 trading bots, community team |
| 15 page routes + static assets | ✅ all HTTP 200 |
| Inline `<script>` blocks (43) + external JS (8) | ✅ 0 syntax errors |
| Live market APIs (CoinGecko/Yahoo) | ✅ 62 assets, live candles |
| e2e suite | ❌ 5 failed + **crash** → ✅ **311/311** |
| Link crawler | ✅ 119/119 |
| Bots smoke test | ✅ pass |
| Docker runtime (no `node_modules`) | ✅ boots — `web-push` gracefully falls back to a bundled copy |
| Fresh clone + patch + `npm ci` + `npm test` | ✅ **exit 0** |

## 3. Problems found and fixed

### 🔴 1. `npm test` failed out of the box — the blocker (5 failures + hard crash)

**Symptom:** on a clean install the e2e suite failed 5 assertions and then **crashed**
with `TypeError: Cannot read properties of undefined (reading 'id')`.

**Root cause:** the funding and store sections of `tests/e2e.js` assume deposit addresses
and the USDT-ERC20 product wallet are already configured. A fresh install correctly ships
these **blank** (an admin fills them in via the admin console), so:

- `GET /api/store/payment-wallets` → `{}` instead of `{USDT-ERC20: ...}`
- `POST /api/store/purchase` → `400 "product payments are temporarily unavailable"`
- `POST /api/funding/deposit` → `400 "BTC deposits are not yet available"`
- the admin verification step then looked up a purchase that was never created →
  `undefined.id` → **suite crash**, so the ~100 assertions after it never ran.

**Fix:** added a `== SETUP (payment settings) ==` phase at the top of the suite that logs in
as admin and seeds all 11 deposit addresses plus the product wallet before any flow depends
on them. The suite is now self-contained. The later admin login **reuses** that session
instead of redeclaring the cookie.

This is what turned 4 failures + a crash into a full pass, and recovered the ~100
downstream assertions that were previously never reached.

### 🟠 2. `npm test` was not repeatable on a second run

**Symptom:** run 1 passed, run 2 failed `overview stats` — `kycPending: 3`, expected `1`.

**Root cause:** an exact-count assertion against `kycPending`, which naturally accumulates
pending KYC rows across runs. A "should be at least one" check was written as "should be
exactly one".

**Fix:** `kycPending === 1` → `kycPending >= 1`. Verified by running the suite 3× in a row
on the same DB: 311/311 every time.

### 🟠 3. `npm test` required manual setup to run at all

**Symptom:** `npm test` exited immediately with
`Set ADMIN_PASSWORD=<admin password> ... the server must have been started with the same value`.
You had to boot a server by hand, with a matching password, before the tests could run — and
the tests wrote into your real `data/` directory.

**Fix:**
- Added **`tests/run.js`** — boots a throwaway server on a free port with a temporary
  `DATA_DIR` and a random admin password, runs e2e + link check, tears it all down.
  `npm test` now needs **zero setup** and never touches your dev data.
- Added a **`DATA_DIR` environment override** (previously hard-coded in 4 places:
  `lib/db.js`, `lib/backup.js`, `lib/jwt.js`, `lib/markets.js`). Default behaviour is
  unchanged; this also lets you point the app at a custom volume in Docker/Render.
- `tests/e2e.js` now honours `BASE_URL` like `tests/links.js` already did.
- Scripts: `npm test` (all), `test:e2e`, `test:links`, `test:bots`.

### 🟡 4. Missing settings merge for product wallets (`lib/db.js`)

**Symptom:** latent, no visible crash today.

**Root cause:** the DB migration in `load()` back-fills new coins into
`settings.depositAddresses` (explicit merge loop) but does **not** do the same for
`settings.productPaymentAddresses`. It only survived because a generic top-level merge
happened to cover the whole object. As soon as a second product-payment coin is added, the
key would be missing and `POST /api/admin/settings` would iterate `Object.keys(undefined)` →
**500**, with product payments silently reading as "unavailable".

**Fix:** added the matching merge/guard for `productPaymentAddresses`.

## 4. Observations (not fixed — your call)

- **README says "zero npm dependencies"** but `package.json` declares `web-push`. Minor doc
  drift; the app does work without it (bundled fallback).
- **Dockerfile never runs `npm install`.** The image still boots (verified), but it silently
  loses `web-push`, so **web push notifications won't work in the container**. Add
  `COPY package-lock.json ./` + `RUN npm ci --omit=dev` if you want real push.
- **Production checklist items are empty by design** — deposit addresses and the product
  wallet must be set in `/admin` → Settings before deposits/purchases work. This is the same
  thing that tripped the test suite, so it's worth a first-run banner in the admin console.
- `PRODUCTION_READINESS.md` and `DEPLOYMENT.md` are present; I did not audit their claims
  beyond what I verified above.

## 5. How to run

```bash
npm ci
npm start          # http://localhost:3000  ·  /admin for the console
npm test           # self-contained: boot → e2e + link check → teardown
```

**Running instance (live preview):** admin login `admin@blockchainbullhorn.com` /
`Bulltrade2026!` — change after first login. Set deposit addresses under
**Admin → Settings** to enable real deposits and product checkout.

## 6. Files changed

```
lib/db.js          DATA_DIR override + productPaymentAddresses merge (bug fix)
lib/backup.js      DATA_DIR override
lib/jwt.js         DATA_DIR override
lib/markets.js     DATA_DIR override
tests/e2e.js       setup phase seeding wallets, robust stats assertion, BASE_URL
tests/run.js       NEW — self-contained test runner
package.json       test scripts
```

---

# Round 2 — Live prices, branding & wallet persistence

## 7. "Live real market price" — audited, two real problems fixed

**Prices were already live** (CoinGecko primary → Yahoo fallback, refreshed every 45s):
160/160 assets currently have a real quote. But two things were *not* real:

### 🔴 5. The chart could show invented prices
`lib/markets.js` had a 4th-tier fallback, `synthCandles()`, which **fabricated a whole
candle series** from just the current price + 24h change, with a `Math.sin()` wobble to make
it look organic. Whenever every real source failed, the trading terminal displayed a fake
chart that looked completely legitimate.

**Fix:** removed it. The chain is now CoinGecko → Yahoo → 7-day sparkline (real prices,
re-bucketed) → **honest error**. The UI shows "unavailable" rather than lying to a trader.

### 🟠 6. Crypto candles had no real OHLC
`cgCandles()` used `/market_chart`, which returns *price points only* — so every candle was
built as open = high = low = close. **A flat, useless candlestick chart** for every crypto
asset in a trading terminal.

**Fix:** now uses CoinGecko's `/coins/{id}/ohlc` endpoint for genuine
`[t, o, h, l, c]` candles, falling back to the price-point series only if that fails.
Verified: BTC 1W now returns 202 real candles with 1 flat (the in-progress candle).
Stocks already used true OHLC from Yahoo.

## 8. Branding — 70 stock logos replaced

Audited all 160 assets' icons against their tickers. Coin logos were **already correct**
(verified all 67 visually — BTC, ETH, SOL, XRP, DOGE all genuine and matching).

Stock logos were in bad shape:
- **as low as 16×16 px** (GOOGL, XOM, BA, AMD) — badly blurred when scaled
- **wrong artwork**: `V` and `MA` shared the same Mastercard logo, `LLY` showed "LI",
  `KO` was an unreadable smudge
- mixed sources at inconsistent sizes, some near-invisible

**Fix:** replaced all 70 with correct brand logos, normalised to 250×250 with safe padding
so the app's circular mask never clips them. 10 are white-on-transparent (IBM, V, UNH, BA,
DIS, ABBV, BLK, LMT, UBER, NKE) — these get a dark tile so they stay legible on the cream
`--bg-soft` (#eee1c6) background instead of vanishing.

Verified by rendering all 70 through the app's real circular mask on the real background.

Also added a `?v=2` cache-buster so browsers pick up the new artwork instead of serving the
old icons for 24h.

## 9. Wallet addresses vanishing — root cause found & fixed

Your addresses are **not in this workspace** — this instance has its own `data/` that I
reseeded, so they were never here. But this exposes a **real production bug**:

`data/db.json` is gitignored and lives on the host's filesystem. **Render's free tier wipes
it on every deploy**, so any address saved in the admin panel is silently lost — deposits
then fail with "not yet available" and it looks like the app is broken.

**Fix:** wallet addresses can now come from environment variables, applied on **every boot**
and always winning over `db.json`, so a wiped filesystem self-heals:

```
DEPOSIT_ADDRESSES={"BTC":"bc1...","USDT":"T...","USDT-ERC20":"0x...", ...}
PRODUCT_PAYMENT_ADDRESSES={"USDT-ERC20":"0x..."}
ADDRESS_BTC=bc1...        # optional per-coin shorthand
```

Unknown coins are rejected with a warning. Documented in `.env.example` and wired into
`render.yaml`. Verified: env addresses load on a fresh DB, survive restart, and reject typos.

## 10. Files changed in round 2

```
lib/markets.js                        synth candles removed, real OHLC, logo cache-buster
lib/db.js                             env-seeded wallet addresses
public/assets/img/stocks/*.png        all 70 replaced (correct, 250×250)
.env.example                          wallet env vars documented
render.yaml                           wallet env vars declared
```

---

# Round 3 — Facebook page icon

## 11. Facebook icon added (icon only, no visible URL)

The footer is injected once by `renderFooter()` in `public/assets/js/common.js`, so a single
change places the icon on **all 20 pages** that carry a footer (every public page, admin
excluded — the admin console intentionally has no marketing footer).

- Icon-only: `<i class="fab fa-facebook">` inside the existing social row, next to TikTok,
  Instagram, X and YouTube. **The URL is never displayed as text.**
- Opens in a new tab: `target="_blank"` + `rel="noopener"` (prevents tabnabbing).
- Brand colour `#1877f2` so it's instantly recognisable against the gold footer, with a
  darker `#0b5ed7` hover + soft shadow to match the other buttons' hover lift.
- Added `title` + `aria-label="Facebook"` for hover text and screen readers.
- Also added to the **Contact page** "Get Social" card for consistency.

**Verified:**
- `fa-facebook` (U+F09A) exists in the bundled `fa-brands-400.woff2` — confirmed by reading
  the font's cmap, so it can never render as an empty box.
- All 5 social icons rendered from the real font at the real footer colours.
- Target URL resolves: `HTTP 200` → `facebook.com/people/Blockchain-Bullhorn/61595631804363`.
- `&` correctly encoded as `&amp;` in markup so the `mibextid` param isn't dropped.

**Cache-busting:** bumped `common.js?v=22→23`, `main.css?v=16→17`, `premium.css?v=1→2`,
otherwise browsers would serve the old cached footer for up to 24h and the icon
would appear to be missing.

---

# Round 4 — Header layout, ticker, footer readability

Verified with a real headless Chromium at 1440 / 1280 / 1100 / 980 / 820 / 430 / 390 px,
signed-out **and** signed-in, with screenshots and measured geometry for each.

## 12. Footer was unreadable (dark text on dark background)

`premium.css` forces `.site-footer{background:linear-gradient(#17232b,#0e171d)!important}`
— almost black — but every footer text colour was still the dark maroon (`#57231a`) tuned
for the old gold background. Result: headings, links, description and copyright were all
near-invisible.

**Fix:** retuned the whole footer palette for the dark background — links to
`rgba(236,227,214,.78)`, headings to gold `#d3a877`, body to `.80` white, copyright to
`.62`, and the fraud-alert panel to a translucent white card with a light border.
Hover now goes to pure white with a small x-offset instead of darkening.

## 13. Ticker marquee was broken (items drifting off-screen)

The track used `padding-left:100%` **and** `translateX(-100%)`. `-100%` resolves against the
element's own width — which included the 100% padding — so each cycle travelled roughly
double the content width and left a long empty gap; the strip appeared offset and coins
scrolled in from off-screen.

**Fix:** replaced with a proper seamless loop — two identical `.tick-group` blocks and
`translateX(-50%)`, which is exactly one group width. Also:
- `width: max-content` so the track never clips
- pauses on `:hover` **and** `:focus-within` (keyboard users)
- disabled under `prefers-reduced-motion`
- second group `aria-hidden` so screen readers announce each coin once
- falls back to the ticker's first letter if a logo is ever missing

Prices and logos were already correct — verified all 26 ticker entries against
`/api/markets` (symbol, price, and logo path all matched).

## 14. Header cramped + misaligned across breakpoints

- **Tablet (≤1080px):** the hamburger sat in the *middle* of the header with the actions
  after it. Now: brand left → actions right → burger pinned to the far right edge.
- **Phone (≤720px):** the second row was cramped and misaligned — "Sign Up Free" wrapped to
  two lines and the buttons had mismatched heights (32px vs 49px). Now a single tidy row:
  compact flag pickers (icon + code, chevron hidden), equal-height 40px buttons, and no
  text wrapping.
- Header height on phones dropped 118px → 107px.

## 15. Bottom strapline hidden behind the chat button

On phones the fixed chat launcher overlapped the copyright line. Added bottom padding to
the footer and stacked `.footer-bottom` vertically so the copyright and
"Grab the Bull by the HORNS" strapline are always clear of it.

## 16. Test flakiness (found while verifying)

The suite could fail `BTC price sane` / `BTC has sparkline` on a cold start, because a
freshly launched server has no market cache and CoinGecko sometimes returns 429. The e2e
suite now waits up to 30s for quotes to populate instead of asserting against a
half-loaded snapshot. Two consecutive full runs: **311/311**.

## 17. Files changed in round 4

```
public/assets/css/main.css     footer palette, seamless ticker, header breakpoints, footer spacing
public/assets/js/common.js     ticker renders two .tick-group blocks
tests/e2e.js                   wait for market quotes before asserting
public/*.html                  cache bust: common.js v24, main.css v20
server.js                      cache bust: premium.css v3
BUILD_REPORT.md                this report
```
