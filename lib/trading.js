'use strict';
/**
 * Trading engine: market/limit orders, leverage, TP/SL, positions, P/L,
 * liquidation, and the COPY-TRADING mirror engine.
 * Demo and live books are separate. Live trading requires approved KYC.
 */
const { uid, now, round } = require('./utils');
const D = require('./db');
const markets = require('./markets');
const gamify = require('./gamify');

const FEE_RATE = 0.001;        // 0.1% taker fee
const SPREAD = 0.0005;         // 0.05% spread on market fills
const LIQ_LEVEL = 0.90;        // liquidate when loss >= 90% of margin
const MIN_COPY = 50;           // minimum copy allocation (USD)

function assetOf(symbolId) { return markets.byId[symbolId]; }

function positionPnl(p, price) {
  if (price == null) return 0;
  const dir = p.side === 'buy' ? 1 : -1;
  return (price - p.entry) * p.qty * dir;
}

/** Allocation totals for copy-trading (cash held + open mirrored positions). */
function allocationTotals(userId, mode) {
  let cash = 0, marginUsed = 0, unrealized = 0;
  const allocs = D.filter('copy_allocations', a => a.userId === userId && a.active && (!mode || a.mode === mode));
  for (const a of allocs) {
    cash += a.equity;
    for (const p of D.filter('positions', p => p.allocId === a.id)) {
      const price = markets.priceOf(p.assetId);
      unrealized += positionPnl(p, price);
      marginUsed += p.margin;
    }
  }
  return { count: allocs.length, cash: round(cash), marginUsed: round(marginUsed), unrealized: round(unrealized) };
}

function userBook(userId, mode) {
  const positions = D.filter('positions', p => p.userId === userId && p.mode === mode && !p.copyOf);
  const mirrored = D.filter('positions', p => p.userId === userId && p.mode === mode && p.copyOf);
  const orders = D.filter('orders', o => o.userId === userId && o.mode === mode);
  const trades = D.filter('trades', t => t.userId === userId && t.mode === mode).sort((a, b) => b.closedAt || b.at - (a.closedAt || a.at)).slice(0, 150);
  return { positions, mirrored, orders, trades };
}

function equity(userId, mode) {
  const w = D.wallet(userId, mode, false);
  let free = w ? w.usd : 0;
  let unrealized = 0, marginUsed = 0;
  for (const p of D.filter('positions', p => p.userId === userId && p.mode === mode)) {
    const price = markets.priceOf(p.assetId);
    unrealized += positionPnl(p, price);
    marginUsed += p.margin;
  }
  const allocs = allocationTotals(userId, mode);
  return {
    free: round(free), marginUsed: round(marginUsed), unrealized: round(unrealized),
    inCopy: round(allocs.cash + allocs.marginUsed + allocs.unrealized),
    equity: round(free + marginUsed + unrealized + allocs.cash + allocs.marginUsed + allocs.unrealized)
  };
}

