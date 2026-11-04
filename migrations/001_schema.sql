-- ============================================================================
-- Bulltrade — PostgreSQL schema, migration 001
-- ============================================================================
--
-- PHASE 1 OF A MIGRATION. This file creates the schema; it does NOT change how
-- the running app stores data. Nothing here is used at runtime until
-- DATABASE_URL is set, and even then the JSON store remains authoritative until
-- Phase 2 flips the write path (see docs/POSTGRES_MIGRATION.md).
--
-- ---------------------------------------------------------------------------
-- DESIGN DECISION: every table carries BOTH typed columns and `doc jsonb`.
--
-- `doc` holds the original object verbatim and is the lossless record. The
-- typed columns exist for querying, indexing and constraints. This duplication
-- is deliberate and temporary:
--
--   * The JSON store is schemaless. Field discovery across a full e2e run found
--     columns present on 1 row in 13 (users.totpEnabled), and four collections
--     the suite never populated at all (orders, alerts, leads, push_subs) whose
--     shapes had to be read out of the source. Hand-modelling 21 collections
--     from observed samples alone would silently DROP any field a code path
--     writes that the samples did not cover. On an app that holds customer
--     balances and KYC documents, silent field loss is not an acceptable risk.
--   * With `doc` present, the migration is lossless by construction, and the
--     parity tool can prove it by comparing `doc` against db.json directly.
--   * Typed columns can be promoted to authoritative incrementally, and `doc`
--     dropped per-table once a table is fully verified. That is Phase 3.
--
-- ---------------------------------------------------------------------------
-- DESIGN DECISION: timestamps are `bigint` epoch-milliseconds, NOT timestamptz.
--
-- The app stores Date.now() integers. Converting to timestamptz and back is
-- lossless for integers but adds a rounding question for no benefit during a
-- migration whose whole job is fidelity. Analytics-friendly `*_ts` columns are
-- provided as GENERATED timestamptz on the money tables, so you can write
-- `WHERE created_ts > now() - interval '7 days'` without giving up the source
-- value. Exception: trades.at is numeric(24,4) because seeded demo history
-- contains fractional milliseconds (observed: 1790849112913.0408).
--
-- ---------------------------------------------------------------------------
-- DESIGN DECISION: NUMERIC, never float, for money.
--
-- Column scales were chosen from measured data across a full e2e run, not
-- guessed:
--   ledger.amount, wallets.usd, positions.margin/fee/tp/sl,
--   trades.notional/margin/pnl, transactions.amount_usd/fee_usd
--       -> numeric(20,2). lib/utils round() pins these to 2dp, so this is exact
--          and lossless, and the scale acts as an invariant: a future bug that
--          writes unrounded money is rejected by the database rather than
--          silently accumulating float drift.
--   trades.qty (18dp), trades.fee (16dp), trades.price (15dp),
--   trades.entry (14dp), transactions.from_qty (9dp), positions.qty (8dp)
--       -> numeric(38,18). These are raw JS doubles. Inserting them as their
--          shortest-round-trip decimal string and reading them back through
--          Number() returns the bit-identical double, so 38,18 is lossless.
--
-- ---------------------------------------------------------------------------
-- DESIGN DECISION: `idempotency_key`, and why reference_id is NOT constrained.
--
-- PRODUCTION_READINESS asks for "unique/idempotency constraints" so deposits
-- cannot be credited twice. The obvious candidate is ledger.reference_id, and it
-- is a trap. Measured against real data, reference_id holds at least six
-- different kinds of value: a position id (p_...), an order id (o_...), a user
-- id (u_...), a leader id (cl_...), and the literals 'pending-position',
-- 'pending-order' and 'migration-v1' -- plus '' as the default in
-- db.creditWallet/debitWallet.
--
-- A unique index on (user_id, mode, type, reference_id) was tested against a
-- full e2e dataset and produced a real collision: two legitimate, separate
-- admin adjustments (+3000 and +250) both carry reference_id = the user's own
-- id with type 'admin_adjustment'. That constraint would have broken a
-- legitimate admin action while providing no real protection.
--
-- So reference_id stays a plain informational column, and this schema adds a
-- dedicated nullable `idempotency_key` with a partial unique index. Populating
-- it is application work in Phase 2, at the specific call sites where
-- double-execution is the actual hazard (deposit credit, withdrawal refund,
-- limit-order reserve/release). Until then it is NULL everywhere and the index
-- costs nothing.
--
-- ---------------------------------------------------------------------------
-- DESIGN DECISION: few CHECK constraints, no enums for `type`/`status`.
--
-- Only invariants that are structural and cannot legitimately grow are
-- enforced: ledger.direction is binary and is used as the sign in balance
-- arithmetic; wallet balance cannot go negative; a position side is buy or
-- sell. Type/status vocabularies are left as indexed text. Observed values are
-- documented in comments, but a CHECK on them would turn "the app learned a new
-- transaction type" into a production write failure -- a bad trade for a
-- constraint that catches nothing real.
--
-- Requires PostgreSQL 12+ (generated columns). Tested on PostgreSQL 17.
-- Idempotent: safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              text PRIMARY KEY,
  doc             jsonb NOT NULL,
  email           text NOT NULL,
  password_hash   text NOT NULL,
  name            text,
  role            text NOT NULL DEFAULT 'user',
  banned          boolean NOT NULL DEFAULT false,
  suspended       boolean NOT NULL DEFAULT false,
  referral_code   text,
  referred_by     text,
  country         text,
  joined_at       bigint NOT NULL DEFAULT 0,
  last_login      bigint,
  totp_enabled    boolean NOT NULL DEFAULT false,
  xp              bigint NOT NULL DEFAULT 0,
  manual_pnl      numeric(20,2) NOT NULL DEFAULT 0,
  created_ts      timestamptz GENERATED ALWAYS AS (to_timestamp(joined_at / 1000.0)) STORED
);
-- Email is the login key. Lowercase-normalised by the app; the unique index is
-- on the raw column because the app already normalises before insert.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_key ON users (referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);
CREATE INDEX IF NOT EXISTS users_doc_gin ON users USING gin (doc jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- sessions  (revocable DB-backed session ids wrapped in a signed JWT)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,          -- the inner sid, NOT the JWT
  doc         jsonb NOT NULL,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  bigint NOT NULL DEFAULT 0,
  expires_at  bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
-- Lets a cron/vacuum find dead sessions without a seq scan.
CREATE INDEX IF NOT EXISTS sessions_expired_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- wallets  (hot balance read model; the ledger is the journal of record)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallets (
  user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode     text NOT NULL,                -- 'demo' | 'live'
  doc      jsonb NOT NULL,
  usd      numeric(20,2) NOT NULL DEFAULT 0 CHECK (usd >= 0),
  coins    jsonb,                        -- { "<assetId>": qty } — dynamic keys
  PRIMARY KEY (user_id, mode),
  CHECK (mode IN ('demo', 'live'))
);

-- ---------------------------------------------------------------------------
-- ledger  (append-only money journal)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger (
  id              text PRIMARY KEY,
  doc             jsonb NOT NULL,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode            text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount          numeric(20,2) NOT NULL CHECK (amount <> 0),
  currency        text NOT NULL DEFAULT 'USD',
  status          text NOT NULL DEFAULT 'posted',   -- balance() sums 'posted' only
  -- Observed vocabulary (NOT constrained, see header):
  --   opening_balance, signup_bonus, credit, debit, trade_open, trade_close,
  --   order_reserve, order_release, admin_adjustment, pnl_adjust,
  --   copy_allocation, demo_topup, demo_reset, adjust, deposit, withdraw,
  --   product, swap
  type            text NOT NULL,
  -- Informational cross-reference only. Holds position/order/user/leader ids
  -- and the literals 'pending-position', 'pending-order', 'migration-v1', ''.
  -- Deliberately unconstrained — see the idempotency note in the header.
  reference_id    text NOT NULL DEFAULT '',
  note            text NOT NULL DEFAULT '',
  -- Phase 2 populates this at the call sites where double-execution is a real
  -- hazard. NULL until then; the partial index ignores NULLs.
  idempotency_key text,
  created_at      bigint NOT NULL DEFAULT 0,
  created_ts      timestamptz GENERATED ALWAYS AS (to_timestamp(created_at / 1000.0)) STORED
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_idempotency_key ON ledger (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ledger_user_mode_idx ON ledger (user_id, mode, status);
CREATE INDEX IF NOT EXISTS ledger_created_idx ON ledger (created_at DESC);
CREATE INDEX IF NOT EXISTS ledger_type_idx ON ledger (type);

-- ---------------------------------------------------------------------------
-- kyc
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kyc (
  id           text PRIMARY KEY,
  doc          jsonb NOT NULL,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  id_type      text,
  details      jsonb,                            -- fullName, idNumber, address, ...
  docs         jsonb,                            -- [{id,kind,file,origName,mime,size}]
  submitted_at bigint NOT NULL DEFAULT 0,
  reviewed_at  bigint,
  reviewer_id  text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS kyc_user_idx ON kyc (user_id);
CREATE INDEX IF NOT EXISTS kyc_status_idx ON kyc (status);

-- ---------------------------------------------------------------------------
-- positions  (open trades)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS positions (
  id               text PRIMARY KEY,
  doc              jsonb NOT NULL,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode             text NOT NULL,
  asset_id         text NOT NULL,
  symbol           text NOT NULL,
  name             text,
  side             text NOT NULL CHECK (side IN ('buy', 'sell')),
  qty              numeric(38,18) NOT NULL CHECK (qty > 0),
  entry            numeric(38,18) NOT NULL,
  leverage         integer NOT NULL DEFAULT 1 CHECK (leverage >= 1),
  margin           numeric(20,2) NOT NULL DEFAULT 0,
  fee              numeric(20,2) NOT NULL DEFAULT 0,
  tp               numeric(38,18),
  sl               numeric(38,18),
  opened_at        bigint NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'open',   -- open|closed|liquidated
  order_type       text,                           -- market|limit
  ledger_debit_id  text,                           -- ties the open to its ledger row
  -- mirrored copy-trading positions only:
  copy_of          text,
  alloc_id         text,
  opened_ts        timestamptz GENERATED ALWAYS AS (to_timestamp(opened_at / 1000.0)) STORED
);
CREATE INDEX IF NOT EXISTS positions_user_mode_idx ON positions (user_id, mode, status);
CREATE INDEX IF NOT EXISTS positions_open_idx ON positions (status) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- orders  (resting limit orders; margin+fee reserved at placement)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id           text PRIMARY KEY,
  doc          jsonb NOT NULL,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode         text NOT NULL,
  asset_id     text NOT NULL,
  symbol       text NOT NULL,
  name         text,
  side         text NOT NULL CHECK (side IN ('buy', 'sell')),
  type         text NOT NULL DEFAULT 'limit',
  limit_price  numeric(38,18) NOT NULL CHECK (limit_price > 0),
  notional     numeric(20,2) NOT NULL CHECK (notional > 0),
  qty          numeric(38,18) NOT NULL,
  leverage     integer NOT NULL DEFAULT 1,
  tp           numeric(38,18),
  sl           numeric(38,18),
  fee          numeric(20,2) NOT NULL DEFAULT 0,
  -- margin + fee held while the order rests; released on cancel, consumed on fill
  reserved     numeric(20,2) NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'open',
  created_at   bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS orders_user_mode_idx ON orders (user_id, mode, status);
CREATE INDEX IF NOT EXISTS orders_open_idx ON orders (status) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- trades  (executed/closed trade log — the highest-volume table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trades (
  id           text PRIMARY KEY,
  doc          jsonb NOT NULL,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode         text NOT NULL,
  asset_id     text NOT NULL,
  symbol       text NOT NULL,
  name         text,
  side         text NOT NULL CHECK (side IN ('buy', 'sell')),
  type         text NOT NULL,                 -- market|limit
  action       text NOT NULL,                 -- open|close|...
  qty          numeric(38,18) NOT NULL,
  price        numeric(38,18) NOT NULL,
  entry        numeric(38,18),
  notional     numeric(20,2) NOT NULL DEFAULT 0,
  fee          numeric(38,18) NOT NULL DEFAULT 0,
  margin       numeric(20,2),
  pnl          numeric(20,2) NOT NULL DEFAULT 0,
  leverage     integer NOT NULL DEFAULT 1,
  liquidated   boolean NOT NULL DEFAULT false,
  reason       text,                          -- take-profit|stop-loss|liquidation|manual
  position_id  text,
  copy_of      text,
  seeded       boolean NOT NULL DEFAULT false,
  -- numeric, not bigint: seeded demo history carries fractional milliseconds
  at           numeric(24,4) NOT NULL DEFAULT 0,
  at_ts        timestamptz GENERATED ALWAYS AS (to_timestamp(at / 1000.0)) STORED
);
CREATE INDEX IF NOT EXISTS trades_user_mode_idx ON trades (user_id, mode, at DESC);
CREATE INDEX IF NOT EXISTS trades_at_idx ON trades (at DESC);
CREATE INDEX IF NOT EXISTS trades_symbol_idx ON trades (symbol);

-- ---------------------------------------------------------------------------
-- transactions  (deposits / withdrawals / swaps / product purchases / admin)
--
-- One collection, several shapes. Columns are nullable and only populated by
-- the relevant type — that is how the JSON store already behaves.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id            text PRIMARY KEY,
  doc           jsonb NOT NULL,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          text NOT NULL,   -- deposit|withdraw|swap|product|adjust|demo_topup|...
  mode          text,
  asset         text,
  status        text NOT NULL DEFAULT 'pending',  -- pending|completed|rejected
  amount_usd    numeric(20,2) NOT NULL DEFAULT 0,
  fee_usd       numeric(20,2),
  -- swap only
  from_asset    text,
  to_asset      text,
  from_qty      numeric(38,18),
  to_qty        numeric(38,18),
  -- crypto deposit / withdrawal only
  txid          text,
  address       text,
  proof         jsonb,                            -- {file,mime,name,size}
  -- product purchase only
  product_id    text,
  product_name  text,
  note          text,
  admin_note    text,
  admin_id      text REFERENCES users(id) ON DELETE SET NULL,
  created_at    bigint NOT NULL DEFAULT 0,
  updated_at    bigint,
  created_ts    timestamptz GENERATED ALWAYS AS (to_timestamp(created_at / 1000.0)) STORED
);
CREATE INDEX IF NOT EXISTS transactions_user_idx ON transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions (status);
CREATE INDEX IF NOT EXISTS transactions_type_idx ON transactions (type);
-- A deposit TXID should never be credited twice. Partial because only deposits
-- carry one, and the app does not currently enforce this at all.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_deposit_txid_key
  ON transactions (lower(txid)) WHERE txid IS NOT NULL AND txid <> '' AND type = 'deposit';

-- ---------------------------------------------------------------------------
-- chats + messages  (support conversations)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chats (
  id            text PRIMARY KEY,
  doc           jsonb NOT NULL,
  user_id       text REFERENCES users(id) ON DELETE CASCADE,  -- nullable: guest chats
  guest_key     text,
  name          text,
  email         text,
  status        text NOT NULL DEFAULT 'open',
  subject       text,
  message       text,
  unread_admin  integer NOT NULL DEFAULT 0,
  last_msg_at   bigint NOT NULL DEFAULT 0,
  created_at    bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chats_user_idx ON chats (user_id);
CREATE INDEX IF NOT EXISTS chats_last_msg_idx ON chats (last_msg_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         text PRIMARY KEY,
  doc        jsonb NOT NULL,
  conv_id    text NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender     text NOT NULL,               -- 'user' | 'admin'   (json key: "from")
  text       text NOT NULL DEFAULT '',
  admin_name text,
  seen       boolean NOT NULL DEFAULT false,
  at         bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages (conv_id, at);

-- ---------------------------------------------------------------------------
-- resets  (password-reset tokens)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resets (
  token      text PRIMARY KEY,
  doc        jsonb NOT NULL,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL DEFAULT 0,
  used       boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS resets_user_idx ON resets (user_id);

-- ---------------------------------------------------------------------------
-- community_apps
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS community_apps (
  id             text PRIMARY KEY,
  doc            jsonb NOT NULL,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending',
  experience     text,
  goals          text,
  quiz_score     integer,
  rules_accepted boolean NOT NULL DEFAULT false,
  applied_at     bigint NOT NULL DEFAULT 0,
  reviewed_at    bigint,
  reason         text
);
CREATE INDEX IF NOT EXISTS community_apps_user_idx ON community_apps (user_id);
CREATE INDEX IF NOT EXISTS community_apps_status_idx ON community_apps (status);

-- ---------------------------------------------------------------------------
-- alerts  (price alerts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id              text PRIMARY KEY,
  doc             jsonb NOT NULL,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_id        text NOT NULL,
  symbol          text NOT NULL,
  name            text,
  dir             text NOT NULL CHECK (dir IN ('above', 'below')),
  target          numeric(38,18) NOT NULL,
  status          text NOT NULL DEFAULT 'active',   -- active|triggered
  created_at      bigint NOT NULL DEFAULT 0,
  triggered_at    bigint NOT NULL DEFAULT 0,
  triggered_price numeric(38,18) NOT NULL DEFAULT 0,
  seen            boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS alerts_active_idx ON alerts (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS alerts_user_idx ON alerts (user_id);

-- ---------------------------------------------------------------------------
-- logins  (login history / new-device detection)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS logins (
  id         text PRIMARY KEY,
  doc        jsonb NOT NULL,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at         bigint NOT NULL DEFAULT 0,
  ip         text,
  ua         text,
  device_key text,
  new_device boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS logins_user_device_idx ON logins (user_id, device_key);
CREATE INDEX IF NOT EXISTS logins_at_idx ON logins (at DESC);

-- ---------------------------------------------------------------------------
-- emails  (outbox journal)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emails (
  id      text PRIMARY KEY,
  doc     jsonb NOT NULL,
  to_addr text NOT NULL,                 -- "to" is reserved-ish; json key stays "to"
  subject text NOT NULL DEFAULT '',
  status  text NOT NULL,                 -- sent|failed|skipped
  error   text NOT NULL DEFAULT '',
  at      bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS emails_at_idx ON emails (at DESC);
CREATE INDEX IF NOT EXISTS emails_status_idx ON emails (status);

-- ---------------------------------------------------------------------------
-- copy_leaders  (copy-trading leaders and trading bots — same collection)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS copy_leaders (
  id             text PRIMARY KEY,
  doc            jsonb NOT NULL,
  user_id        text REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending',  -- pending|active|suspended
  title          text,
  style          text,
  description    text,
  bot            boolean NOT NULL DEFAULT false,
  emoji          text,
  avatar         text,
  risk           text,
  min_balance    numeric(20,2) NOT NULL DEFAULT 0,
  universe       text[],                           -- asset ids traded
  params         jsonb,                            -- {lev,sizePct,maxPos,momo,tpPct,slPct,cdMin,cdMax}
  seed_followers integer NOT NULL DEFAULT 0,
  seeded         boolean NOT NULL DEFAULT false,
  approved_at    bigint
);
CREATE INDEX IF NOT EXISTS copy_leaders_status_idx ON copy_leaders (status);

-- ---------------------------------------------------------------------------
-- bot_requests  (trading-bot connection keys)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_requests (
  id           text PRIMARY KEY,
  doc          jsonb NOT NULL,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leader_id    text REFERENCES copy_leaders(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending',
  key          text,
  requested_at bigint NOT NULL DEFAULT 0,
  reviewed_at  bigint
);
CREATE INDEX IF NOT EXISTS bot_requests_user_idx ON bot_requests (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS bot_requests_key ON bot_requests (key) WHERE key IS NOT NULL AND key <> '';

-- ---------------------------------------------------------------------------
-- copy_allocations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS copy_allocations (
  id         text PRIMARY KEY,
  doc        jsonb NOT NULL,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leader_id  text REFERENCES copy_leaders(id) ON DELETE SET NULL,
  mode       text NOT NULL,
  allocated  numeric(20,2) NOT NULL DEFAULT 0,
  equity     numeric(20,2) NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT false,
  started_at bigint NOT NULL DEFAULT 0,
  stopped_at bigint
);
CREATE INDEX IF NOT EXISTS copy_allocations_active_idx ON copy_allocations (active) WHERE active;
CREATE INDEX IF NOT EXISTS copy_allocations_leader_idx ON copy_allocations (leader_id);

-- ---------------------------------------------------------------------------
-- push_subs  (VAPID web-push subscriptions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS push_subs (
  id         text PRIMARY KEY,
  doc        jsonb NOT NULL,
  user_id    text REFERENCES users(id) ON DELETE CASCADE,   -- nullable: anonymous
  endpoint   text NOT NULL,
  keys       jsonb NOT NULL,                                -- {p256dh, auth}
  created_at bigint NOT NULL DEFAULT 0
);
-- The app de-dupes by endpoint; make that structural.
CREATE UNIQUE INDEX IF NOT EXISTS push_subs_endpoint_key ON push_subs (endpoint);

-- ---------------------------------------------------------------------------
-- leads  (newsletter / lead-magnet signups)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id         text PRIMARY KEY,
  doc        jsonb NOT NULL,
  email      text NOT NULL,
  magnet     text,
  source     text,
  ip         text,
  ua         text,
  created_at bigint NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS leads_email_idx ON leads (email);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads (created_at DESC);

-- ---------------------------------------------------------------------------
-- audit  (admin action trail — append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit (
  id       text PRIMARY KEY,
  doc      jsonb NOT NULL,
  admin_id text REFERENCES users(id) ON DELETE SET NULL,
  action   text NOT NULL,
  target   text NOT NULL DEFAULT '',
  detail   text NOT NULL DEFAULT '',
  at       bigint NOT NULL DEFAULT 0,
  at_ts    timestamptz GENERATED ALWAYS AS (to_timestamp(at / 1000.0)) STORED
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit (at DESC);
CREATE INDEX IF NOT EXISTS audit_admin_idx ON audit (admin_id);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit (action);

-- ---------------------------------------------------------------------------
-- settings  (singleton configuration document)
--
-- Stored as one jsonb row because it is a nested config blob, not a relation:
-- smtp, email, trading, contest, fx, pushKeys, depositAddresses and
-- announcements are all objects/arrays with shapes that change together.
-- Typing these out would create 20 nullable columns that only ever hold one
-- value each. The two operationally critical trading flags are promoted to
-- GENERATED columns so the kill switch is queryable in SQL and auditable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  doc              jsonb NOT NULL,
  updated_at       bigint NOT NULL DEFAULT 0,
  trading_enabled  boolean GENERATED ALWAYS AS (COALESCE((doc -> 'trading' ->> 'enabled')::boolean, true)) STORED,
  live_enabled     boolean GENERATED ALWAYS AS (COALESCE((doc -> 'trading' ->> 'liveEnabled')::boolean, true)) STORED,
  max_leverage     integer GENERATED ALWAYS AS (COALESCE((doc -> 'trading' ->> 'maxLeverage')::integer, 10)) STORED
);

-- ---------------------------------------------------------------------------
-- Migration bookkeeping. lib/pg.js records each applied migration here so
-- re-running is a no-op and a partially-applied file is never repeated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  checksum    text NOT NULL,
  applied_by  text
);

COMMIT;
