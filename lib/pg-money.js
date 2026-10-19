'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

let pool;
function getPool() {
  if (!process.env.DATABASE_URL) {
    const error = new Error('DATABASE_URL is required for PostgreSQL financial operations');
    error.code = 'POSTGRES_NOT_CONFIGURED';
    throw error;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PGPOOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      application_name: 'bulltrade-financial-core'
    });
  }
  return pool;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function hash(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}
function conflict(message) {
  const error = new Error(message);
  error.code = 'IDEMPOTENCY_CONFLICT';
  error.status = 409;
  return error;
}
function insufficient() {
  const error = new Error('Insufficient available balance');
  error.code = 'INSUFFICIENT_FUNDS';
  error.status = 400;
  return error;
}

async function withTransaction(work, attempts = 3) {
  const p = getPool();
  for (let attempt = 1; ; attempt++) {
    const client = await p.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (attempt < attempts && ['40001', '40P01'].includes(error.code)) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Wrap a complete money-affecting command in one SERIALIZABLE transaction.
 * The idempotency record, wallet mutations, ledger rows, and business records
 * written by work() commit or roll back together.
 */
async function runIdempotent({ userId, operation, key, payload }, work) {
  if (!userId || !operation || typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new TypeError('userId, operation, and an 8–200 character idempotency key are required');
  }
  const requestHash = hash(payload);
  return withTransaction(async client => {
    await client.query(
      'INSERT INTO financial_idempotency(user_id, operation, idempotency_key, request_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [String(userId), operation, key, requestHash]
    );
    const result = await client.query(
      'SELECT request_hash, response FROM financial_idempotency WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE',
      [String(userId), operation, key]
    );
    const record = result.rows[0];
    if (!record) throw new Error('Failed to acquire idempotency record');
    if (record.request_hash !== requestHash) throw conflict('Idempotency key was already used with a different request');
    if (record.response !== null) return Object.assign({}, record.response, { replayed: true });

    const response = await work(client);
    await client.query(
      'UPDATE financial_idempotency SET response=$4::jsonb WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3',
      [String(userId), operation, key, JSON.stringify(response)]
    );
    return Object.assign({}, response, { replayed: false });
  });
}

/** Must be called with the client from runIdempotent so all legs are atomic. */
async function moveInTransaction(client, movement) {
  const userId = String(movement.userId || '');
  const mode = movement.mode === 'demo' ? 'demo' : movement.mode;
  const currency = String(movement.currency || 'USD').toUpperCase();
  const direction = movement.direction;
  const amountMinor = Number(movement.amountMinor);
  const key = movement.idempotencyKey;
  if (!userId || !['demo', 'live'].includes(mode) || !/^[A-Z]{3}$/.test(currency) ||
      !['credit', 'debit'].includes(direction) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      typeof key !== 'string' || key.length < 8 || key.length > 200 || !movement.type) {
    throw new TypeError('Invalid financial movement');
  }
  const request = {
    userId, mode, currency, direction, amountMinor, type: movement.type,
    referenceId: movement.referenceId || null, metadata: movement.metadata || {}
  };
  const requestHash = hash(request);
  const prior = await client.query(
    'SELECT request_hash, balance_after_minor FROM financial_ledger WHERE user_id=$1 AND mode=$2 AND currency=$3 AND idempotency_key=$4',
    [userId, mode, currency, key]
  );
  if (prior.rows.length) {
    if (prior.rows[0].request_hash !== requestHash) throw conflict('Ledger idempotency key was reused with a different movement');
    return { balanceMinor: Number(prior.rows[0].balance_after_minor), replayed: true };
  }

  await client.query(
    'INSERT INTO financial_wallets(user_id,mode,currency,balance_minor) VALUES($1,$2,$3,0) ON CONFLICT DO NOTHING',
    [userId, mode, currency]
  );
  const locked = await client.query(
    'SELECT balance_minor FROM financial_wallets WHERE user_id=$1 AND mode=$2 AND currency=$3 FOR UPDATE',
    [userId, mode, currency]
  );
  const current = BigInt(locked.rows[0].balance_minor);
  const amount = BigInt(amountMinor);
  const next = direction === 'credit' ? current + amount : current - amount;
  if (next < 0n) throw insufficient();

  await client.query(
    'UPDATE financial_wallets SET balance_minor=$4, updated_at=now() WHERE user_id=$1 AND mode=$2 AND currency=$3',
    [userId, mode, currency, next.toString()]
  );
  await client.query(
    `INSERT INTO financial_ledger
      (user_id,mode,currency,direction,amount_minor,balance_after_minor,movement_type,reference_id,idempotency_key,request_hash,metadata)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [userId, mode, currency, direction, amountMinor, next.toString(), movement.type,
      movement.referenceId || null, key, requestHash, JSON.stringify(movement.metadata || {})]
  );
  return { balanceMinor: Number(next), replayed: false };
}

async function reconciliation(userId, mode = 'live', currency = 'USD') {
  const p = getPool();
  const result = await p.query(
    `SELECT COALESCE(w.balance_minor,0)::text AS wallet_minor,
            COALESCE(SUM(CASE WHEN l.direction='credit' THEN l.amount_minor ELSE -l.amount_minor END),0)::text AS ledger_minor
       FROM (SELECT $1::text AS user_id, $2::text AS mode, $3::char(3) AS currency) scope
       LEFT JOIN financial_wallets w USING(user_id,mode,currency)
       LEFT JOIN financial_ledger l USING(user_id,mode,currency)
      GROUP BY w.balance_minor`,
    [String(userId), mode, currency]
  );
  const row = result.rows[0] || { wallet_minor: '0', ledger_minor: '0' };
  const walletMinor = Number(row.wallet_minor), ledgerMinor = Number(row.ledger_minor);
  return { userId: String(userId), mode, currency, walletMinor, ledgerMinor, differenceMinor: walletMinor - ledgerMinor, balanced: walletMinor === ledgerMinor };
}

async function close() {
  if (pool) { const p = pool; pool = null; await p.end(); }
}

module.exports = { getPool, withTransaction, runIdempotent, moveInTransaction, reconciliation, close, _hash: hash };
