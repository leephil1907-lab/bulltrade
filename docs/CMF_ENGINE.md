# Bulltrade CMF Engine — implementation foundation

This branch adds a deterministic, UI-independent calculation layer for the
Blockchain Bullhorn CMF methodology. Existing website pages, styles, assets,
navigation, responsive breakpoints and page scripts are intentionally untouched.

## Included

- Risk-first trade sizing from equity, stop distance and a configurable risk cap.
- Exposure and margin caps so position size cannot grow without limit.
- Transparent compounding projections with fees, equity curve and maximum drawdown.
- Swing-pivot market-structure analysis with BOS / CHoCH event labels.
- User-scoped API endpoints for plans, projections, market structure and journaling.
- Persistent JSON collections for CMF runs and journals, isolated by authenticated user.
- Unit tests for core calculations and invalid inputs.

## Safety and scope

- The engine calculates plans; it does not place, modify or close orders.
- It does not claim guaranteed returns or treat a projection as a forecast.
- The market-structure routine is a candle-based heuristic, not exchange order-flow.
- Live execution remains disabled pending the PostgreSQL transaction cutover,
  idempotency, ledger reconciliation and end-to-end settlement verification.
- No existing page, CSS, image, branding, route or navigation file is changed.

## Test

```bash
node tests/cmf.js
```

## API surface

- `GET /api/cmf/overview` — the signed-in user's latest plans and journal entries.
- `POST /api/cmf/plan` — calculate and persist a risk-first plan.
- `POST /api/cmf/projection` — calculate and persist a compounding scenario.
- `POST /api/cmf/structure` — analyse up to 500 supplied OHLC candles.
- `POST /api/cmf/journal` — attach one manually entered realised P/L result to a plan.

All endpoints require authentication. The journal is an educational performance
record and does not change wallet balances, positions, orders or the financial
ledger. The existing CMF page is not modified in this phase; connecting its
existing interface is the next UI integration step and must preserve its markup
and visual treatment.
