# Bulltrade production readiness

## What changed

This phase focuses on product integrity rather than visual effects.

- **Server-authoritative trading controls**: global trading enable/disable, live-trading kill switch, global maximum leverage, and global maximum order size.
- **Capability API**: `GET /api/me/capabilities` exposes server-derived permissions for demo/live trading, funding, withdrawals, bots, KYC state and account status.
- **Dashboard summary API**: `GET /api/dashboard/summary` consolidates portfolio state, positions, pending transactions, recent trades and ledger activity.
- **Append-only money journal**: `lib/ledger.js` records wallet credits/debits. Legacy wallet balances receive an opening-balance migration entry.
- **Reserved limit orders**: limit orders reserve margin + fee at placement and release the reservation on cancellation. Filled orders no longer debit the same funds a second time.
- **Trade settlement journaling**: trade opening debits and trade settlement credits are recorded in the ledger.
- **Admin balance controls**: manual wallet adjustments now pass through the ledger instead of mutating the wallet directly.
- **Ledger reconciliation**: `GET /api/admin/ledger` reports wallet-vs-journal differences and recent entries.
- **Single Super Admin control plane**: additional admin promotion/revocation is disabled through the user workflow.
- **Authentication hardening**: production session cookies are marked `Secure`; password-reset tokens are no longer returned by the API in production.
- **Operational probes**: `/healthz` and `/readyz` are available for deployment health checks.
- **Graceful shutdown**: SIGTERM/SIGINT flush the data store before process exit.
- **HTTP hardening headers**: basic anti-sniffing, frame, referrer and permissions headers are applied globally.

## Current architecture boundary

The repository still uses a JSON/file-backed hot data store. The ledger is an append-only journal layered onto that store; it is **not yet a PostgreSQL transaction boundary**.

For a real-money production launch, the next persistence migration should move:

1. users/auth/session state
2. wallets
3. ledger entries
4. orders
5. positions
6. trades
7. deposits/withdrawals
8. KYC state
9. audit events

to PostgreSQL with database transactions and unique/idempotency constraints.

The current implementation deliberately preserves the existing application architecture while making cash mutations journaled and auditable.

## Required production environment

At minimum configure:

- `NODE_ENV=production`
- a strong `JWT_SECRET`/JWT signing secret used by the existing JWT implementation
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- a real transactional email transport
- a persistent data volume **or** an external database
- market-data provider/API credentials where required by the configured market adapter

Do not store production secrets in `data/db.json`, the public directory, Git history, or client-side JavaScript.

## Deployment checks

Health check:

`GET /healthz`

Readiness check:

`GET /readyz`

Before enabling live trading, verify:

- wallet and ledger balances reconcile
- deposits cannot be credited twice
- withdrawal rejection refunds exactly once
- limit-order reservation cannot be double-spent
- close/TP/SL/liquidation settlements are balanced
- admin balance changes appear in the ledger and audit log
- banned/frozen users cannot authenticate
- 2FA login and disable flows work
- password-reset email delivery works without exposing tokens
- the live trading kill switch blocks new live orders server-side
- database persistence survives restart

## Important

This phase improves application controls and accounting traceability, but it does not by itself constitute a regulated brokerage/exchange stack, custody system, blockchain settlement layer, or production financial-services approval.
