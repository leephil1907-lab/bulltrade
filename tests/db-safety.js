'use strict';

// Regression test: corrupt persisted state must fail closed, not seed an empty
// database that could overwrite customer balances. Uses an isolated temp path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulltrade-db-safety-'));
process.env.BULLTRADE_DATA_DIR = dir;
process.env.NODE_ENV = 'test';

try {
  const db = require('../lib/db');
  fs.writeFileSync(db.DB_FILE, '{"users": [', 'utf8');
  assert.throws(
    () => db.load(),
    /Refusing to start with an unreadable or corrupt database/,
    'corrupt JSON must stop startup rather than silently reseed'
  );
  assert.equal(
    fs.readFileSync(db.DB_FILE, 'utf8'),
    '{"users": [',
    'the corrupt file must remain untouched for recovery'
  );
  console.log('PASS: corrupt database fails closed and is not overwritten.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
