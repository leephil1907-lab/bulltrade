'use strict';

const assert = require('node:assert/strict');
const exchange = require('../lib/exchange-adapter');

async function main() {
  const adapter = exchange.createUnavailableAdapter();
  assert.deepEqual(adapter.status(), {
    configured: false,
    provider: 'none',
    executionEnabled: false,
    reason: 'No approved exchange execution provider is configured.'
  });
  assert.deepEqual(exchange.getAdapterStatus(adapter), adapter.status());
  await assert.rejects(adapter.submitOrder({ symbol: 'BTCUSDT', side: 'buy', quantity: '0.001' }),
    error => error.code === 'EXCHANGE_UNAVAILABLE' && error.status === 503);
  assert.throws(() => exchange.validateAdapter({ getBalances() {} }),
    error => error.code === 'INVALID_EXCHANGE_ADAPTER' && error.message.includes('submitOrder') && error.message.includes('listFills'));
  const valid = Object.fromEntries(exchange.REQUIRED_METHODS.map(name => [name, async () => ({})]));
  assert.equal(exchange.validateAdapter(valid), valid);
  console.log('PASS: exchange boundary fails closed and validates provider contract.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
