'use strict';
/**
 * Trading Bots engine — automated strategy execution.
 *
 * The four platform bots (seeded in lib/db.js) scan live market momentum on
 * a cooldown and open managed positions (TP/SL attached) in every wallet mode
 * where they have active subscribers. The existing copy-mirror engine then
 * replicates each bot position proportionally into subscribers' allocations,
 * and trading.tick() manages the exits (TP/SL/liquidation) for everyone.
 *
 * Bots only trade when: prices are live, they have active allocations in
 * that mode, position-count and same-asset re-entry guards pass, and their
 * randomised cooldown has elapsed.
 */
const D = require('./db');
const U = require('./utils');
const markets = require('./markets');
const trading = require('./trading');

const SCAN_MS = 60 * 1000; // evaluate bots once a minute

function activeBots() {
  return D.filter('copy_leaders', l => l.bot && l.status === 'active');
}

function decideAndTrade(leader) {
  const botUser = D.find('users', u => u.id === leader.userId);
  if (!botUser || botUser.banned) return;
  const params = leader.params || {};
  // randomised cooldown (stored in-memory on the leader record)
  if (!leader._nextDecisionAt) leader._nextDecisionAt = Date.now() + 60 * 1000;
  if (Date.now() < leader._nextDecisionAt) return;
  const cd = (params.cdMin || 5) + Math.random() * Math.max(0, (params.cdMax || 8) - (params.cdMin || 5));
  leader._nextDecisionAt = Date.now() + cd * 60 * 1000;

  // which wallet modes have active subscribers?
  const modes = ['demo', 'live'].filter(m =>
    D.filter('copy_allocations', a => a.leaderId === leader.id && a.active && a.mode === m).length);
  if (!modes.length) return;

  // strongest 24h momentum in the bot's universe (live quote snapshot)
  const snap = markets.snapshot().assets;
  const assets = (leader.universe || [])
    .map(id => snap.find(a => a.id === id))
    .filter(a => a && a.tradable && a.price != null && a.changePct != null);
  if (!assets.length) return;
  const pick = assets.slice().sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))[0];
  const momo = params.momo || 2;
  if (Math.abs(pick.changePct) < momo) return; // market too quiet for this bot

  const side = pick.changePct > 0 ? 'buy' : 'sell';
  const dp = pick.price >= 1000 ? 2 : 6;
  for (const mode of modes) {
    const open = D.filter('positions', p => p.userId === botUser.id && p.mode === mode && !p.copyOf);
    if (open.length >= (params.maxPos || 3)) continue;
    if (open.some(p => p.assetId === pick.id && p.side === side)) continue; // already in this trade
    const eq = trading.equity(botUser.id, mode).equity;
    if (eq <= 100) continue;
    const notional = U.round(Math.max(10, eq * (params.sizePct || 15) / 100));
    const tp = U.round(pick.price * (side === 'buy' ? 1 + (params.tpPct || 3) / 100 : 1 - (params.tpPct || 3) / 100), dp);
    const sl = U.round(pick.price * (side === 'buy' ? 1 - (params.slPct || 2) / 100 : 1 + (params.slPct || 2) / 100), dp);
    const r = trading.placeOrder(botUser, {
      assetId: pick.id, side, type: 'market', mode, notional,
      leverage: params.lev || 2, tp, sl
    });
    if (r.ok) console.log(`[bots] ${leader.title}: ${side.toUpperCase()} ${pick.symbol} $${notional} (${mode}) — mirrors ${D.filter('copy_allocations', a => a.leaderId === leader.id && a.active && a.mode === mode).length} allocation(s)`);
  }
}

function start() {
  setInterval(() => {
    try { activeBots().forEach(decideAndTrade); } catch (e) { console.error('[bots] cycle error:', e.message); }
  }, SCAN_MS).unref();
  console.log('[bots] Trading bot engine running (60s scan cycle)');
}

module.exports = { start, _decideAndTrade: decideAndTrade, _activeBots: activeBots };
