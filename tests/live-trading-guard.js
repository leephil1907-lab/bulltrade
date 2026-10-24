'use strict';

// Regression test: setting LIVE_TRADING_ENABLED must never make the internal
// simulator accept a "live" order. There is no real exchange execution adapter
// yet, so live-mode orders must fail closed even when the flag is true.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulltrade-live-guard-'));
process.env.BULLTRADE_DATA_DIR = dir;
process.env.ADMIN_PASSWORD = 'TemporaryTestAdmin123!';
process.env.LIVE_TRADING_ENABLED = 'true';
process.env.NODE_ENV = 'test';

try {
  const db = require('../lib/db');
  const trading = require('../lib/trading');
  db.load();

  const result = trading.placeOrder(
    { id: 'test-user', isBot: false },
    { assetId: 'cg-bitcoin', mode: 'live', side: 'buy', type: 'market', notional: 100 }
  );

  assert.equal(result.status, 503, 'live orders must be rejected until real execution is connected');
  assert.match(result.error, /Real-money execution is not connected yet/);
  console.log('PASS: live trading stays blocked even when LIVE_TRADING_ENABLED=true.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