function placeOrder(user, o) {
  const asset = assetOf(o.assetId);
  if (!asset || !asset.tradable) return { status: 400, error: 'Unknown or non-tradable asset' };
  const mode = o.mode === 'live' ? 'live' : 'demo';
  if (mode === 'live' && !user.isBot) { // platform bots trade both books without KYC
    const kyc = D.find('kyc', k => k.userId === user.id);
    if (!kyc || kyc.status !== 'approved') return { status: 403, error: 'KYC verification is required before live trading. Complete KYC from your dashboard.' };
  }
  const side = o.side === 'sell' ? 'sell' : 'buy';
  const type = o.type === 'limit' ? 'limit' : 'market';
  const price = markets.priceOf(o.assetId);
  if (price == null) return { status: 503, error: 'Live price unavailable for this asset, try again in a moment' };

  const notional = Number(o.notional);
  if (!isFinite(notional) || notional <= 0) return { status: 400, error: 'Enter a valid amount' };
  if (notional < 10) return { status: 400, error: 'Minimum order size is $10' };
  if (notional > 1000000) return { status: 400, error: 'Maximum order size is $1,000,000' };

  const leverage = Math.min(Math.max(parseInt(o.leverage) || 1, 1), asset.maxLeverage || 1);
  const margin = round(notional / leverage);
  const fee = round(notional * FEE_RATE);
  const wallet = D.wallet(user.id, mode, false);
  if (!wallet || wallet.usd < margin + fee) return { status: 400, error: `Insufficient balance. Need $${round(margin + fee)} (margin + fee), available $${round(wallet ? wallet.usd : 0)}.` };

  const tp = o.tp ? Number(o.tp) : null;
  const sl = o.sl ? Number(o.sl) : null;

  if (type === 'limit') {
    const limitPrice = Number(o.limitPrice);
    if (!isFinite(limitPrice) || limitPrice <= 0) return { status: 400, error: 'Enter a valid limit price' };
    const order = {
      id: uid('o_'), userId: user.id, mode, assetId: o.assetId, symbol: asset.symbol, name: asset.name,
      side, type, limitPrice: round(limitPrice, asset.price >= 1000 ? 2 : 6), notional: round(notional),
      qty: round(notional / limitPrice, 8), leverage, tp, sl, fee,
      createdAt: now(), status: 'open'
    };
    D.insert('orders', order);
    return { ok: true, order, message: `Limit ${side} order placed for ${asset.symbol}` };
  }

  // market order
  const fill = round(side === 'buy' ? price * (1 + SPREAD) : price * (1 - SPREAD), asset.price >= 1000 ? 2 : 6);
  const qty = round(notional / fill, 8);
  wallet.usd = round(wallet.usd - margin - fee);
  D.save();
  const position = {
    id: uid('p_'), userId: user.id, mode, assetId: o.assetId, symbol: asset.symbol, name: asset.name,
    side, qty, entry: fill, leverage, margin, fee, tp, sl,
    openedAt: now(), status: 'open', orderType: 'market'
  };
  D.insert('positions', position);
  D.insert('trades', {
    id: uid('t_'), userId: user.id, mode, assetId: o.assetId, symbol: asset.symbol, name: asset.name,
    side, type: 'market', qty, price: fill, notional: round(notional), fee, leverage,
    at: now(), action: 'open', pnl: 0
  });
  gamify.addXP(user.id, 50, 'order');
  gamify.grantBadge(user.id, 'first_trade');
  mirrorToCopiers(user, position, asset);
  return { ok: true, position, message: `Market ${side} executed: ${asset.symbol} @ $${fill}` };
}

/** Copy-trading: mirror a leader's fresh position into every active allocation. */
function mirrorToCopiers(leader, position, asset) {
  const leaderRec = D.find('copy_leaders', l => l.userId === leader.id && l.status === 'active');
  if (!leaderRec) return;
  const leaderEq = equity(leader.id, position.mode).equity;
  if (leaderEq <= 0) return;
  const allocs = D.filter('copy_allocations', a => a.leaderId === leaderRec.id && a.active && a.mode === position.mode);
  for (const alloc of allocs) {
    if (alloc.userId === leader.id) continue;
    const ratio = alloc.equity / leaderEq;                 // proportional sizing
    let mirrorNotional = round((position.qty * position.entry) * ratio);
    if (mirrorNotional < 10) continue;
    // cap by available allocation cash (margin + fee must fit)
    const unitCost = 1 / position.leverage + FEE_RATE;
    const maxNotional = alloc.equity / unitCost;
    if (maxNotional < 10) continue;
    if (mirrorNotional > maxNotional) mirrorNotional = round(maxNotional);
    const mMargin = round(mirrorNotional / position.leverage);
    const mFee = round(mirrorNotional * FEE_RATE);
    alloc.equity = round(alloc.equity - mMargin - mFee);
    D.insert('positions', {
      id: uid('p_'), userId: alloc.userId, mode: position.mode, assetId: position.assetId,
      symbol: position.symbol, name: position.name, side: position.side,
      qty: round(mirrorNotional / position.entry, 8), entry: position.entry,
      leverage: position.leverage, margin: mMargin, fee: mFee, tp: position.tp, sl: position.sl,
      openedAt: now(), status: 'open', orderType: 'copy', copyOf: position.id, allocId: alloc.id
    });
  }
  D.save();
}

function closePosition(user, positionId, opts = {}) {
  const p = D.find('positions', x => x.id === positionId);
  if (!p || p.userId !== user.id) return { status: 404, error: 'Position not found' };
  if (p.copyOf && !opts.bySystem) return { status: 400, error: 'This is a mirrored copy position — close it by stopping the copy allocation.' };
  const price = markets.priceOf(p.assetId);
  if (price == null) return { status: 503, error: 'Live price unavailable, try again' };
  const exit = round(p.side === 'buy' ? price * (1 - SPREAD) : price * (1 + SPREAD), price >= 1000 ? 2 : 6);
  return settlePosition(p, exit, opts.reason || 'manual');
}

