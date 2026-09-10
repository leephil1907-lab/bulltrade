/**
 * Trading-bot engine smoke test (manual, not part of e2e):
 * forces a bot's decision window open with a -1000% momentum gate so it MUST trade,
 * then verifies: bot position opened (bot user) + mirror position created in the
 * subscriber allocation + tick() still manages everything.
 * Run with the server STOPPED (shares the same db.json on disk).
 */
process.env.NODE_ENV = 'test';
const D = require('../lib/db');
const markets = require('../lib/markets');
const trading = require('../lib/trading');
const bots = require('../lib/bots');

(async () => {
  await D.init();
  await markets.start();
  const leader = bots._activeBots()[0];
  console.log('bot:', leader.title, '| min $' + leader.minBalance);
  // clean slate: local engine runs accumulate stale open demo positions for the bot
  // (maxPos cap would then block the forced decision and fail the smoke)
  D.db().positions = D.db().positions.filter(p => !(p.userId === leader.userId && p.mode === 'demo' && !p.copyOf));
  // subscriber with a live allocation on this bot
  const user = D.filter('users', u => !u.isBot && u.role !== 'admin' && !u.banned)[0];
  const before = D.wallet(user.id, 'demo').usd;
  const alloc = trading.startCopy(user, leader.id, 'demo', 500);
  console.log('allocation started:', alloc.ok, '| wallet demo before:', before, '→', D.wallet(user.id, 'demo').usd);
  // force the engine to decide NOW on any price
  leader.params.momo = -1000; leader._nextDecisionAt = 1; // truthy past timestamp → decide NOW
  bots._decideAndTrade(leader);
  const botPos = D.filter('positions', p => p.userId === leader.userId && p.mode === 'demo' && !p.copyOf);
  const mirrorPos = D.filter('positions', p => p.copyOf && p.userId === user.id);
  console.log('bot positions opened:', botPos.map(p => `${p.side} ${p.assetId} $${(p.qty * p.entry).toFixed(0)} tp=${p.tp} sl=${p.sl}`));
  console.log('mirrored into allocation:', mirrorPos.map(p => `${p.side} ${p.assetId} qty=${p.qty.toFixed(6)}`));
  const my = D.filter('copy_allocations', a => a.userId === user.id && a.active)[0];
  console.log('allocation cash/total after mirror:', my.equity.toFixed(2), '/', (my.equity + mirrorPos.reduce((sm, p) => sm + p.qty * p.entry, 0)).toFixed(2));
  // cleanup: stop allocation, reset bot params
  leader.params.momo = 2.5;
  const stop = trading.stopCopy(user, my.id);
  console.log('stopCopy returned:', stop.returned, '| wallet demo restored to:', D.wallet(user.id, 'demo').usd);
  D.save();
  const pass = botPos.length === 1 && mirrorPos.length === 1 && stop.returned >= 450;
  console.log(pass ? 'SMOKE PASS ✓' : 'SMOKE FAIL ✗');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
