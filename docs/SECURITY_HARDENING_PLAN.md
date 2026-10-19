# Security hardening plan

## Immediate controls

- Keep live trading and withdrawals disabled until accounting tests and independent review pass.
- Use deployment-managed secrets only; rotate any credential that may have entered logs, backups, or Git history.
- Require production `NODE_ENV=production`, strong JWT/session secrets, secure cookies, and an explicit trusted-proxy configuration before using forwarded IP headers.
- Ensure password-reset tokens are single-use, short-lived, stored hashed, and never returned in production API responses or logs.
- Apply rate limits to login, signup, password reset, 2FA challenges, KYC uploads, and funding endpoints.
- Verify authorization on every object access: a user must not read or mutate another user's wallet, order, position, KYC case, or transaction by changing an ID.
- Enforce strict upload MIME/content validation, size limits, safe filenames, storage outside public paths, and malware scanning where available.
- Keep private data backups private, encrypt them, scope backup tokens to the minimum permissions, and test restore procedures.

## Money-path hardening

- Route every USD wallet mutation through one journal-aware service; prohibit direct `wallet.usd = ...` writes outside a controlled persistence module.
- Persist wallet, ledger, transaction, and order/withdrawal status changes atomically.
- Use idempotency keys and database uniqueness constraints to prevent duplicate deposits, duplicate refunds, repeated withdrawals, and double execution on retries.
- Add invariant tests for insufficient funds, duplicate requests, failed settlement rollback, order reservation/release, swap legs, demo reset, and admin adjustments.
- Reconcile balances on a schedule and alert on any non-zero difference; never silently repair live balances without an audited compensating entry.
- Require two-person approval or step-up authentication for high-risk admin actions such as approving withdrawals, changing deposit addresses, or adjusting live balances.
- Separate demo/showcase balances and activity clearly from live funds and financial reporting.

## HTTP and deployment

- Verify TLS, secure cookie flags, CSRF protections for cookie-authenticated state-changing requests, strict CORS policy, request body limits, security headers, and safe error responses.
- Avoid exposing stack traces, filesystem paths, reset tokens, internal identifiers, or secrets in API errors.
- Run dependency and secret scanning in CI; pin GitHub Actions to reviewed immutable commit SHAs for hardened release workflows.
- Run tests on a disposable database; CI must never connect to production data or use production credentials.
- Restrict database network access, use a least-privilege database role, require TLS where supported, and test backup encryption and restoration.
- Record admin actions in an append-only audit log without logging passwords, session tokens, KYC document contents, or full payment credentials.

## Release gate

Do not enable real-money trading or withdrawals until the PostgreSQL transaction migration, accounting reconciliation, security review, restore drill, and funding idempotency tests have all passed. This checklist is a work plan, not a completed security certification.