function settlePosition(p, exitPrice, reason) {
  const pnl = round(positionPnl(p, exitPrice));
  const exitFee = round(p.qty * exitPrice * FEE_RATE);
  let returned = p.margin + pnl - exitFee;
  let liquidated = false;
  if (pnl <= -(p.margin * LIQ_LEVEL)) {
    liquidated = true;
    returned = round(p.margin * (1 - LIQ_LEVEL));
  }
  returned = round(returned);
  if (p.allocId) {
    // mirrored copy position: return funds to the allocation, not the wallet
    const alloc = D.find('copy_allocations', a => a.id === p.allocId);
    if (alloc) alloc.equity = round(alloc.equity + Math.max(returned, 0));
  } else {
    const w = D.wallet(p.userId, p.mode);
    w.usd = round(w.usd + Math.max(returned, 0));
  }
  D.remove('positions', x => x.id === p.id);
  D.insert('trades', {
    id: uid('t_'), userId: p.userId, mode: p.mode, assetId: p.assetId, symbol: p.symbol, name: p.name,
    side: p.side === 'buy' ? 'sell' : 'buy', type: p.orderType || 'market', qty: p.qty, price: exitPrice,
    notional: round(p.qty * exitPrice), fee: exitFee, leverage: p.leverage,
    at: now(), action: 'close', reason, pnl: round(pnl - exitFee),
    entry: p.entry, margin: p.margin, liquidated, positionId: p.id, copyOf: p.copyOf || null
  });
  if (!p.copyOf && p.userId) {
    gamify.addXP(p.userId, 10, 'close');
    if (pnl - exitFee > 0) gamify.grantBadge(p.userId, 'profitable');
    if (p.qty * exitPrice >= 5000) gamify.grantBadge(p.userId, 'big_shot');
    const closed = D.filter('trades', t => t.userId === p.userId && t.action === 'close' && !t.copyOf);
    if (closed.length >= 10) gamify.grantBadge(p.userId, 'ten_trades');
    const recent = closed.sort((a, b) => b.at - a.at).slice(0, 3);
    if (recent.length === 3 && recent.every(t => t.pnl > 0)) gamify.grantBadge(p.userId, 'streak_3');
  }
  D.save();
  // if this was a leader's original position, settle its mirrors at the same price
  if (!p.copyOf) {
    for (const m of [...D.db().positions]) {
      if (m.copyOf === p.id) settlePosition(m, exitPrice, 'copy:' + reason);
    }
  }
  return { ok: true, pnl: round(pnl - exitFee), returned, liquidated, exitPrice };
}

/** Modify an open position: TP / SL / trailing-stop percentage. */
function modifyPosition(user, positionId, o) {
  const p = D.find('positions', x => x.id === positionId);
  if (!p || p.userId !== user.id) return { status: 404, error: 'Position not found' };
  if (p.copyOf) return { status: 400, error: 'Mirrored copy positions are managed by the copy allocation.' };
  const out = { id: p.id, tp: p.tp, sl: p.sl, trailPct: p.trailPct || 0 };
  if ('tp' in o) {
    const tp = o.tp == null || o.tp === '' ? null : Number(o.tp);
    if (tp != null && (!isFinite(tp) || tp <= 0)) return { status: 400, error: 'Invalid take-profit price' };
    p.tp = tp; out.tp = tp;
  }
  if ('sl' in o) {
    const sl = o.sl == null || o.sl === '' ? null : Number(o.sl);
    if (sl != null && (!isFinite(sl) || sl <= 0)) return { status: 400, error: 'Invalid stop-loss price' };
    p.sl = sl; out.sl = sl;
  }
  if ('trailPct' in o) {
    const tr = o.trailPct == null || o.trailPct === '' || Number(o.trailPct) === 0 ? 0 : Number(o.trailPct);
    if (!isFinite(tr) || tr < 0 || tr > 50) return { status: 400, error: 'Trailing stop must be between 0 and 50%' };
    p.trailPct = tr || undefined;
    if (!tr) p.peak = undefined;
    out.trailPct = tr;
  }
  D.save();
  return { ok: true, position: out, message: 'Position updated' };
}

function cancelOrder(user, orderId) {
  const o = D.find('orders', x => x.id === orderId);
  if (!o || o.userId !== user.id) return { status: 404, error: 'Order not found' };
  D.remove('orders', x => x.id === orderId);
  return { ok: true, message: 'Order cancelled' };
}

