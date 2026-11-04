'use strict';
/**
 * PostgreSQL adapter — PHASE 1: schema management and bulk migration only.
 *
 * NOTHING HERE IS ON THE RUNTIME WRITE PATH YET. The JSON store in lib/db.js
 * remains authoritative. This module exists so that:
 *
 *   1. `migrate()` creates/upgrades the schema idempotently,
 *   2. tools/pg-migrate.js backfills db.json into Postgres,
 *   3. tools/pg-parity.js proves the backfill was lossless,
 *   4. tests/pg.js verifies all of the above against a real server.
 *
 * Phase 2 (docs/POSTGRES_MIGRATION.md) adds dual-write and flips authority.
 * Doing that before parity is demonstrated on real data is how you lose
 * customer balances.
 *
 * `pg` is an OPTIONAL dependency. As with web-push in lib/push.js, the require
 * is lazy and guarded: a checkout without it boots normally, and every entry
 * point reports enabled() === false when DATABASE_URL is unset. The app must
 * never fail to start because Postgres is absent.
 *
 * ---------------------------------------------------------------------------
 * NUMERIC BINDING — read before touching the column maps.
 *
 * Money and price columns are NUMERIC. The pg driver serialises a JS *number*
 * parameter through a float, which can lose trailing digits of a double. So
 * every field in a table's `numeric` list is bound as its shortest round-trip
 * decimal STRING: String(0.022517393297237343) is exactly that double's digits,
 * NUMERIC(38,18) stores them exactly, and Number() on the way back returns the
 * bit-identical double. Verified against PostgreSQL 17 in tests/pg.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const URL_ = (process.env.DATABASE_URL || '').trim();

let _pg = null;    // the pg module once required (false = unavailable)
let _pool = null;  // the pool once created

/** True when a Postgres connection string is configured. */
function enabled() { return !!URL_; }

/** Lazy, guarded require of `pg`; null when the package is absent. */
function driver() {
  if (_pg !== null) return _pg || null;
  try { _pg = require('pg'); }
  catch (e) {
    _pg = false;
    console.error('[pg] the "pg" package is not installed; Postgres features disabled.');
  }
  return _pg || null;
}

/**
 * Build the pool. Render hands out a plain DATABASE_URL; external connections
 * need TLS, internal ones do not. Honour sslmode from the URL or PGSSLMODE.
 */
function pool() {
  if (!enabled()) throw new Error('DATABASE_URL is not set');
  const pg = driver();
  if (!pg) throw new Error('the "pg" package is not installed');
  if (_pool) return _pool;

  const sslmode = (process.env.PGSSLMODE || (/sslmode=(\w+)/.exec(URL_) || [])[1] || '').toLowerCase();
  const ssl = sslmode === 'disable' ? false
    : (sslmode === 'verify-full' || sslmode === 'verify-ca') ? { rejectUnauthorized: true }
    : (sslmode === 'require') ? { rejectUnauthorized: false }
    : undefined; // let pg decide from the URL

  _pool = new pg.Pool({
    connectionString: URL_,
    ssl,
    // Small on purpose: the service is pinned to ONE instance (a Render
    // persistent disk cannot be shared) and Render's basic Postgres caps
    // connections low.
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT) || 10000,
    application_name: 'bulltrade'
  });
  _pool.on('error', err => console.error('[pg] idle client error:', err.message));
  return _pool;
}

async function query(text, params) { return pool().query(text, params); }

