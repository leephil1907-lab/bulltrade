# Bulltrade CMF Engine — implementation foundation

This branch adds a deterministic, UI-independent calculation layer for the
Blockchain Bullhorn CMF methodology. Existing website pages, styles, assets,
navigation, responsive breakpoints and page scripts are intentionally untouched.

## Included

- Risk-first trade sizing from equity, stop distance and a configurable risk cap.
- Exposure and margin caps so position size cannot grow without limit.
- Transparent compounding projections with fees, equity curve and maximum drawdown.
- Swing-pivot market-structure analysis with BOS / CHoCH event labels.
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

## Next integration stage

Expose these calculations through authenticated, user-scoped API handlers and
persist strategy configurations / run history. Only then wire the existing CMF
experience to the API, preserving its current markup and visual treatment.
