# Exchange integration boundary

## Current status

Bulltrade has live market quotes, but it does not have exchange order execution. The internal trading engine uses cached quotes and Bulltrade's JSON-backed demo wallets. Do not treat its fills, balances, deposits, or withdrawals as exchange-settled money.

**Live trading must remain disabled.** Setting `LIVE_TRADING_ENABLED=true`, changing an admin setting, or adding provider credentials must not enable live orders by itself.

## Integration sequence

1. **Choose the product model.** Decide whether Bulltrade is a paper-trading simulator, a non-custodial trading terminal where each user connects their own exchange account, or a custodial/brokerage service. These models have very different security, operational, and legal requirements.
2. **Confirm provider eligibility.** Check official provider terms, supported countries, account/business approval requirements, derivatives permissions, and whether the intended multi-user product is permitted. Do not assume an API key from a personal account authorizes a brokerage service.
3. **Build a provider-neutral adapter.** Define explicit methods for account permissions, balances, order submission, order lookup, cancellation, fills, and health. Normalize provider-specific symbols, statuses, errors, decimal precision, minimum notional, and rate limits.
4. **Start with sandbox/testnet.** Keep production credentials out of source control and browser code. Use least-privilege keys; disable withdrawals and transfers wherever the provider permits. Never log secrets or signed request material.
5. **Make order submission idempotent.** Persist an internal order intent and unique client order ID before sending it. On timeout, reconcile by client order ID before retrying; never blindly resubmit an order whose outcome is unknown.
6. **Reconcile provider state.** Periodically compare balances, open orders, fills, fees, and positions with provider records. A timeout or webhook must not be interpreted as proof of success or failure.
7. **Separate execution from accounting.** Use a transactional database for order intents, provider IDs, fills, ledger entries, and reconciliation checkpoints. Enforce unique constraints and atomic balance/ledger updates.
8. **Test failure modes.** Cover duplicate requests, partial fills, rejection, cancel/fill races, rate limits, network timeouts, process restarts, stale prices, insufficient balances, precision rules, and provider outages.
9. **Independent review before launch.** Review security, custody and consumer disclosures, market-abuse controls, incident response, and legal/regulatory obligations for every target jurisdiction.

## Required safety gates before enabling execution

- A real adapter is implemented and explicitly registered; no implicit provider selection.
- Provider account and product permissions are verified at runtime.
- Live execution has separate server-side feature flags and an emergency kill switch.
- Orders, fills, balances, and ledger entries are persisted transactionally and reconciled.
- Demo and live accounts cannot share or accidentally cross-credit balances.
- Automated integration tests run against a provider sandbox.
- Credentials are stored only in deployment secrets and rotated safely.
- A documented rollback and incident-response procedure exists.

Until all gates are satisfied and reviewed, the application should continue rejecting every live-mode order. A quote feed alone is not an execution connection.