/** Run fn inside a transaction; rolls back on any throw. */
async function tx(fn) {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function close() {
  if (_pool) { const p = _pool; _pool = null; await p.end().catch(() => {}); }
}

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------
const snakeCache = new Map();
function snake(s) {
  let v = snakeCache.get(s);
  if (v === undefined) {
    v = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
         .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
         .toLowerCase();
    snakeCache.set(s, v);
  }
  return v;
}

/**
 * Table specs, per JSON collection:
 *   table    SQL table name
 *   key      doc field(s) forming the primary key / conflict target
 *   cols     doc field -> SQL column, for typed columns. Fields not listed here
 *            still survive inside `doc`; they are simply not queryable yet.
 *   numeric  fields bound as exact decimal strings (see header)
 *   jsonb    fields bound as JSON
 *   arrays   fields bound as Postgres text[]
 *
 * wallets/sessions/resets have no single `id` — composite or token keys — so the
 * key list is explicit per table.
 */
const TABLES = {
  users: { table: 'users', key: ['id'], numeric: ['manualPnl'], cols: {
    email: 'email', passwordHash: 'password_hash', name: 'name', role: 'role', banned: 'banned',
    suspended: 'suspended', referralCode: 'referral_code', referredBy: 'referred_by', country: 'country',
    joinedAt: 'joined_at', lastLogin: 'last_login', totpEnabled: 'totp_enabled', xp: 'xp',
    manualPnl: 'manual_pnl' } },

  sessions: { table: 'sessions', key: ['token'], cols: {
    userId: 'user_id', createdAt: 'created_at', expiresAt: 'expires_at' } },

  wallets: { table: 'wallets', key: ['userId', 'mode'], numeric: ['usd'], jsonb: ['coins'], cols: {
    userId: 'user_id', mode: 'mode', usd: 'usd', coins: 'coins' } },

  ledger: { table: 'ledger', key: ['id'], numeric: ['amount'], cols: {
    userId: 'user_id', mode: 'mode', direction: 'direction', amount: 'amount', currency: 'currency',
    status: 'status', type: 'type', referenceId: 'reference_id', note: 'note',
    idempotencyKey: 'idempotency_key', createdAt: 'created_at' } },

  kyc: { table: 'kyc', key: ['id'], jsonb: ['details', 'docs'], cols: {
    userId: 'user_id', status: 'status', idType: 'id_type', details: 'details', docs: 'docs',
    submittedAt: 'submitted_at', reviewedAt: 'reviewed_at', reviewerId: 'reviewer_id' } },

  positions: { table: 'positions', key: ['id'], numeric: ['qty', 'entry', 'tp', 'sl', 'margin', 'fee'], cols: {
    userId: 'user_id', mode: 'mode', assetId: 'asset_id', symbol: 'symbol', name: 'name', side: 'side',
    qty: 'qty', entry: 'entry', leverage: 'leverage', margin: 'margin', fee: 'fee', tp: 'tp', sl: 'sl',
    openedAt: 'opened_at', status: 'status', orderType: 'order_type', ledgerDebitId: 'ledger_debit_id',
    copyOf: 'copy_of', allocId: 'alloc_id' } },

  orders: { table: 'orders', key: ['id'],
    numeric: ['limitPrice', 'notional', 'qty', 'tp', 'sl', 'fee', 'reserved'], cols: {
    userId: 'user_id', mode: 'mode', assetId: 'asset_id', symbol: 'symbol', name: 'name', side: 'side',
    type: 'type', limitPrice: 'limit_price', notional: 'notional', qty: 'qty', leverage: 'leverage',
    tp: 'tp', sl: 'sl', fee: 'fee', reserved: 'reserved', status: 'status', createdAt: 'created_at' } },

  trades: { table: 'trades', key: ['id'], numeric: ['qty', 'price', 'entry', 'fee', 'margin', 'pnl', 'at'], cols: {
    userId: 'user_id', mode: 'mode', assetId: 'asset_id', symbol: 'symbol', name: 'name', side: 'side',
    type: 'type', action: 'action', qty: 'qty', price: 'price', entry: 'entry', notional: 'notional',
    fee: 'fee', margin: 'margin', pnl: 'pnl', leverage: 'leverage', liquidated: 'liquidated',
    reason: 'reason', positionId: 'position_id', copyOf: 'copy_of', seeded: 'seeded', at: 'at' } },

  transactions: { table: 'transactions', key: ['id'],
    numeric: ['amountUsd', 'feeUsd', 'fromQty', 'toQty'], jsonb: ['proof'], cols: {
    userId: 'user_id', type: 'type', mode: 'mode', asset: 'asset', status: 'status',
    amountUsd: 'amount_usd', feeUsd: 'fee_usd', fromAsset: 'from_asset', toAsset: 'to_asset',
    fromQty: 'from_qty', toQty: 'to_qty', txid: 'txid', address: 'address', proof: 'proof',
    productId: 'product_id', productName: 'product_name', note: 'note', adminNote: 'admin_note',
    adminId: 'admin_id', createdAt: 'created_at', updatedAt: 'updated_at' } },

  chats: { table: 'chats', key: ['id'], cols: {
    userId: 'user_id', guestKey: 'guest_key', name: 'name', email: 'email', status: 'status',
    subject: 'subject', message: 'message', unreadAdmin: 'unread_admin', lastMsgAt: 'last_msg_at',
    createdAt: 'created_at' } },

  // `from` is a SQL keyword and reads badly as a column name; stored as sender.
  messages: { table: 'messages', key: ['id'], cols: {
    convId: 'conv_id', from: 'sender', text: 'text', adminName: 'admin_name', seen: 'seen', at: 'at' } },

  resets: { table: 'resets', key: ['token'], cols: {
    userId: 'user_id', expiresAt: 'expires_at', used: 'used' } },

  community_apps: { table: 'community_apps', key: ['id'], cols: {
    userId: 'user_id', status: 'status', experience: 'experience', goals: 'goals', quizScore: 'quiz_score',
    rulesAccepted: 'rules_accepted', appliedAt: 'applied_at', reviewedAt: 'reviewed_at', reason: 'reason' } },

  alerts: { table: 'alerts', key: ['id'], numeric: ['target', 'triggeredPrice'], cols: {
    userId: 'user_id', assetId: 'asset_id', symbol: 'symbol', name: 'name', dir: 'dir', target: 'target',
    status: 'status', createdAt: 'created_at', triggeredAt: 'triggered_at',
    triggeredPrice: 'triggered_price', seen: 'seen' } },

  logins: { table: 'logins', key: ['id'], cols: {
    userId: 'user_id', at: 'at', ip: 'ip', ua: 'ua', deviceKey: 'device_key', newDevice: 'new_device' } },

  emails: { table: 'emails', key: ['id'], cols: {
    to: 'to_addr', subject: 'subject', status: 'status', error: 'error', at: 'at' } },

  copy_leaders: { table: 'copy_leaders', key: ['id'], numeric: ['minBalance'], jsonb: ['params'],
    arrays: ['universe'], cols: {
    userId: 'user_id', status: 'status', title: 'title', style: 'style', description: 'description',
    bot: 'bot', emoji: 'emoji', avatar: 'avatar', risk: 'risk', minBalance: 'min_balance',
    universe: 'universe', params: 'params', seedFollowers: 'seed_followers', seeded: 'seeded',
    approvedAt: 'approved_at' } },

  bot_requests: { table: 'bot_requests', key: ['id'], cols: {
    userId: 'user_id', leaderId: 'leader_id', status: 'status', key: 'key',
    requestedAt: 'requested_at', reviewedAt: 'reviewed_at' } },

  copy_allocations: { table: 'copy_allocations', key: ['id'], numeric: ['allocated', 'equity'], cols: {
    userId: 'user_id', leaderId: 'leader_id', mode: 'mode', allocated: 'allocated', equity: 'equity',
    active: 'active', startedAt: 'started_at', stoppedAt: 'stopped_at' } },

  push_subs: { table: 'push_subs', key: ['id'], jsonb: ['keys'], cols: {
    userId: 'user_id', endpoint: 'endpoint', keys: 'keys', createdAt: 'created_at' } },

  leads: { table: 'leads', key: ['id'], cols: {
    email: 'email', magnet: 'magnet', source: 'source', ip: 'ip', ua: 'ua', createdAt: 'created_at' } },

  audit: { table: 'audit', key: ['id'], cols: {
    adminId: 'admin_id', action: 'action', target: 'target', detail: 'detail', at: 'at' } },

  // Singleton: exactly one row, id pinned to 1 by a CHECK in the schema.
  settings: { table: 'settings', key: [], singleton: true }
};

/**
 * Insert order matters — foreign keys. A row referencing users(id) cannot be
 * written before that user exists, and copy_allocations references copy_leaders.
 * This ordering satisfies every FK in 001_schema.sql.
 */
const INSERT_ORDER = [
  'users', 'settings',
  'sessions', 'wallets', 'ledger', 'kyc', 'logins', 'resets', 'emails',
  'chats', 'messages', 'community_apps', 'alerts', 'leads', 'push_subs',
  'copy_leaders', 'bot_requests', 'copy_allocations',
  'transactions', 'audit',
  'orders', 'positions', 'trades'
];

/** Bind a JS value for a NUMERIC column as its exact decimal string. */
function numericParam(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return String(n); // shortest representation that round-trips to the same double
}

/**
 * Per-table column metadata, read from the database itself.
 *
 * Why introspect instead of listing defaults in JS: the app writes sparse
 * documents. A user with no `suspended` field yields undefined, which binds as
 * NULL — and an explicit NULL *defeats* a column DEFAULT, violating NOT NULL.
 * The fix is to wrap such parameters in COALESCE($n, <the column's own default>).
 * Duplicating those defaults in JavaScript would create a second source of truth
 * that silently drifts from the schema the next time a migration adds a column,
 * so the defaults are read from information_schema instead.
 */
let _metaCache = null;
async function columnMeta(table, client) {
  const q = client ? (sql, p) => client.query(sql, p) : (sql, p) => query(sql, p);
  _metaCache = _metaCache || new Map();
  if (_metaCache.has(table)) return _metaCache.get(table);

  // pg_catalog rather than information_schema: format_type() returns the exact
  // SQL type name (bigint, numeric(20,2), text[], jsonb) instead of a generic
  // family, and pg_get_expr() returns the default as a usable expression.
  const r = await q(`
    SELECT a.attname                                   AS column_name,
           format_type(a.atttypid, a.atttypmod)         AS sql_type,
           NOT a.attnotnull                             AS nullable,
           a.attgenerated                               AS generated,
           pg_get_expr(d.adbin, d.adrelid)              AS column_default
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ('public.' || $1)::regclass
       AND a.attnum > 0 AND NOT a.attisdropped`, [table]);

  const m = new Map();
  for (const row of r.rows) {
    m.set(row.column_name, {
      type: row.sql_type,
      nullable: !!row.nullable,
      generated: row.generated === 'a',   // 'a' = ALWAYS; '' = not generated
      def: (row.generated === 'a' || !row.column_default) ? null : row.column_default
    });
  }
  _metaCache.set(table, m);
  return m;
}

/** Clear the introspection cache (tests that recreate the schema need this). */
function resetMetaCache() { _metaCache = null; }

/** Build the idempotent upsert for one collection. */
function upsertSql(collection) {
  const spec = TABLES[collection];
  if (!spec) throw new Error('unknown collection: ' + collection);
  const t = spec.table;

  if (spec.singleton) {
    return {
      spec,
      sql: `INSERT INTO ${t} (id, doc, updated_at) VALUES (1, $1, $2)
            ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
      params: doc => [JSON.stringify(doc), Date.now()]
    };
  }

  const keyCols = spec.key.map(snake);
  const colNames = [], fields = [];
  for (const f of spec.key) { colNames.push(snake(f)); fields.push(f); }
  colNames.push('doc'); fields.push('__doc__');
  for (const [f, c] of Object.entries(spec.cols || {})) {
    if (spec.key.includes(f)) continue;
    colNames.push(c); fields.push(f);
  }

  const placeholders = fields.map((_, i) => '$' + (i + 1));
  const updates = colNames.filter(c => !keyCols.includes(c)).map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO ${t} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`
            + ` ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${updates}`;

  const numericF = new Set(spec.numeric || []);
  const jsonbF = new Set(spec.jsonb || []);
  const arrayF = new Set(spec.arrays || []);

  return {
    spec, sql,
    params: doc => fields.map(f => {
      if (f === '__doc__') return JSON.stringify(doc);
      const v = doc[f];
      if (v === undefined) return null;
      if (numericF.has(f)) return numericParam(v);
      if (jsonbF.has(f)) return v === null ? null : JSON.stringify(v);
      if (arrayF.has(f)) return Array.isArray(v) ? v.map(String) : null;
      if (v === null) return null;
      // An unmodelled object/array still lands safely: doc has it verbatim, and
      // the typed column gets JSON text rather than throwing "[object Object]".
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    })
  };
}

/**
 * Async counterpart to upsertSql: same statement, but every NOT NULL column
 * that has a default is wrapped in COALESCE($n, <default>) so a sparse document
 * falls back to the schema's own default instead of inserting an explicit NULL.
 *
 * Pass `client` when calling inside a transaction so the introspection query
 * runs on the same connection.
 */
async function upserter(collection, client) {
  const spec = TABLES[collection];
  if (!spec) throw new Error('unknown collection: ' + collection);
  if (spec.singleton) return upsertSql(collection);

  const meta = await columnMeta(spec.table, client);
  const keyCols = spec.key.map(snake);
  const colNames = [], fields = [];
  for (const f of spec.key) { colNames.push(snake(f)); fields.push(f); }
  colNames.push('doc'); fields.push('__doc__');
  for (const [f, c] of Object.entries(spec.cols || {})) {
    if (spec.key.includes(f)) continue;
    colNames.push(c); fields.push(f);
  }

  const values = colNames.map((c, i) => {
    const m = meta.get(c);
    // Pin the parameter type explicitly. Without this, pg sends parameters as
    // untyped text and Postgres infers a type from context — and COALESCE($n, 0)
    // infers *integer* from the literal, so a bigint epoch-millisecond value
    // fails with "out of range for type integer". Casting to the column's real
    // type removes the inference entirely.
    const ph = m && m.type ? `$${i + 1}::${m.type}` : `$${i + 1}`;
    // A sparse document yields undefined -> NULL, and an explicit NULL defeats
    // a column DEFAULT. Fall back to the schema's own default for NOT NULL
    // columns that have one. Key columns and `doc` are always present.
    if (m && !m.nullable && m.def && !keyCols.includes(c) && c !== 'doc') {
      return `COALESCE(${ph}, ${m.def})`;
    }
    return ph;
  });

  const updates = colNames.filter(c => !keyCols.includes(c)).map(c => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO ${spec.table} (${colNames.join(', ')}) VALUES (${values.join(', ')})`
            + ` ON CONFLICT (${keyCols.join(', ')}) DO UPDATE SET ${updates}`;

  const base = upsertSql(collection);
  return { spec, sql, params: base.params };
}

// ---------------------------------------------------------------------------
// schema migrations
// ---------------------------------------------------------------------------
function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+.*\.sql$/.test(f))
    .sort()
    .map(f => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      return { id: f.replace(/\.sql$/, ''), file: f, sql,
               checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Apply every migration not yet recorded in schema_migrations. Re-running is a
 * no-op. Returns { applied, skipped, drifted, total }.
 *
 * `drifted` means a recorded checksum no longer matches the file on disk —
 * someone edited an already-applied migration, which must never happen. It is
 * reported rather than silently ignored, because a drifted migration means the
 * database and the repo disagree about what the schema is.
 */
async function migrate() {
  const migs = listMigrations();
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
                 id text PRIMARY KEY,
                 applied_at timestamptz NOT NULL DEFAULT now(),
                 checksum text NOT NULL,
                 applied_by text)`);
  const done = new Map((await query('SELECT id, checksum FROM schema_migrations'))
    .rows.map(r => [r.id, r.checksum]));

  const applied = [], skipped = [], drifted = [];
  for (const m of migs) {
    if (done.has(m.id)) {
      if (done.get(m.id) !== m.checksum) drifted.push(m.id);
      skipped.push(m.id);
      continue;
    }
    // Migration files open their own transaction, so run verbatim rather than
    // nesting BEGIN inside BEGIN.
    await query(m.sql);
    await query('INSERT INTO schema_migrations (id, checksum, applied_by) VALUES ($1,$2,$3)',
      [m.id, m.checksum, process.env.RENDER_SERVICE_ID || 'local']);
    applied.push(m.id);
  }
  return { applied, skipped, drifted, total: migs.length };
}

/** Row counts per table. */
async function counts() {
  const out = {};
  for (const c of INSERT_ORDER) {
    const r = await query(`SELECT count(*)::int AS n FROM ${TABLES[c].table}`);
    out[c] = r.rows[0].n;
  }
  return out;
}

/** Read every row's `doc` back out of Postgres, keyed by primary key. */
async function readDocs(collection) {
  const spec = TABLES[collection];
  if (spec.singleton) {
    const r = await query(`SELECT doc FROM ${spec.table} WHERE id = 1`);
    return r.rows.length ? { __singleton__: r.rows[0].doc } : {};
  }
  const sel = spec.key.map(k => `"${snake(k)}"`).join(', ');
  const r = await query(`SELECT ${sel}, doc FROM ${spec.table}`);
  const out = {};
  for (const row of r.rows) {
    const k = spec.key.length === 1
      ? row[snake(spec.key[0])]
      : spec.key.map(f => row[snake(f)]).join('\u0000');
    out[k] = row.doc;
  }
  return out;
}

/** The primary-key string for a doc, matching readDocs' keying. */
function keyOf(collection, doc) {
  const spec = TABLES[collection];
  if (spec.singleton) return '__singleton__';
  return spec.key.length === 1 ? doc[spec.key[0]] : spec.key.map(f => doc[f]).join('\u0000');
}

module.exports = {
  enabled, driver, pool, query, tx, close, migrate, counts, readDocs, keyOf,
  upsertSql, upserter, columnMeta, resetMetaCache,
  numericParam, snake, listMigrations,
  TABLES, INSERT_ORDER, MIGRATIONS_DIR
};
