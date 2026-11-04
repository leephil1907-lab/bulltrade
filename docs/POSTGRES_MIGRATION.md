# PostgreSQL migration

**Status: Phase 1 complete. The app still runs entirely on `data/db.json`. Nothing here changes runtime behaviour yet.**

This document records what was built, what was verified, and exactly what has to
happen before the JSON store can be retired. Read the whole of
[Phase 2](#phase-2--not-started-flip-the-write-path) before touching the write path.

---

## Why migrate at all

The paid Render plan plus a persistent disk (see [`render.yaml`](../render.yaml) and
[`DEPLOYMENT.md`](../DEPLOYMENT.md)) already solves the problem that originally
prompted this: data surviving redeploys. Postgres is not needed for that.

What Postgres fixes is a different, structural problem, described honestly in
[`PRODUCTION_READINESS.md`](../PRODUCTION_READINESS.md):

**The JSON store has no transaction boundary.** `lib/db.js` loads the whole of
`db.json` into memory, mutates plain JS objects, and writes the file back on a
250 ms debounce. Two things follow:

1. **A money movement is not atomic.** Opening a position debits a wallet,
   inserts a `positions` row and appends a `ledger` entry as three separate
   mutations of one in-memory object. If the process dies between them, the
   wallet is debited and the position never existed. There is no rollback, and
   no way to detect it after the fact beyond `Ledger.reconcile()`.
2. **One writer, always.** The whole file is rewritten on every save, so the
   service is pinned to `numInstances: 1` and zero-downtime deploys are
   impossible — the persistent disk enforces the same limit from the platform
   side.

Postgres gives both: multi-statement `BEGIN`/`COMMIT`, and concurrent writers.

---

## What Phase 1 delivered

| File | Purpose |
|---|---|
| [`migrations/001_schema.sql`](../migrations/001_schema.sql) | Full schema: 23 collection tables + `schema_migrations`. Idempotent, self-contained transaction. |
| [`lib/pg.js`](../lib/pg.js) | Connection pool, migration runner, collection→table mapping, upsert builder. **Not referenced by `server.js` or any `lib/*` runtime module.** |
| [`lib/pg-parity.js`](../lib/pg-parity.js) | Deep comparison of `doc` jsonb against `db.json`. |
| [`tools/pg-migrate.js`](../tools/pg-migrate.js) | Backfill CLI: orphan pre-flight, single-transaction upsert, optional `--prune`, parity verification. |
| [`tools/pg-parity.js`](../tools/pg-parity.js) | Standalone read-only drift report. |
| [`tests/pg.js`](../tests/pg.js) | 61 integration assertions. Skips cleanly without `DATABASE_URL`. |
| `pg` | Installed as an **optionalDependency**, so `npm ci --omit=dev` on Render still works on machines that cannot build it, and the app boots normally when it is absent. |

### The `doc jsonb` decision

Every table stores a lossless `doc jsonb` column containing the **entire original
document**, alongside typed columns for the fields worth indexing or querying.

This is the single most important design decision in Phase 1, and it is what
makes the migration reversible:

- **Nothing is lost.** The app writes ~90 distinct field shapes across 21
  collections, many of them sparse and some only present on a handful of rows
  (`users.totpEnabled` appeared on 1 of 13 sampled users). Typed columns cover
  the fields that matter; `doc` guarantees the rest survive the trip.
- **Parity is provable, not assumed.** `lib/pg-parity.js` compares `doc` against
  `db.json` field by field. A silently dropped property shows up as drift instead
  of as a production incident three weeks later.
- **Rollback is trivial.** While `doc` is authoritative, `tools/pg-migrate.js`
  can regenerate a byte-equivalent `db.json` from Postgres at any time.

The typed columns are for querying, not (yet) for truth. Phase 2 has to decide
per-collection whether reads come from typed columns or from `doc`, and that
decision is what most of the remaining risk consists of.

### Precision

Money is `numeric`, never `float8`. The scales were chosen by measuring every
numeric field in a real dataset rather than guessed:

| Fields | Type | Why |
|---|---|---|
| `ledger.amount`, `wallets.usd`, `positions.margin/fee/tp/sl`, `trades.notional/margin/pnl`, `transactions.amountUsd/feeUsd` | `numeric(20,2)` | All 2dp-exact in practice; `Ledger.entry()` rounds to 2dp. |
| `trades.qty` | `numeric(38,18)` | Measured at 18 decimal places. |
| `trades.fee` | `numeric(38,18)` | 16 dp. |
| `trades.price`, `trades.entry` | `numeric(38,18)` | 15 dp. |
| `positions.qty/entry`, `transactions.fromQty/toQty` | `numeric(38,18)` | 5–9 dp. |
| all timestamps | `bigint` | Epoch milliseconds. |
| **`trades.at`** | **`numeric(24,4)`** | **Exception:** the seeded demo trade history carries *fractional* milliseconds (e.g. `1790849112913.0408`, 254 of 260 sampled rows non-integer). `bigint` would silently truncate them. |

Verified bit-exactly: `0.022517393297237343` written through the mapper and read
back is `===` the original JS double. 2110 numeric field comparisons across the
sampled dataset produced **zero** mismatches.

Two traps worth recording, because both were hit and both are invisible until
you test for them:

- **The `pg` driver serialises a JS *number* parameter through a float.** NUMERIC
  values must be bound as `String(n)` — `lib/pg.js:numericParam()` does this.
- **`COALESCE($14, 0)` makes Postgres infer `integer` for the parameter**, from
  the literal, not from the column. A `bigint` epoch-millisecond value then fails
  with *"out of range for type integer"*. The mapper pins every parameter type
  explicitly (`$14::bigint`) using `format_type()` from `pg_catalog`.

### Constraints — deliberately conservative

Only **structural** invariants are enforced. The schema does *not* constrain
`type`, `status`, `side`-adjacent enums, or any business vocabulary.

Rationale: a `CHECK (type IN (...))` turns "the app learned a new transaction
type" into a **production write failure**. That is a bad trade. The constraints
that do exist are ones that can never legitimately be violated:

- `ledger.direction IN ('credit','debit')`, `ledger.amount <> 0`
- `wallets.usd >= 0`
- `trades.side IN ('buy','sell')`, `trades.qty > 0`, `trades.leverage >= 1`
- `positions.qty > 0`, `positions.leverage >= 1`
- `mode IN ('demo','live')`
- `settings.id = 1` (singleton — a second row is a bug, not a feature)

**A unique index on `ledger.reference_id` was rejected.** It looks like the
natural idempotency key and it is not. In real data `referenceId` holds at least
six kinds of value — position ids (`p_…`), order ids (`o_…`), user ids (`u_…`),
leader ids (`cl_…`), the literals `pending-position` / `pending-order` /
`migration-v1`, and `''` (the default in `creditWallet`/`debitWallet`). Testing
the candidate key `(userId, mode, type, referenceId)` against a real dataset
found a genuine collision: two `admin_adjustment` entries for the same user
(+3000, then +250), both legitimately referencing that user's own id.

Instead the schema adds a **nullable `idempotency_key text`** with a partial
unique index, left `NULL` for now. Phase 2 must populate it at the write sites
that actually need deduplication (deposit credits above all). Until then
`Ledger.entry()` performs **no** idempotency check at all — a retried request
double-credits today, and migrating to Postgres does not change that.

What *is* enforced against double-processing today:
- `UNIQUE (lower(txid)) WHERE type = 'deposit'` on `transactions`
- `UNIQUE (endpoint)` on `push_subs`
- `UNIQUE (email)` on `users`

### Generated columns

`settings` carries `trading_enabled`, `live_enabled` and `max_leverage` as
`GENERATED ALWAYS AS (doc->'trading'->>...)` columns. They cannot be written to
and cannot drift from `doc`. Their purpose is operational: the trading kill
switch becomes queryable in SQL without parsing jsonb, e.g.

```sql
SELECT trading_enabled, live_enabled, max_leverage FROM settings;
```

---

## Verified

Against a real PostgreSQL 17.11 server (installed in-sandbox), not by inspection:

- `001_schema.sql` applies clean → **24 tables, 70 indexes**. Re-running is a
  no-op.
- Every `CHECK` above rejects a bad row. Every `UNIQUE` rejects a duplicate.
- FK `ON DELETE CASCADE` removes a deleted user's wallets, ledger rows, trades,
  positions, and their chat messages.
- `numeric(38,18)` round-trips a raw JS double bit-identically.
- Generated columns read back correctly.
- Full backfill of a **407-row** dataset (13 users, 264 trades, 32 ledger
  entries) inside one transaction → **PARITY OK**, 0 missing, 0 extra,
  0 mismatched.
- Backfill re-run is idempotent: 407 rows written, counts unchanged.
- Drift detection proven in all three directions — a changed field (reported with
  its exact path and both values), a row missing from Postgres, and a
  Postgres-only ghost row. Exit code 2 on drift.
- `--prune` heals all three at once and returns to `IN SYNC` with no loss of
  legitimate rows (264 trades / 32 ledger / 13 users intact afterwards).
- `tests/pg.js`: **61 passed, 0 failed**.
- Existing suite unaffected: **480 tests still green**.

Reproduce:

```bash
export DATABASE_URL=postgres://user:pw@host:5432/bulltrade_test
npm run test:pg          # 61 assertions; skips cleanly without DATABASE_URL
npm run migrate:pg:dry -- --data-dir=./data   # pre-flight, writes nothing
npm run migrate:pg     -- --data-dir=./data   # one transaction, then verifies
npm run parity:pg      -- --data-dir=./data   # read-only drift report

# Convergence: upserting alone can never REMOVE a row, so a row that exists only
# in Postgres makes parity permanently unreachable. --prune deletes those, in
# FK-safe reverse order, inside the same transaction. It DESTROYS DATA — opt-in.
node tools/pg-migrate.js --data-dir=./data --prune
```

Exit codes for `tools/pg-migrate.js`: `0` success, `1` error, `2` parity drift,
`3` orphaned foreign keys found. `tools/pg-parity.js`: `0` in sync, `1` error,
`2` drift. Both make drift loud enough to gate a deploy on.

> `tests/pg.js` **truncates its target database**. It refuses to run unless the
> database name looks disposable (`test`/`tmp`/`scratch`/`dev`/`ci`). Override
> with `PG_TEST_FORCE=1` only when you are certain.

---

## Bugs found and fixed while building this

The orphan pre-flight exists to catch referential-integrity problems before they
become FK violations. It found three real bugs in the existing admin
"delete user" handler (`server.js`, `case 'delete'`). All three are now fixed
and covered by the e2e suite.

1. **`ledger` was not cleaned up.** Deleting a user left their append-only money
   journal rows behind, pointing at an account that no longer exists. This
   corrupts what `GET /api/admin/ledger` reconciles against, and violates
   `ledger.user_id` under Postgres. *Found as a real orphan:*
   `ledger.userId = u_QQfhEhs4pIHP` (row `led_dzLFMf3I2tRO`) left behind by the
   e2e "superadmin: delete user" test.
2. **`push_subs` was not cleaned up.** A deleted user's web-push subscription
   stayed in the broadcast list.
3. **`messages` cleanup was a silent no-op.** The handler filtered
   `messages` on `x.userId !== uid`, but messages carry `convId`, not `userId`.
   The filter therefore matched nothing and a deleted user's chat messages
   survived, orphaned from their conversation. Now removed by conversation id.

### Known gap, deliberately NOT fixed

**`copy_leaders` is not cleaned up.** If the deleted user was an approved
copy-trading leader:

- their leader record survives, so the public leader list keeps advertising a
  deleted account;
- followers' `copy_allocations` keep their equity locked against a leader who
  can never trade again. `mirrorToCopiers()` (`lib/trading.js:141`) resolves the
  leader via `D.find('copy_leaders', ...)`, so mirroring simply stops; the
  allocated capital is never released.

The correct fix is to call `stopCopy()` for every follower allocation before
removing the leader record — `stopCopy()` (`lib/trading.js:326`) settles mirrored
positions at market and credits `alloc.equity` back to the follower's wallet.
That is **real money movement affecting other users**, triggered from a delete
handler. It needs an explicit product decision, not a drive-by patch:

- Should deleting a leader auto-refund followers, or block the deletion while
  followers exist?
- If it refunds, at what price when the market feed is unavailable? (`stopCopy()`
  `continue`s on a null price, leaving the mirrored position open.)
- Should the action be audit-logged per follower?

`tools/pg-migrate.js` reports these rows as orphans rather than skipping them
silently, so the operator sees the problem at migration time.

---

## Phase 2 — NOT STARTED: flip the write path

**This is the risky part and it is not one commit.** The data layer has
approximately **195 call sites** across 8 files:

| File | |
|---|---|
| `server.js` | ~77 direct `D.db().<collection>` accesses, plus find/filter/insert/remove |
| `lib/auth.js`, `lib/bots.js`, `lib/gamify.js`, `lib/kyc.js`, `lib/mailer.js`, `lib/push.js`, `lib/trading.js` | remainder |

By shape: `D.find` ×90, `D.filter` ×60, `D.insert` ×37, `D.remove` ×8, direct
`D.db().<collection>` ×77 (`settings` 33, `push_subs` 9, `sessions` 6, `users` 4,
`positions` 4, `emails` 4, then 1 each for 11 more collections). `D.update` is
defined but never called.

**Do not rewrite those call sites.** The existing architecture is not being
replaced; it is being given a different backing store. Rewrite the adapter, not
the callers:

1. Implement `find` / `filter` / `insert` / `remove` / `db()` / `save()` in terms
   of Postgres, behind the existing `lib/db.js` exports.
2. `D.db().<collection>` is the hard one — 77 call sites assume a synchronous,
   mutable in-memory array. Either (a) keep a read-through cache that is loaded
   at boot and invalidated on write, or (b) convert those sites to explicit
   queries. Option (a) is far less code and preserves behaviour; option (b) is
   what actually buys you concurrent writers. **This choice is the crux of
   Phase 2 and should be made deliberately, per collection.**
3. `settings` (33 accesses, a singleton object rather than an array) is the
   highest-traffic and easiest to cache. Do it first.

### Shadow-write, then cut over

The safe sequence, each step independently shippable and reversible:

1. **Shadow-write.** Every mutation also goes to Postgres inside a transaction.
   JSON remains authoritative; Postgres errors are logged, never thrown. Run
   `npm run parity:pg` on a schedule (cron, or a `/api/admin/parity` endpoint
   behind the admin session) and watch it stay at zero drift under real traffic.
   **Do not proceed until it has been clean for days, not minutes.**
2. **Read from Postgres, write both.** Flip reads collection by collection,
   starting with the least critical (`leads`, `emails`, `audit`) and leaving
   `wallets`/`ledger`/`positions`/`trades` until last. Keep shadow-writing JSON
   so rollback is a config change.
3. **Make Postgres authoritative.** Stop writing JSON except as a periodic
   export. Wrap each money movement in a real transaction — this is the step
   that finally closes the atomicity gap that motivated the migration.
4. **Remove the disk.** Drop `disk:` from `render.yaml`, raise `numInstances`,
   re-enable zero-downtime deploys. Only after step 3 has been stable.

Between steps 2 and 3 the app must tolerate **both** stores being present. Plan
for a rollback at every step; `doc jsonb` makes "regenerate `db.json` from
Postgres" a supported operation, which is what makes rollback cheap.

### Cutover checklist

Before flipping any read path:

- [ ] `npm run migrate:pg:dry` against a **copy of production data** reports 0 orphans and 0 keyless rows
- [ ] `npm run migrate:pg` against that copy reports **PARITY OK**
- [ ] `npm run parity:pg` re-run immediately after is clean
- [ ] Orphans found in production data are understood and resolved, **not** `--skip-orphans`'d past
- [ ] The `copy_leaders` gap above has an explicit decision recorded
- [ ] `idempotency_key` is populated at the deposit-credit write site
- [ ] Shadow-write has been clean under production traffic for ≥7 days
- [ ] Pool size reviewed for `starter` (512 MB): `PG_POOL_MAX` defaults to **5** (`PG_CONNECT_TIMEOUT` 10 s, idle reaped at 30 s). Fine at `numInstances: 1`; revisit before scaling out, and remember Render's basic Postgres caps total connections
- [ ] Backups: Render Postgres backups enabled **and** the disk/`BACKUP_*` mirror still in place until step 4
- [ ] `npm test` green (480+) **and** `npm run test:pg` green (61)

---

## Render configuration

[`render.yaml`](../render.yaml) contains a `databases:` block and a matching
`DATABASE_URL` env var, **both commented out**.

They are commented out on purpose: Render provisions the database the moment the
blueprint syncs and bills from that instant, but Phase 1 code never opens a
connection. That would be **$6/mo for an unused service**. Uncomment both blocks
together when you are ready to run the backfill against a real Render database.

```yaml
databases:
  - name: bb-db
    databaseName: bulltrade
    user: bulltrade
    plan: basic-256mb          # $6/mo — cheapest PERSISTENT plan
    postgresMajorVersion: "17"
```

- **`plan: free` expires after 30 days and Render deletes the data.** Never use
  it for anything that matters.
- **`postgresMajorVersion` must be ≥ 12** — the schema uses generated columns.
  Tested on 17.
- **The database must be in the same region as the service.** If you set
  `region: frankfurt` on the service, set it here too, or every query pays a
  cross-region round trip.
- `DATABASE_URL` uses `fromDatabase` so Render injects and rotates the
  connection string. **Never paste a literal URL into the blueprint.**

Cost with Postgres enabled: **~$13.25/mo** (starter $7 + 1 GB disk $0.25 +
basic-256mb $6).

### Backfilling an existing deployment

`tools/pg-migrate.js` reads `db.json` **directly from disk** rather than through
`lib/db.js`. That is deliberate: `lib/db.js` runs seeding and migration hooks on
load, and invoking it against a production data directory could write demo data
into production.

On Render the data lives at `/var/data` on the disk, which is **not mounted
during `buildCommand` or `preDeployCommand`** (those run on separate compute).
The backfill therefore has to run either from a one-off shell attached to the
running instance, or from a machine that can reach the database externally.
Render only exposes an external Postgres connection string if you explicitly
enable public access; the internal URL works solely from inside Render's private
network.

---

## Rollback

At any point in Phase 1 or 2:

- **Phase 1:** there is nothing to roll back. No runtime module imports
  `lib/pg.js`. Removing `DATABASE_URL` changes nothing. `pg` is an
  optionalDependency, so its absence is already handled.
- **Phase 2, before step 3:** unset the Postgres feature flag / revert to the
  JSON path. Shadow-writes mean `db.json` was kept current the whole time.
- **Phase 2, after step 3:** regenerate `db.json` from the `doc` jsonb columns.
  This is a supported operation precisely because `doc` is lossless — it is the
  reason that column exists.
