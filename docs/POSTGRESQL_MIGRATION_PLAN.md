# PostgreSQL migration plan

## Objective and boundary

Replace the JSON file store as the authoritative source for accounts and financial state. Keep the existing HTTP/API contract where practical, but move money-affecting operations into PostgreSQL transactions. This plan is not a claim that Bulltrade is approved to custody or trade real customer funds.

## Phase 0 — Baseline and safety gates

- Keep live trading disabled while migration work is in progress.
- Take an encrypted, access-controlled backup of the JSON store and uploaded documents; test restoration.
- Record counts and stable identifiers for users, sessions, wallets, ledger entries, orders, positions, trades, funding requests, KYC records, and audit events.
- Run the current end-to-end suite against a disposable environment; capture failures before changing persistence.
- Define a retention policy for KYC files, authentication events, and financial records before copying production data.

## Phase 1 — Schema and invariants

Create migrations for:
- `users`, `sessions`, `wallets`
- `ledger_entries`, `transactions`, `deposits`, `withdrawals`
- `orders`, `positions`, `trades`, `copy_allocations`
- `kyc_cases`, `audit_events`, and operational settings

Required constraints:
- Primary keys for every row; foreign keys for user-owned records.
- Unique normalized user email and unique external transaction/idempotency keys.
- Check constraints for positive ledger amounts, supported directions/modes, and non-negative wallet balances where the business rules require them.
- Store money in integer minor units (USD cents) or fixed-precision NUMERIC; never use floating-point columns for monetary amounts.
- Use UTC timestamps and explicit status enums/check constraints.
- Treat the ledger as append-only; corrections are compensating entries, not edits/deletes.

## Phase 2 — Transaction boundaries

Each money-affecting command must be one database transaction:
1. Authenticate/authorize and validate the request.
2. Lock the relevant wallet row (`SELECT ... FOR UPDATE`) or use a conditional atomic update.
3. Check available funds and idempotency key inside the transaction.
4. Write wallet changes, ledger entries, and the business record together.
5. Commit once; roll back all changes on any failure.

Initial transaction inventory:
- Order placement and margin/fee reservation.
- Limit-order cancellation and reservation release.
- Trade close, TP/SL, liquidation, and copy-trading allocation settlement.
- USD legs of swaps and any coin balance mutations.
- Deposit approval, withdrawal request/approval/rejection/refund, and admin adjustments.
- Demo reset and showcase/demo top-ups (keep these clearly segregated from live balances).

Do not call external market, email, CRM, or blockchain services while holding a database transaction open. Use an outbox/job pattern for side effects after commit.

## Phase 3 — Idempotency and concurrency

- Require server-generated or client-supplied idempotency keys for funding operations, swap execution, order submission, withdrawal processing, and admin adjustments.
- Enforce uniqueness in PostgreSQL, not only with an in-memory lookup.
- Make retries return the original result instead of applying a second debit/credit.
- Add concurrent-request tests for two withdrawals/orders competing for the same balance.
- Add reconciliation checks comparing wallet read models with the signed ledger balance, scoped by user, mode, and currency.

## Phase 4 — Dual-read verification and cutover

- Build a one-time importer that is restartable and reports per-table counts, rejected rows, duplicate IDs, and totals.
- Import into staging first; compare balances, open orders/positions, and ledger totals against a frozen JSON snapshot.
- Run read-only shadow comparisons; never dual-write money movements to two independent stores without a proven consistency mechanism.
- Schedule a short write freeze for final import and verification.
- Switch reads/writes to PostgreSQL only after reconciliation is exact; retain the encrypted source snapshot according to retention policy and a tested rollback window.

## Phase 5 — Acceptance criteria

- Every wallet balance reconciles to posted ledger entries within the defined minor-unit tolerance.
- Repeated requests with the same idempotency key create one financial effect.
- Concurrent requests cannot overspend a wallet.
- Rejected or failed funding/trade flows roll back cleanly.
- Restart/restore and migration rerun tests pass.
- E2E, integration, migration, and security tests pass in CI.
- Operations has alerts for failed migrations, database saturation, repeated reconciliation differences, and failed background jobs.

## Suggested implementation order

1. Introduce a persistence interface behind current data access.
2. Add PostgreSQL schema migrations and repository implementations.
3. Move wallet + ledger primitives to SQL transactions first.
4. Migrate swap, order, settlement, and funding paths one at a time with regression tests.
5. Import legacy data and cut over only after reconciliation.