function resetDemo(user) {
  // close mirrors tied to demo allocations then drop them
  for (const a of D.filter('copy_allocations', x => x.userId === user.id && x.mode === 'demo')) {
    stopCopy(user, a.id, true);
  }
  D.remove('positions', p => p.userId === user.id && p.mode === 'demo');
  D.remove('orders', o => o.userId === user.id && o.mode === 'demo');
  const w = D.wallet(user.id, 'demo');
  w.usd = Number(D.db().settings.demoStartBalance) || 10000;
  D.save();
  return { ok: true, message: 'Demo account reset' };
}

/* ================= COPY TRADING ================= */

function startCopy(user, leaderId, mode, amount) {
  mode = mode === 'live' ? 'live' : 'demo';
  const amt = Number(amount);
  if (!isFinite(amt) || amt < MIN_COPY) return { status: 400, error: `Minimum copy allocation is $${MIN_COPY}.` };
  const leader = D.find('copy_leaders', l => l.id === leaderId && l.status === 'active');
  if (!leader) return { status: 404, error: 'This leader is not active for copying.' };
  const leaderUser = D.find('users', u => u.id === leader.userId);
  if (!leaderUser || leaderUser.id === user.id) return { status: 400, error: 'You cannot copy yourself.' };
  if (D.find('copy_allocations', a => a.userId === user.id && a.leaderId === leaderId && a.active)) {
    return { status: 409, error: 'You are already copying this leader. Stop the current allocation first.' };
  }
  if (mode === 'live') {
    const kyc = D.find('kyc', k => k.userId === user.id);
    if (!kyc || kyc.status !== 'approved') return { status: 403, error: 'KYC verification is required to copy with live funds. Demo copying is available without KYC.' };
  }
  const w = D.wallet(user.id, mode, false);
  if (!w || w.usd < amt) return { status: 400, error: `Insufficient ${mode} balance. Available: $${round(w ? w.usd : 0)}.` };
  w.usd = round(w.usd - amt);
  gamify.addXP(user.id, 30, 'copy');
  gamify.grantBadge(user.id, 'copy_starter');
  const alloc = D.insert('copy_allocations', {
    id: uid('ca_'), userId: user.id, leaderId, mode, allocated: round(amt), equity: round(amt),
    active: true, startedAt: now(), stoppedAt: 0
  });
  // immediately mirror the leader's currently open positions (proportional sizing)
  const leaderEquity = equity(leaderUser.id, mode).equity;
  if (leaderEquity > 0) {
    const ratio = amt / leaderEquity;
    for (const p of D.filter('positions', x => x.userId === leaderUser.id && x.mode === mode && !x.copyOf)) {
      let mn = round((p.qty * p.entry) * ratio);
      if (mn < 10) continue;
      const unitCost = 1 / p.leverage + FEE_RATE;
      const maxN = alloc.equity / unitCost;
      if (maxN < 10) continue;
      if (mn > maxN) mn = round(maxN);
      const mMargin = round(mn / p.leverage), mFee = round(mn * FEE_RATE);
      alloc.equity = round(alloc.equity - mMargin - mFee);
      D.insert('positions', {
        id: uid('p_'), userId: user.id, mode, assetId: p.assetId, symbol: p.symbol, name: p.name,
        side: p.side, qty: round(mn / p.entry, 8), entry: p.entry, leverage: p.leverage,
        margin: mMargin, fee: mFee, tp: p.tp, sl: p.sl,
        openedAt: now(), status: 'open', orderType: 'copy', copyOf: p.id, allocId: alloc.id
      });
    }
    D.save();
  }
  return { ok: true, allocation: alloc, message: `Now copying ${leaderUser.name} with $${round(amt)} in ${mode} funds.` };
}

function stopCopy(user, allocationId, silent) {
  const alloc = D.find('copy_allocations', a => a.id === allocationId && a.userId === user.id);
  if (!alloc || !alloc.active) return { status: 404, error: 'Allocation not found' };
  // close any open mirrored positions at market
  for (const m of [...D.db().positions]) {
    if (m.allocId === alloc.id) {
      const price = markets.priceOf(m.assetId);
      if (price == null) continue;
      const exit = round(m.side === 'buy' ? price * (1 - SPREAD) : price * (1 + SPREAD), price >= 1000 ? 2 : 6);
      settlePosition(m, exit, 'copy-stopped');
    }
  }
  const returned = alloc.equity;
  D.creditWallet(alloc.userId, alloc.mode, returned);
  alloc.equity = 0;
  alloc.active = false;
  alloc.stoppedAt = now();
  D.save();
  const result = { ok: true, returned: round(returned), message: `Copy stopped — $${round(returned)} returned to your ${alloc.mode} wallet.` };
  if (silent) return result;
  return result;
}

