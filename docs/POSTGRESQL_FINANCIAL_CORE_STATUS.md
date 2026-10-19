# PostgreSQL financial core status

## What is implemented on this branch

- `migrations/001_financial_core.sql` creates integer-minor-unit wallet balances, append-only ledger rows, operation idempotency records, and transaction/order/position tables with constraints.
- `lib/pg-money.js` provides SERIALIZABLE transactions with retry on serialization/deadlock errors, locked wallet rows, atomic credit/debit movements, request-hash checked idempotency, and wallet-vs-ledger reconciliation.
- `tests/pg-money.js` exercises duplicate retries, key reuse with a different payload, concurrent debits, non-negative balances, and ledger reconciliation against a real PostgreSQL service in CI.
- CI runs the SQL migration and PostgreSQL integration tests before the app E2E and link suites.
- `lib/financial-safety.js` keeps live-money paths disabled by default. Only the disposable test environment can opt into the legacy JSON live-flow tests.

## Important boundary

The current app still uses `lib/db.js` and the JSON file store for application state. The PostgreSQL money core is a tested transactional foundation, **not yet the source of truth for every live trading/funding endpoint**. Do not set `POSTGRES_MONEY_INTEGRATED` to true or remove the live-money gate until the user/wallet migration, order lifecycle, deposits, withdrawals, swaps, copy allocation, admin adjustments, and settlement paths all call the PostgreSQL service inside a single transaction and have end-to-end reconciliation coverage.

## Local verification

1. Provide a disposable PostgreSQL database through `DATABASE_URL`.
2. Apply `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_financial_core.sql`.
3. Run `npm run test:pg`.
4. Run `npm test` and `npm run test:links` against a disposable JSON data directory, never production data.

## Cutover gate

A future integration PR must migrate a frozen data snapshot, reconcile every wallet to posted ledger entries, enforce a unique idempotency key on each financial command, prove concurrent requests cannot overspend, and verify rollback on any failure. Keep live trading, deposits/withdrawals, and live admin adjustments disabled until that gate passes.
