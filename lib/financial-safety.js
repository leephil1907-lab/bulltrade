'use strict';

// The JSON-backed app routes have not yet been migrated to PostgreSQL transactions.
// Keep all live-money paths closed until the migration is wired end-to-end and reviewed.
// CI alone may opt in to exercise legacy live-flow regression cases against disposable data.
const POSTGRES_MONEY_INTEGRATED = false;

function liveMoneyBlocked() {
  if (POSTGRES_MONEY_INTEGRATED) return false;
  return !(process.env.NODE_ENV === 'test' && process.env.BULLTRADE_TEST_ALLOW_LIVE_MONEY === 'true');
}

function requireLiveMoneyReady(res, fail) {
  if (!liveMoneyBlocked()) return true;
  fail(res, 503, 'Live-money operations are disabled until PostgreSQL transactions and reconciliation are fully integrated.');
  return false;
}

module.exports = { liveMoneyBlocked, requireLiveMoneyReady, POSTGRES_MONEY_INTEGRATED };
