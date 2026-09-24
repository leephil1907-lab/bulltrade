'use strict';

/**
 * Append-only money movement journal.
 * Wallet balances remain the hot read model for now; every balance mutation
 * must go through creditWallet/debitWallet and create a ledger row.
 */
const { uid, now, round } = require('./utils');

function entry(D, data) {
  const amount = round(Number(data.amount));
  if (!isFinite(amount) || amount === 0) throw new Error('Ledger amount must be non-zero');
  const row = Object.assign({
    id: uid('led_'),
    createdAt: now(),
    status: 'posted',
    currency: 'USD'
  }, data, { amount });
  D.insert('ledger', row);
  return row;
}

function balance(D, userId, mode) {
  return D.filter('ledger', x => x.userId === userId && x.mode === mode && x.status === 'posted')
    .reduce((sum, x) => sum + (x.direction === 'credit' ? x.amount : -x.amount), 0);
}

function userEntries(D, userId, mode, limit = 100) {
  return D.filter('ledger', x => x.userId === userId && (!mode || x.mode === mode))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

function reconcile(D, userId, mode) {
  const wallet = D.wallet(userId, mode, false);
  const walletBalance = round(wallet ? wallet.usd : 0);
  const journalBalance = round(balance(D, userId, mode));
  return {
    userId, mode, walletBalance, journalBalance,
    difference: round(walletBalance - journalBalance),
    balanced: Math.abs(walletBalance - journalBalance) < 0.01
  };
}

module.exports = { entry, balance, userEntries, reconcile };
