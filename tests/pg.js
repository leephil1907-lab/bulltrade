'use strict';
/**
 * PostgreSQL integration suite — Phase 1 migration tooling.
 *
 * Requires a real server. Skips cleanly (exit 0) when DATABASE_URL is unset, so
 * `npm test` still passes on a laptop or in CI without Postgres.
 *
 *   DATABASE_URL=postgres://user:pw@host:5432/bulltrade_test node tests/pg.js
 *
 * SAFETY: this suite TRUNCATEs every table it touches. It refuses to run unless
 * the target database name looks like a scratch database (test/tmp/scratch/dev),
 * or you explicitly override with PG_TEST_FORCE=1. That guard exists because
 * pointing it at production by accident would be unrecoverable.
 *
 * Tested against PostgreSQL 17.
 */
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const Pg = require(path.join(ROOT, 'lib', 'pg'));
const Parity = require(path.join(ROOT, 'lib', 'pg-parity'));

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  ✔', n); }
  else { fail++; console.log('  ✘ FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0, 400) : ''); }
};

const URL_ = process.env.DATABASE_URL || '';
if (!URL_) {
  console.log('== postgres suite SKIPPED (DATABASE_URL not set) ==');
  console.log('   To run it:  DATABASE_URL=postgres://user:pw@host:5432/bulltrade_test node tests/pg.js');
  process.exit(0);
}

const dbName = ((/\/([^/?]+)(\?|$)/.exec(URL_) || [])[1] || '').toLowerCase();
const looksScratch = /(test|tmp|temp|scratch|dev|ci)/.test(dbName);
if (!looksScratch && process.env.PG_TEST_FORCE !== '1') {
  console.error(`== postgres suite REFUSED ==
   Target database "${dbName}" does not look like a scratch database.
   This suite TRUNCATEs every table it touches.
   Point DATABASE_URL at a throwaway database, or re-run with PG_TEST_FORCE=1
   if you are certain this target is disposable.`);
  process.exit(1);
}

/** A dataset that deliberately exercises the awkward cases. */
function fixture() {
  const uid = p => p + crypto.randomBytes(6).toString('base64url');
  const u1 = uid('u_'), u2 = uid('u_');
  const chatId = uid('c_'), leaderId = uid('cl_');
  return {
    users: [
      // Sparse on purpose: no suspended, no totpEnabled, no xp, no manualPnl.
      // This is the case that broke on an explicit NULL defeating the DEFAULT.
      { id: u1, email: 'sparse@example.com', passwordHash: 'scrypt$a$b', name: 'Sparse User',
        role: 'user', banned: false, joinedAt: 1793767580214, referralCode: 'BB-SPARSE', country: 'Nigeria' },
      // Dense: every modelled field present, including money as a raw double.
      { id: u2, email: 'dense@example.com', passwordHash: 'scrypt$c$d', name: 'Dense User',
        role: 'admin', banned: false, suspended: false, joinedAt: 1700000000000,
        lastLogin: 1700000001234, referralCode: 'BB-DENSE', referredBy: 'BB-SPARSE',
        country: 'United Kingdom', totpEnabled: true, xp: 1250, manualPnl: -37.5,
        badges: ['first_trade', 'referrer'], seeded: true, avatarColor: '#d3a877',
        dob: '1990-01-02', phone: '+447700900123', experience: 'expert',
        sourceOfFunds: 'savings', newsletter: true }
    ],
    settings: { siteName: 'Test Site', demoStartBalance: 10000, minDeposit: 50,
      depositAddresses: { BTC: 'bc1qtest', USDT: '' },
      announcements: ['one', 'two'],
      trading: { enabled: true, liveEnabled: false, maxLeverage: 5, maxOrderUsd: 100000 },
      smtp: { host: '', port: 587 }, email: { transport: 'smtp' } },
    sessions: [{ token: uid('s_'), userId: u1, createdAt: 1793767580214, expiresAt: 1794372380214 }],
    wallets: [
      { userId: u1, mode: 'demo', usd: 10000 },
      { userId: u1, mode: 'live', usd: 0, coins: { 'cg-bitcoin': 0.00129852, 'cg-ethereum': 0.04388623 } }
    ],
    ledger: [
      { id: uid('led_'), userId: u1, mode: 'demo', direction: 'credit', amount: 10000,
        type: 'opening_balance', referenceId: 'migration-v1', note: 'Opening balance',
        currency: 'USD', status: 'posted', createdAt: 1793767580214 },
      { id: uid('led_'), userId: u1, mode: 'live', direction: 'debit', amount: 2.79,
        type: 'trade_open', referenceId: '', note: '', createdAt: 1793767580999 }
    ],
    chats: [{ id: chatId, userId: u1, name: 'Sparse User', email: 'sparse@example.com',
              status: 'open', unreadAdmin: 0, lastMsgAt: 1793767581000, createdAt: 1793767580000 }],
    messages: [
      { id: uid('m_'), convId: chatId, from: 'user', text: 'Hello', at: 1793767581000 },
      { id: uid('m_'), convId: chatId, from: 'admin', text: 'Hi there', adminName: 'Platform',
        seen: true, at: 1793767582000 }
    ],
    copy_leaders: [{ id: leaderId, userId: u2, status: 'active', title: 'Test Leader',
      style: 'Systematic', bot: true, emoji: '🤖', minBalance: 2500, risk: 'Low',
      universe: ['cg-bitcoin', 'cg-ethereum'], params: { lev: 2, sizePct: 12, tpPct: 2.2 },
      seedFollowers: 1842, seeded: true, approvedAt: 1788582910459 }],
    copy_allocations: [{ id: uid('ca_'), userId: u1, leaderId, mode: 'demo',
      allocated: 500, equity: 487.25, active: true, startedAt: 1793767583000 }],
    // The precision-critical rows: raw JS doubles at 15-18 decimal places.
    trades: [
      { id: uid('t_'), userId: u1, mode: 'demo', assetId: 'cg-bitcoin', symbol: 'BTC', name: 'Bitcoin',
        side: 'buy', type: 'market', action: 'open', qty: 0.022517393297237343,
        price: 61913.78057434741, entry: 61913.78057434741, notional: 1394.14,
        fee: 2.788273895422868, margin: 1394.14, pnl: 0, leverage: 1, liquidated: false,
        at: 1790822590739.3328, seeded: true },
      { id: uid('t_'), userId: u1, mode: 'demo', assetId: 'cg-dogecoin', symbol: 'DOGE', name: 'Dogecoin',
        side: 'sell', type: 'market', action: 'close', qty: 4640.68591369, price: 0.073362,
        notional: 340.42, fee: 0.6808, pnl: 12.34, leverage: 3, liquidated: true,
        reason: 'liquidation', at: 1790849112913.0408 }
    ],
    transactions: [{ id: uid('tx_'), userId: u1, type: 'swap', mode: 'demo', asset: 'USD → BTC',
      fromAsset: 'usd', toAsset: 'cg-bitcoin', fromQty: 200, toQty: 0.00259703,
      amountUsd: 200, feeUsd: 1, status: 'completed', createdAt: 1793767584000,
      updatedAt: 1793767584100 }],
    positions: [{ id: uid('p_'), userId: u1, mode: 'demo', assetId: 'cg-dogecoin', symbol: 'DOGE',
      name: 'Dogecoin', side: 'sell', qty: 4640.68591369, entry: 0.073362, leverage: 3,
      margin: 113.48, fee: 0.34, tp: 0.071526, sl: 0.074303, openedAt: 1793767585000,
      status: 'open', orderType: 'market', ledgerDebitId: 'trade-open:p_x' }],
    kyc: [{ id: uid('kyc_'), userId: u1, status: 'approved', idType: 'passport',
      details: { fullName: 'Sparse User', idNumber: 'P1234567', address: '1 Test St', city: 'Lagos', country: 'Nigeria' },
      docs: [{ id: uid('d_'), kind: 'front', file: 'f.png', origName: 'id.png', mime: 'image/png', size: 2048 }],
      submittedAt: 1793767586000, reviewedAt: 1793767587000, reviewerId: u2, reason: '' }],
    audit: [{ id: uid('a_'), adminId: u2, action: 'user.delete', target: u1, detail: 'sparse@example.com', at: 1793767588000 }],
    logins: [{ id: uid('lg_'), userId: u1, at: 1793767589000, ip: '203.0.113.7', ua: 'node',
               deviceKey: 'abc123', newDevice: true }],
    alerts: [{ id: uid('al_'), userId: u1, assetId: 'cg-bitcoin', symbol: 'BTC', name: 'Bitcoin',
               dir: 'above', target: 100000, status: 'active', createdAt: 1793767590000,
               triggeredAt: 0, triggeredPrice: 0, seen: true }],
    leads: [{ id: uid('ld_'), email: 'lead@example.com', magnet: 'quickstart', source: 'homepage',
              ip: '203.0.113.7', ua: 'node', createdAt: 1793767591000 }],
    push_subs: [{ id: uid('ps_'), userId: u1, endpoint: 'https://push.example/sub1',
                  keys: { p256dh: 'BPabc', auth: 'auth1' }, createdAt: 1793767592000 }],
    emails: [{ id: uid('em_'), to: 'sparse@example.com', subject: 'Welcome', status: 'skipped',
               error: 'SMTP not configured', at: 1793767593000 }],
    resets: [{ token: uid('r_'), userId: u1, expiresAt: 1793771193000, used: false }],
    community_apps: [{ id: uid('cm_'), userId: u1, status: 'approved', experience: 'beginner',
      goals: 'learn', quizScore: 5, rulesAccepted: true, appliedAt: 1793767594000,
      reviewedAt: 1793767595000, reason: '' }],
    bot_requests: [{ id: uid('br_'), userId: u1, leaderId, status: 'approved', key: 'BB-TEST-KEY1',
      requestedAt: 1793767596000, reviewedAt: 1793767597000 }],
    orders: []
  };
}

(async () => {
  console.log('== postgres suite ==');
  console.log('   target database:', dbName);

  // ---- clean slate ----
  await Pg.migrate();
  await Pg.query(`TRUNCATE ${Pg.INSERT_ORDER.filter(c => c !== 'settings').map(c => Pg.TABLES[c].table).join(', ')} RESTART IDENTITY CASCADE`);
  await Pg.query('DELETE FROM settings');
  await Pg.query('DELETE FROM schema_migrations');
  ok('tables truncated to a clean slate', true);

  // ---- migrations ----
  const m1 = await Pg.migrate();
  ok('migrate() applies 001_schema on an empty catalog', m1.applied.includes('001_schema'), m1);
  const m2 = await Pg.migrate();
  ok('migrate() is idempotent (second run applies nothing)', m2.applied.length === 0 && m2.skipped.includes('001_schema'), m2);
  ok('no checksum drift reported', m2.drifted.length === 0, m2.drifted);

  // Drift detection: corrupt the recorded checksum and confirm it is reported
  // rather than silently ignored.
  await Pg.query(`UPDATE schema_migrations SET checksum = 'deadbeef' WHERE id = '001_schema'`);
  const m3 = await Pg.migrate();
  ok('editing an applied migration is reported as drift', m3.drifted.includes('001_schema'), m3.drifted);
  const real = require('crypto').createHash('sha256')
    .update(require('fs').readFileSync(path.join(Pg.MIGRATIONS_DIR, '001_schema.sql'), 'utf8')).digest('hex');
  await Pg.query('UPDATE schema_migrations SET checksum = $1 WHERE id = $2', [real, '001_schema']);

  // ---- schema surface ----
  const tbls = await Pg.query(`SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public'`);
  ok('23 collection tables + schema_migrations exist', tbls.rows[0].n === 24, tbls.rows[0].n);

  // ---- write the fixture ----
  const db = fixture();
  await Pg.tx(async client => {
    for (const coll of Pg.INSERT_ORDER) {
      const spec = Pg.TABLES[coll];
      const u = await Pg.upserter(coll, client);
      if (spec.singleton) { await client.query(u.sql, u.params(db[coll])); continue; }
      for (const row of (db[coll] || [])) await client.query(u.sql, u.params(row));
    }
  });
  ok('fixture written inside a single transaction', true);

  const counts = await Pg.counts();
  ok('users written', counts.users === 2, counts);
  ok('trades written', counts.trades === 2, counts);
  ok('ledger written', counts.ledger === 2, counts);
  ok('settings singleton written once', counts.settings === 1, counts);
  ok('every collection populated as expected',
    Pg.INSERT_ORDER.every(c => counts[c] === (Pg.TABLES[c].singleton ? 1 : (db[c] || []).length)), counts);

  // ---- the sparse-document case that originally failed ----
  const sparse = await Pg.query(`SELECT role, banned, suspended, totp_enabled, xp, manual_pnl
                                 FROM users WHERE email = 'sparse@example.com'`);
  const s = sparse.rows[0];
  ok('sparse doc: role defaulted', s.role === 'user', s.role);
  ok('sparse doc: suspended fell back to the column DEFAULT, not NULL', s.suspended === false, s.suspended);
  ok('sparse doc: totp_enabled defaulted false', s.totp_enabled === false, s.totp_enabled);
  ok('sparse doc: xp defaulted 0', String(s.xp) === '0', s.xp);
  ok('sparse doc: manual_pnl defaulted 0', Number(s.manual_pnl) === 0, s.manual_pnl);

  // ---- epoch-ms bigint binding (the COALESCE type-inference trap) ----
  const joined = await Pg.query(`SELECT joined_at FROM users WHERE email='sparse@example.com'`);
  ok('epoch-ms bigint survives the COALESCE cast (was "out of range for integer")',
    String(joined.rows[0].joined_at) === '1793767580214', joined.rows[0].joined_at);

  // ---- bit-exact double round-trip through NUMERIC ----
  const src = db.trades[0];
  const t = await Pg.query(`SELECT qty, price, fee, entry, at FROM trades WHERE id = $1`, [src.id]);
  ok('qty (18dp) round-trips bit-exactly through NUMERIC(38,18)', Number(t.rows[0].qty) === src.qty,
    { got: t.rows[0].qty, want: src.qty });
  ok('price (15dp) round-trips bit-exactly', Number(t.rows[0].price) === src.price, t.rows[0].price);
  ok('fee (16dp) round-trips bit-exactly', Number(t.rows[0].fee) === src.fee, t.rows[0].fee);
  ok('fractional timestamp round-trips through NUMERIC(24,4)', Number(t.rows[0].at) === src.at,
    { got: t.rows[0].at, want: src.at });
  ok('2dp money column stores exactly', Number((await Pg.query(`SELECT amount FROM ledger WHERE type='opening_balance'`)).rows[0].amount) === 10000);

  // ---- jsonb / arrays ----
  const w = await Pg.query(`SELECT coins FROM wallets WHERE mode='live'`);
  ok('jsonb object with dynamic asset keys round-trips',
    w.rows[0].coins && w.rows[0].coins['cg-bitcoin'] === 0.00129852, w.rows[0].coins);
  const cl = await Pg.query(`SELECT universe, params FROM copy_leaders LIMIT 1`);
  ok('text[] array round-trips', Array.isArray(cl.rows[0].universe) && cl.rows[0].universe.length === 2, cl.rows[0].universe);
  ok('jsonb params round-trips', cl.rows[0].params && cl.rows[0].params.lev === 2, cl.rows[0].params);

  // ---- generated columns (the trading kill switch, queryable in SQL) ----
  const gs = await Pg.query(`SELECT trading_enabled, live_enabled, max_leverage FROM settings`);
  ok('generated column: trading_enabled', gs.rows[0].trading_enabled === true, gs.rows[0]);
  ok('generated column: live_enabled reflects the kill switch', gs.rows[0].live_enabled === false, gs.rows[0]);
  ok('generated column: max_leverage', gs.rows[0].max_leverage === 5, gs.rows[0]);

  // ---- `from` -> sender rename ----
  const msg = await Pg.query(`SELECT sender FROM messages ORDER BY at LIMIT 1`);
  ok('messages.from is stored in the "sender" column', msg.rows[0].sender === 'user', msg.rows[0]);
  const msgDoc = await Pg.query(`SELECT doc->>'from' AS f FROM messages ORDER BY at LIMIT 1`);
  ok('the original "from" key is preserved in doc', msgDoc.rows[0].f === 'user', msgDoc.rows[0]);

  // ---- constraints actually bite ----
  const expectReject = async (label, sql, params) => {
    try { await Pg.query(sql, params); ok(label, false, 'statement unexpectedly succeeded'); }
    catch (e) { ok(label, true); }
  };
  const u1 = db.users[0].id;
  await expectReject('CHECK: wallet balance cannot go negative',
    `UPDATE wallets SET usd = -1 WHERE user_id = $1 AND mode = 'demo'`, [u1]);
  await expectReject('CHECK: ledger amount cannot be zero',
    `INSERT INTO ledger (id,doc,user_id,mode,direction,amount,type) VALUES ('x','{}',$1,'demo','credit',0,'t')`, [u1]);
  await expectReject('CHECK: ledger direction must be credit|debit',
    `INSERT INTO ledger (id,doc,user_id,mode,direction,amount,type) VALUES ('y','{}',$1,'demo','sideways',5,'t')`, [u1]);
  await expectReject('FK: a ledger row cannot reference a nonexistent user',
    `INSERT INTO ledger (id,doc,user_id,mode,direction,amount,type) VALUES ('z','{}','u_ghost','demo','credit',5,'t')`);
  await expectReject('UNIQUE: duplicate email is rejected',
    `INSERT INTO users (id,doc,email,password_hash) VALUES ('u_dup','{}','sparse@example.com','h')`);
  await expectReject('UNIQUE: settings cannot hold a second row',
    `INSERT INTO settings (id,doc) VALUES (2,'{}')`);

  // ---- the idempotency_key unique index (Phase 2 depends on it) ----
  await Pg.query(`UPDATE ledger SET idempotency_key='deposit:tx_1' WHERE type='opening_balance'`);
  await expectReject('UNIQUE: a duplicate idempotency_key is rejected (prevents double-credit)',
    `UPDATE ledger SET idempotency_key='deposit:tx_1' WHERE type='trade_open'`);
  await Pg.query(`UPDATE ledger SET idempotency_key=NULL`);
  ok('NULL idempotency keys do not collide (partial index)', true);

  // ---- deposit TXID cannot be credited twice ----
  const txId = db.transactions[0].id;
  await Pg.query(`UPDATE transactions SET type='deposit', txid='0xABC123' WHERE id=$1`, [txId]);
  await expectReject('UNIQUE: the same deposit TXID cannot be recorded twice',
    `INSERT INTO transactions (id,doc,user_id,type,status,amount_usd,txid,created_at)
     VALUES ('tx_dup','{}',$1,'deposit','pending',200,'0xabc123',0)`, [u1]);

  // ---- upsert semantics: re-running must update, not duplicate ----
  const before = await Pg.counts();
  await Pg.tx(async client => {
    for (const coll of Pg.INSERT_ORDER) {
      const u = await Pg.upserter(coll, client);
      if (Pg.TABLES[coll].singleton) { await client.query(u.sql, u.params(db[coll])); continue; }
      for (const row of (db[coll] || [])) await client.query(u.sql, u.params(row));
    }
  });
  const after = await Pg.counts();
  ok('re-running the backfill does not duplicate rows',
    JSON.stringify(before) === JSON.stringify(after), { before, after });

  // ---- an edited field is picked up by the upsert ----
  const edited = JSON.parse(JSON.stringify(db.users[1]));
  edited.name = 'Renamed User';
  const eu = await Pg.upserter('users');
  await Pg.query(eu.sql, eu.params(edited));
  const rn = await Pg.query(`SELECT name, doc->>'name' AS dn FROM users WHERE id=$1`, [edited.id]);
  ok('upsert updates the typed column', rn.rows[0].name === 'Renamed User', rn.rows[0]);
  ok('upsert updates doc too (they cannot drift)', rn.rows[0].dn === 'Renamed User', rn.rows[0]);
  db.users[1].name = 'Renamed User';

  // ---- FK cascade: deleting a user removes their money rows ----
  await Pg.query(`DELETE FROM users WHERE id = $1`, [u1]);
  const casc = await Pg.query(`SELECT
      (SELECT count(*) FROM wallets WHERE user_id=$1) w,
      (SELECT count(*) FROM ledger WHERE user_id=$1) l,
      (SELECT count(*) FROM trades WHERE user_id=$1) t,
      (SELECT count(*) FROM messages WHERE conv_id NOT IN (SELECT id FROM chats)) orphan_msgs`, [u1]);
  ok('ON DELETE CASCADE removed the user\'s wallets', String(casc.rows[0].w) === '0', casc.rows[0]);
  ok('ON DELETE CASCADE removed the user\'s ledger rows', String(casc.rows[0].l) === '0', casc.rows[0]);
  ok('ON DELETE CASCADE removed the user\'s trades', String(casc.rows[0].t) === '0', casc.rows[0]);
  ok('chat deletion cascaded to its messages (no orphans)', String(casc.rows[0].orphan_msgs) === '0', casc.rows[0]);

  // ---- parity, on a freshly re-migrated dataset ----
  await Pg.query(`TRUNCATE ${Pg.INSERT_ORDER.filter(c => c !== 'settings').map(c => Pg.TABLES[c].table).join(', ')} RESTART IDENTITY CASCADE`);
  await Pg.query('DELETE FROM settings');
  const db2 = fixture();
  await Pg.tx(async client => {
    for (const coll of Pg.INSERT_ORDER) {
      const u = await Pg.upserter(coll, client);
      if (Pg.TABLES[coll].singleton) { await client.query(u.sql, u.params(db2[coll])); continue; }
      for (const row of (db2[coll] || [])) await client.query(u.sql, u.params(row));
    }
  });
  const rep = await Parity.compareAll(db2);
  ok('parity: no rows missing in Postgres', rep.totals.missingInPg === 0, rep.totals);
  ok('parity: no extra rows in Postgres', rep.totals.extraInPg === 0, rep.totals);
  ok('parity: every doc matches byte-for-byte', rep.totals.mismatched === 0,
    rep.results.filter(r => r.mismatched.length).map(r => ({ c: r.collection, s: r.samples })));
  ok('parity: compareAll reports ok', rep.ok === true, rep.totals);

  // Parity must actually be able to FAIL, or it proves nothing.
  const tampered = JSON.parse(JSON.stringify(db2));
  tampered.users[0].country = 'Somewhere Else';
  tampered.trades[0].qty = 999;
  tampered.ledger.pop();
  const bad = await Parity.compareAll(tampered);
  ok('parity detects a changed field', bad.totals.mismatched >= 2, bad.totals);
  ok('parity detects a removed row', bad.totals.extraInPg >= 1, bad.totals);
  ok('parity reports ok=false on drift', bad.ok === false);
  const diffSample = bad.results.find(r => r.samples.length);
  ok('parity names the exact differing path',
    !!diffSample && !!diffSample.samples[0].diff && diffSample.samples[0].diff.path.length > 0,
    diffSample && diffSample.samples[0]);

  // ---- deepEqual edge cases ----
  ok('deepEqual: key order is irrelevant', Parity.deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
  ok('deepEqual: numeric string vs number matches', Parity.deepEqual({ a: 1.5 }, { a: '1.5' }));
  ok('deepEqual: different numbers do not match', !Parity.deepEqual({ a: 1.5 }, { a: 1.5000001 }));
  ok('deepEqual: absent vs undefined-valued key', !Parity.deepEqual({ a: 1 }, { a: 1, b: 2 }));
  ok('deepEqual: nested arrays', Parity.deepEqual({ a: [{ b: [1, 2] }] }, { a: [{ b: [1, 2] }] }));
  ok('deepEqual: nested array length differs', !Parity.deepEqual({ a: [1, 2] }, { a: [1, 2, 3] }));

  await Pg.close();
  console.log(`\n========== POSTGRES: ${pass} passed, ${fail} failed ==========`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(async e => {
  console.error('[pg-suite] FAILED:', e.message);
  if (e.detail) console.error('             detail:', e.detail);
  try { await Pg.close(); } catch (_) {}
  process.exit(1);
});