function leaderStats(leaderRec) {
  const uid_ = leaderRec.userId;
  const out = {};
  for (const mode of ['demo', 'live']) {
    const trades = D.filter('trades', t => t.userId === uid_ && t.mode === mode && t.action === 'close' && !t.copyOf);
    const closed = trades.length;
    const wins = trades.filter(t => t.pnl > 0).length;
    const realized = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const marginSum = trades.reduce((s, t) => s + (t.margin || 0), 0);
    const notionalSum = trades.reduce((s, t) => s + (t.notional || 0), 0);
    // cumulative pnl series (for sparkline)
    const series = [];
    let acc = 0;
    trades.slice().sort((a, b) => a.at - b.at).forEach(t => { acc += t.pnl || 0; series.push(round(acc)); });
    out[mode] = {
      trades: closed, winRate: closed ? round(wins / closed * 100, 1) : null,
      realized: round(realized), roi: marginSum ? round(realized / marginSum * 100, 1) : null,
      volume: round(notionalSum), series
    };
  }
  out.copiers = D.filter('copy_allocations', a => a.leaderId === leaderRec.id && a.active).length;
  out.totalCopied = D.filter('copy_allocations', a => a.leaderId === leaderRec.id).reduce((s, a) => s + a.allocated, 0);
  return out;
}

/* ================= LEADER BOT =================
 * Seeded showcase leaders keep trading their demo books so copy-trading
 * allocations have live activity to mirror. Runs inside tick() every ~90s.
 */
const LEADER_BOT_ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'AVAX', 'LINK', 'AAPL', 'NVDA', 'TSLA', 'XAU', 'XAG', 'SPX'];
let lastBotAt = 0;

function leaderBot() {
  const activeLeaders = D.filter('copy_leaders', l => l.status === 'active');
  for (const rec of activeLeaders) {
    const leaderUser = D.find('users', u => u.id === rec.userId);
    if (!leaderUser || !leaderUser.seeded) continue;               // only showcase leaders auto-trade
    const wallet = D.wallet(leaderUser.id, 'demo');
    if (!wallet) continue;
    if (wallet.usd < 2500) wallet.usd = 10000;                     // demo book housekeeping
    const open = D.filter('positions', p => p.userId === leaderUser.id && p.mode === 'demo' && !p.copyOf);
    const roll = Math.random();
    if (open.length >= 2 && roll < 0.30) {
      // close the oldest position (strategy rotation)
      const oldest = open.sort((a, b) => a.openedAt - b.openedAt)[0];
      closePosition(leaderUser, oldest.id, { reason: 'strategy' });
      continue;
    }
    if (open.length >= 4 || roll < 0.35) continue;                 // sometimes do nothing
    // open a fresh demo position on a liquid asset
    const picks = LEADER_BOT_ASSETS.map(s => markets.ASSETS.find(a => a.symbol === s))
      .filter(a => a && a.tradable && markets.priceOf(a.id) != null);
    if (!picks.length) continue;
    const asset = picks[Math.floor(Math.random() * picks.length)];
    const side = Math.random() < 0.6 ? 'buy' : 'sell';
    const leverage = 1 + Math.floor(Math.random() * (Math.min(asset.maxLeverage || 1, 5)));
    const notional = round(200 + Math.random() * 700);
    const price = markets.priceOf(asset.id);
    const tpPct = 0.02 + Math.random() * 0.03, slPct = 0.012 + Math.random() * 0.01;
    const tp = round(side === 'buy' ? price * (1 + tpPct) : price * (1 - tpPct), price >= 1000 ? 2 : 6);
    const sl = round(side === 'buy' ? price * (1 - slPct) : price * (1 + slPct), price >= 1000 ? 2 : 6);
    placeOrder(leaderUser, { assetId: asset.id, side, type: 'market', mode: 'demo', notional, leverage, tp, sl });
  }
}

