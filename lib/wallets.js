'use strict';
const crypto = require('crypto');
const D = require('./db');
const DEFAULT_NETWORKS = ['ethereum','polygon','arbitrum','optimism','base','bsc','bitcoin','litecoin','dogecoin','solana','tron','xrpl','cardano'];
function configured() { return !!(String(process.env.WALLET_PROVIDER_URL || '').trim() && String(process.env.WALLET_PROVIDER_API_KEY || '').trim()); }
function networks() {
  const raw = String(process.env.WALLET_SUPPORTED_NETWORKS || '').trim();
  const list = raw ? raw.split(',').map(x => x.trim().toLowerCase()).filter(Boolean) : DEFAULT_NETWORKS;
  return [...new Set(list)].filter(n => /^[a-z0-9-]{2,32}$/.test(n));
}
function publicRecord(row) { return { id: row.id, network: row.network, address: row.address, walletId: row.walletId || '', memo: row.memo || '', tag: row.tag || '', status: row.status || 'active', createdAt: row.createdAt }; }
async function provisionUser(userId) {
  if (!userId) throw new Error('userId is required');
  if (!configured()) return { enabled: false, provisioned: 0, reason: 'provider_not_configured' };
  const existing = D.filter('wallet_addresses', x => x.userId === userId && x.status === 'active');
  const wanted = networks(), have = new Set(existing.map(x => x.network)), missing = wanted.filter(n => !have.has(n));
  if (!missing.length) return { enabled: true, provisioned: 0, wallets: existing.map(publicRecord) };
  const base = String(process.env.WALLET_PROVIDER_URL).trim().replace(/\/+$/, '');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(base + '/v1/user-wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + String(process.env.WALLET_PROVIDER_API_KEY),
        'Idempotency-Key': 'bulltrade-user:' + crypto.createHash('sha256').update(userId).digest('hex') },
      body: JSON.stringify({ userId, networks: missing }), signal: controller.signal
    });
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error('Wallet provider request failed with HTTP ' + response.status);
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.wallets)) throw new Error('Wallet provider returned an invalid response');
  const accepted = [];
  for (const item of payload.wallets) {
    const network = String(item && item.network || '').trim().toLowerCase(), address = String(item && item.address || '').trim();
    if (!missing.includes(network) || !address || address.length > 256) continue;
    if (D.find('wallet_addresses', x => x.network === network && x.address.toLowerCase() === address.toLowerCase()))
      throw new Error('Wallet provider returned an address already assigned to another account');
    const row = { id: 'wa_' + crypto.randomBytes(12).toString('hex'), userId, network, address,
      walletId: String(item.walletId || '').slice(0, 200), memo: String(item.memo || '').slice(0, 120),
      tag: String(item.tag || '').slice(0, 120), status: 'active', createdAt: Date.now() };
    D.insert('wallet_addresses', row); accepted.push(publicRecord(row));
  }
  D.save(); return { enabled: true, provisioned: accepted.length, wallets: accepted };
}
function listForUser(userId) {
  return D.filter('wallet_addresses', x => x.userId === userId && x.status === 'active')
    .sort((a, b) => a.network.localeCompare(b.network)).map(publicRecord);
}
module.exports = { configured, networks, provisionUser, listForUser };
