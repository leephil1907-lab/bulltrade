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

## Deployment & delivery hardening (this phase)

- **Paid, always-on Render blueprint**: `render.yaml` now targets `plan: starter`
  with a 1 GB persistent disk, so the instance never sleeps and `data/` survives
  every deploy, restart and crash. Previously `plan: free` meant an ephemeral
  filesystem — `db.json`, KYC documents and deposit proofs were wiped on each
  deploy and could only be recovered from the GitHub mirror.
- **Correct disk mount path**: the disk mounts at `/var/data` with
  `DATA_DIR=/var/data`. The earlier commented-out block used `/app/data`, which is
  the *Docker* working directory; this service uses Render's **native Node
  runtime** (source tree `/opt/render/project/src`), so `/app/data` would have
  mounted the disk somewhere the app never writes and silently left data
  ephemeral.
- **Health check wired up**: `healthCheckPath: /healthz`, so Render restarts an
  unresponsive instance and does not route traffic to a half-booted one.
  `/healthz` now reports `persistence.dataDir`, `persistence.dbBytes` and
  `rateLimit.enabled`, which makes "is the disk actually mounted?" answerable
  from a browser immediately after the first deploy.
- **Graceful shutdown reaches Node**: the start command is `node server.js`
  rather than `npm start`, so Render's SIGTERM arrives directly at the process
  that flushes `db.json`. This matters more now that a disk is attached, because
  attaching one disables zero-downtime deploys — the old instance is stopped
  before the new one starts.
- **Reproducible builds**: `npm ci --omit=dev` against the committed lockfile,
  with `NODE_VERSION` pinned. The `Dockerfile` was also fixed — it copied
  `package.json` but never ran an install, so the image shipped without
  `node_modules`; it also declared `VOLUME /app/data`, which can shadow a
  platform-attached mount, and ran as root.
- **Request throttling** (`lib/ratelimit.js`): signup, password reset, 2FA
  verification, lead capture, support tickets and chat were previously unlimited
  for anonymous callers. `lib/auth.js` already throttled failed logins, but these
  paths both write to the database and trigger email, so an unthrottled loop
  could exhaust a provider's daily allowance and take transactional mail down for
  real users. Counters are keyed on the **last** `X-Forwarded-For` hop — the value
  our own trusted proxy appends — so a client cannot rotate a spoofed first hop
  to get unlimited fresh buckets. Keying on `socket.remoteAddress` would have
  lumped every visitor into one bucket behind Render's edge.
- **Conditional requests + in-memory static cache**: assets are memoised
  (validated by mtime + size) and served with a weak ETag and `Last-Modified`, so
  a returning browser gets a `304` with no body. Images/fonts moved from
  `max-age=86400` to `max-age=604800`, deliberately **without** `immutable`,
  because asset URLs are not fingerprinted — `immutable` would pin a re-exported
  `hero-banner.png` in browsers for the whole max-age. Error responses are never
  cached and never answer `304`.
- **HSTS**: `Strict-Transport-Security: max-age=31536000` is sent when the edge
  reports `X-Forwarded-Proto: https`, and never over plain HTTP. `includeSubDomains`
  is intentionally omitted so a future non-TLS subdomain is not bricked for a year.


## Current architecture boundary

**Durability is now solved at the infrastructure level; transactional integrity
is not.**

The persistent disk attached by `render.yaml` means `data/db.json` and
`data/uploads/` survive deploys, restarts and crashes, with 24-hour Render
snapshots retained for 7 days. That closes the gap the free tier left open.

What it does **not** change: the repository still uses a JSON/file-backed hot
data store, written as a single debounced atomic `write tmp → rename`. The ledger
is an append-only journal layered onto that store; it is **not yet a PostgreSQL
transaction boundary**. Consequences worth being explicit about:

- There are no database transactions, unique constraints or row locks. Two
  requests landing in the same 250 ms debounce window are serialized by Node's
  single thread, which is safe *today* — but it is an accident of the runtime,
  not a guarantee from the storage layer.
- The service is pinned to one instance, both because the disk cannot be shared
  and because the whole database is held in process memory. Horizontal scaling
  requires the migration below, not a bigger plan.
- Whole-file rewrites mean write cost grows with total database size.

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
Render Postgres from $6/mo (`basic-256mb`) is the natural next step, and adding
it to the blueprint is a `databases:` block plus a `fromDatabase` env var — no
change to how the service itself is defined. Uploaded KYC files would stay on the
disk (or move to object storage) with only their metadata in Postgres.

The current implementation deliberately preserves the existing application architecture while making cash mutations journaled and auditable.

## CRM / HubSpot integration

Bulltrade can optionally synchronize customer-service CRM data with HubSpot without making HubSpot authoritative for financial state.

- New registrations create or update a HubSpot Contact when `HUBSPOT_ACCESS_TOKEN` is configured.
- Signup/KYC status is synchronized to the Contact lifecycle/status fields.
- `POST /api/support/ticket` records the local support request and asynchronously creates a HubSpot Ticket associated with the customer Contact.
- HubSpot failures never block authentication, trading, wallet mutations or ledger operations.
- Wallet balances, orders, positions, executions and the financial ledger remain Bulltrade-owned.

Required environment variable for CRM sync:

- `HUBSPOT_ACCESS_TOKEN`

The token must be stored only in the server deployment environment. Never expose it to browser code or commit it to Git.

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

### Immediately after the first paid deploy

These four confirm the infrastructure half of this phase is actually in effect —
run them before touching any trading configuration:

1. `GET /healthz` → `persistence.dataDir` reads **`/var/data`**. Anything else
   means `DATA_DIR` and the disk's `mountPath` disagree, and data is still
   ephemeral.
2. `GET /healthz` → `rateLimit.enabled` is **`true`** (requires
   `NODE_ENV=production`, or `RATE_LIMIT=on`).
3. Create a test user, note `persistence.dbBytes`, then **Manual Deploy → Clear
   build cache & deploy**. The user and the byte count must both survive. This is
   the exact step that used to wipe everything on the free tier.
4. `curl -sI https://your-app/ | grep -i strict-transport-security` returns
   `max-age=31536000`, and a second `curl -sI -H 'If-None-Match: <etag>'` against
   any page returns **`304`**.

### Before enabling live trading

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
- database persistence survives restart **and** survives a full redeploy
- the throttle rejects abuse: ~10 rapid `POST /api/auth/signup` from one address
  should end in `429` with a `Retry-After` header
- throttling is not rejecting real users: check the logs for unexpected `429`s
  during a normal signup, and confirm `clientIp` is resolving to distinct public
  addresses rather than one shared internal one

## Important

This phase improves application controls, deployment durability and accounting
traceability, but it does not by itself constitute a regulated
brokerage/exchange stack, custody system, blockchain settlement layer, or
production financial-services approval.