/** Called on every market refresh tick: fills limit orders, TP/SL, liquidations */
function tick() {
  const prices = {};
  for (const a of markets.ASSETS) prices[a.id] = markets.priceOf(a.id);
  // 1) fill limit orders
  for (const o of [...D.db().orders]) {
    const price = prices[o.assetId];
    if (price == null) continue;
    const crossed = o.side === 'buy' ? price <= o.limitPrice : price >= o.limitPrice;
    if (!crossed) continue;
    const wallet = D.wallet(o.userId, o.mode, false);
    const margin = round(o.notional / o.leverage);
    if (!wallet || wallet.usd < margin + o.fee) { D.remove('orders', x => x.id === o.id); continue; }
    wallet.usd = round(wallet.usd - margin - o.fee);
    D.remove('orders', x => x.id === o.id);
    const position = {
      id: uid('p_'), userId: o.userId, mode: o.mode, assetId: o.assetId, symbol: o.symbol, name: o.name,
      side: o.side, qty: o.qty, entry: o.limitPrice, leverage: o.leverage, margin, fee: o.fee,
      tp: o.tp, sl: o.sl, openedAt: now(), status: 'open', orderType: 'limit'
    };
    D.insert('positions', position);
    D.insert('trades', {
      id: uid('t_'), userId: o.userId, mode: o.mode, assetId: o.assetId, symbol: o.symbol, name: o.name,
      side: o.side, type: 'limit', qty: o.qty, price: o.limitPrice, notional: o.notional, fee: o.fee,
      leverage: o.leverage, at: now(), action: 'open', pnl: 0
    });
    D.save();
    const owner = D.find('users', u => u.id === o.userId);
    if (owner) mirrorToCopiers(owner, position, markets.byId[o.assetId]);
  }
  // 2) TP / SL / liquidation + trailing stops on open positions (originals only; mirrors follow their leader)
  for (const p of [...D.db().positions]) {
    if (p.copyOf) continue;
    const price = prices[p.assetId];
    if (price == null) continue;
    // trailing stop: ratchet the stop behind the best price seen
    if (p.trailPct > 0) {
      if (p.side === 'buy') {
        p.peak = Math.max(p.peak || p.entry, price);
        const t = round(p.peak * (1 - p.trailPct / 100), price >= 1000 ? 2 : 6);
        if (p.sl == null || t > p.sl) p.sl = t;
      } else {
        p.peak = Math.min(p.peak || p.entry, price);
        const t = round(p.peak * (1 + p.trailPct / 100), price >= 1000 ? 2 : 6);
        if (p.sl == null || t < p.sl) p.sl = t;
      }
      D.save();
    }
    const pnl = positionPnl(p, price);
    if (pnl <= -(p.margin * LIQ_LEVEL)) { settlePosition(p, price, 'liquidation'); continue; }
    if (p.tp != null && ((p.side === 'buy' && price >= p.tp) || (p.side === 'sell' && price <= p.tp))) { settlePosition(p, price, 'take-profit'); continue; }
    if (p.sl != null && ((p.side === 'buy' && price <= p.sl) || (p.side === 'sell' && price >= p.sl))) { settlePosition(p, price, p.trailPct > 0 ? 'trailing-stop' : 'stop-loss'); continue; }
  }
  // 3) price alerts (fires on every refresh tick)
  try { checkAlerts(prices); } catch (e) { /* never break the tick */ }
  // 4) showcase leader activity (every ~90s) so copy allocations mirror live trades
  if (now() - lastBotAt > 90000) {
    lastBotAt = now();
    try { leaderBot(); } catch (e) { /* never break the tick */ }
  }
}

/** Price alerts: mark triggered when target crossed. Called from tick() and GET /api/alerts. */
function checkAlerts(prices) {
  let changed = false;
  for (const a of D.db().alerts) {
    if (a.status !== 'active') continue;
    const price = prices[a.assetId];
    if (price == null) continue;
    if ((a.dir === 'above' && price >= a.target) || (a.dir === 'below' && price <= a.target)) {
      a.status = 'triggered'; a.triggeredAt = now(); a.triggeredPrice = price; a.seen = false;
      changed = true;
    }
  }
  if (changed) D.save();
}

module.exports = {
  placeOrder, closePosition, cancelOrder, resetDemo, userBook, equity, positionPnl, tick,
  startCopy, stopCopy, leaderStats, allocationTotals, modifyPosition, checkAlerts, MIN_COPY, FEE_RATE, SPREAD
};
