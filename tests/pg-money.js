'use strict';

const assert = require('node:assert/strict');
const pgMoney = require('../lib/pg-money');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL tests');
  const userId = 'pg-ci-' + Date.now() + '-' + require('crypto').randomBytes(5).toString('hex');
  const move = (key, direction, amountMinor, operation = 'movement') => pgMoney.runIdempotent({
    userId, operation, key,
    payload: { direction, amountMinor, mode: 'live', currency: 'USD' }
  }, async client => {
    const result = await pgMoney.moveInTransaction(client, {
      userId, mode: 'live', currency: 'USD', direction, amountMinor,
      type: 'ci_test_' + operation, referenceId: key, idempotencyKey: key
    });
    return { balanceMinor: result.balanceMinor };
  });

  try {
    const first = await move('seed-credit-key-0001', 'credit', 10000, 'seed');
    assert.equal(first.balanceMinor, 10000);
    assert.equal(first.replayed, false);

    const replay = await move('seed-credit-key-0001', 'credit', 10000, 'seed');
    assert.equal(replay.balanceMinor, 10000);
    assert.equal(replay.replayed, true, 'retry must return the original result without a second credit');

    await assert.rejects(
      () => move('seed-credit-key-0001', 'credit', 12000, 'seed'),
      error => error.code === 'IDEMPOTENCY_CONFLICT' && error.status === 409
    );

    const debit = await move('ordinary-debit-key-01', 'debit', 2500, 'debit');
    assert.equal(debit.balanceMinor, 7500);

    const concurrent = await Promise.allSettled([
      move('concurrent-debit-key-A', 'debit', 4000, 'concurrent'),
      move('concurrent-debit-key-B', 'debit', 4000, 'concurrent')
    ]);
    assert.equal(concurrent.filter(x => x.status === 'fulfilled').length, 1,
      'only one concurrent debit may spend the remaining available balance');
    assert.equal(concurrent.filter(x => x.status === 'rejected' && x.reason.code === 'INSUFFICIENT_FUNDS').length, 1);

    const check = await pgMoney.reconciliation(userId, 'live', 'USD');
    assert.equal(check.balanced, true, JSON.stringify(check));
    assert.equal(check.walletMinor, check.ledgerMinor);
    assert.equal(check.walletMinor, 3500);

    const rows = await pgMoney.getPool().query(
      'SELECT count(*)::int AS n FROM financial_ledger WHERE user_id=$1',
      [userId]
    );
    assert.equal(rows.rows[0].n, 3, 'one credit and two successful debits should be posted exactly once');
    console.log('PostgreSQL financial integration tests passed: atomic ledger, idempotency, concurrency, reconciliation.');
  } finally {
    await pgMoney.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
