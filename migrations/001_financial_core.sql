-- Bulltrade financial core, PostgreSQL 15+. Money uses integer USD cents.
BEGIN;
CREATE TABLE IF NOT EXISTS financial_wallets (
 user_id TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('demo','live')),
 currency CHAR(3) NOT NULL DEFAULT 'USD', balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(user_id,mode,currency)
);
CREATE TABLE IF NOT EXISTS financial_idempotency (
 user_id TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 request_hash TEXT NOT NULL, response JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,operation,idempotency_key), CHECK(length(idempotency_key) BETWEEN 8 AND 200)
);
CREATE TABLE IF NOT EXISTS financial_ledger (
 id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('demo','live')), currency CHAR(3) NOT NULL DEFAULT 'USD',
 direction TEXT NOT NULL CHECK(direction IN ('credit','debit')),
 amount_minor BIGINT NOT NULL CHECK(amount_minor > 0),
 balance_after_minor BIGINT NOT NULL CHECK(balance_after_minor >= 0),
 movement_type TEXT NOT NULL, reference_id TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,mode,currency,idempotency_key)
);
CREATE INDEX IF NOT EXISTS financial_ledger_user_time_idx ON financial_ledger(user_id,mode,currency,created_at DESC);
CREATE INDEX IF NOT EXISTS financial_ledger_reference_idx ON financial_ledger(reference_id) WHERE reference_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS financial_transactions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, operation TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','posted','completed','rejected','cancelled','failed')),
 amount_minor BIGINT NOT NULL CHECK(amount_minor >= 0), currency CHAR(3) NOT NULL DEFAULT 'USD',
 idempotency_key TEXT, metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_transactions_idempotency_idx
 ON financial_transactions(user_id,operation,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS financial_orders (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
 status TEXT NOT NULL CHECK(status IN ('open','filled','cancelled','rejected')),
 reserved_minor BIGINT NOT NULL DEFAULT 0 CHECK(reserved_minor >= 0), idempotency_key TEXT,
 metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS financial_orders_idempotency_idx
 ON financial_orders(user_id,mode,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS financial_positions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('demo','live')),
 status TEXT NOT NULL CHECK(status IN ('open','closed','liquidated')),
 reserved_margin_minor BIGINT NOT NULL DEFAULT 0 CHECK(reserved_margin_minor >= 0),
 metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION prevent_financial_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'financial_ledger is append-only; post a compensating entry'; END; $$;
DROP TRIGGER IF EXISTS financial_ledger_no_update ON financial_ledger;
CREATE TRIGGER financial_ledger_no_update BEFORE UPDATE OR DELETE ON financial_ledger
 FOR EACH ROW EXECUTE FUNCTION prevent_financial_ledger_mutation();
COMMIT;
