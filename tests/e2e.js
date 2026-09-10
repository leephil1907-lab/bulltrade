'use strict';
const BASE = 'http://localhost:3000';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘ FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
}
async function req(method, path, body, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null };
}

const ADMIN_PW = process.env.ADMIN_PASSWORD;
if (!ADMIN_PW) { console.error('Set ADMIN_PASSWORD=<admin password> to run the e2e suite (the server must have been started with the same value, or use the password of the existing seeded admin).'); process.exit(1); }

(async () => {
  console.log('== PAGES ==');
  const pages = ['/', '/markets', '/trade', '/trading-bots', '/community', '/dashboard', '/funding', '/login', '/signup', '/forgot-password', '/reset-password', '/kyc', '/store', '/mentorship', '/cmf-engine', '/faq', '/contact', '/avoid-scams', '/legal?p=gdpr', '/admin', '/nonexistent-page-xyz'];
  for (const p of pages) {
    const res = await fetch(BASE + p);
    ok(`GET ${p} → ${p === '/nonexistent-page-xyz' ? 404 : 200}`, res.status === (p === '/nonexistent-page-xyz' ? 404 : 200), res.status);
  }
  // static assets
  for (const a of ['/assets/css/main.css', '/assets/css/fonts.css', '/assets/css/fontawesome.css', '/assets/css/admin.css', '/assets/js/common.js', '/assets/js/chart.js', '/assets/js/countries.js', '/assets/js/qrcode.js', '/assets/img/brand/logo.png', '/assets/img/brand/login-art.jpg', '/assets/img/app-icon.png', '/assets/img/chat-avatar.png', '/assets/img/coins/bitcoin.png', '/assets/img/stocks/AAPL.png', '/assets/fonts/quattrocentosans-400-normal-latin.woff2', '/assets/webfonts/fa-solid-900.woff2', '/favicon.ico', '/manifest.webmanifest', '/robots.txt']) {
    const res = await fetch(BASE + a);
    ok(`asset ${a}`, res.status === 200, res.status);
  }
  // secret not exposed
  ok('data/.jwt-secret NOT served', (await fetch(BASE + '/data/.jwt-secret')).status === 404 || (await fetch(BASE + '/../data/.jwt-secret')).status !== 200);

  console.log('== MARKETS ==');
  const mk = await req('GET', '/api/markets');
  ok('markets snapshot ok', mk.data.ok && Array.isArray(mk.data.assets));
  const withPrice = mk.data.assets.filter(a => a.price != null);
  ok(`prices loaded (${withPrice.length}/62 assets)`, withPrice.length >= 55, withPrice.length);
  // chart candles — crypto, stock and commodity (multi-source fallback chain)
  let cd;
  cd = await req('GET', '/api/markets/candles?asset=cg-bitcoin&range=1W');
  ok('candles: BTC 1W', cd.data.ok && cd.data.candles && cd.data.candles.length >= 5, cd.data.candles && cd.data.candles.length);
  cd = await req('GET', '/api/markets/candles?asset=yh-AAPL&range=1W');
  ok('candles: AAPL 1W', cd.data.ok && cd.data.candles && cd.data.candles.length >= 5, cd.data.candles && cd.data.candles.length);
  cd = await req('GET', '/api/markets/candles?asset=yh-XAU&range=1M');
  ok('candles: Gold 1M', cd.data.ok && cd.data.candles && cd.data.candles.length >= 5, cd.data.candles && cd.data.candles.length);
  const btc = mk.data.assets.find(a => a.symbol === 'BTC');
  ok('BTC price sane', btc && btc.price > 1000, btc && btc.price);
  const aapl = mk.data.assets.find(a => a.symbol === 'AAPL');
  ok('AAPL stock price sane', aapl && aapl.price > 50, aapl && aapl.price);
  const gold = mk.data.assets.find(a => a.symbol === 'XAU');
  ok('Gold (RWA) price sane', gold && gold.price > 500, gold && gold.price);
  const spx = mk.data.assets.find(a => a.symbol === 'SPX');
  ok('S&P 500 index price sane', spx && spx.price > 1000, spx && spx.price);
  ok('BTC has sparkline', btc && Array.isArray(btc.spark) && btc.spark.length > 5);
  const candles = await req('GET', '/api/markets/candles?asset=cg-bitcoin&range=1W');
  ok('BTC candles ok', candles.data.ok && candles.data.candles.length > 5, candles.data.candles && candles.data.candles.length);
  const candles2 = await req('GET', '/api/markets/candles?asset=yh-AAPL&range=1D');
  ok('AAPL candles ok', candles2.data.ok && candles2.data.candles.length > 5);

  console.log('== AUTH FLOW ==');
  const email = `tester${Date.now()}@example.com`;
  let r = await req('POST', '/api/auth/signup', { name: 'Test Trader', email, password: 'Trader1234!', agree: true, dob: '1995-05-10', country: 'Nigeria', phone: '+2348012345678', experience: 'some-experience', sourceOfFunds: 'employment', newsletter: true, referredBy: '' });
  ok('signup ok', r.data.ok && r.data.user && r.data.user.kycStatus === 'not_submitted', r.data);
  ok('signup returns JWT cookie', !!r.cookie && r.cookie.startsWith('bb_session='));
  let userCookie = r.cookie;
  r = await req('GET', '/api/auth/me', null, userCookie);
  ok('me returns user', r.data.ok && r.data.user && r.data.user.email === email);
  ok('demo wallet funded $10k', r.data.demo && r.data.demo.free === 10000, r.data.demo);
  // dup signup
  r = await req('POST', '/api/auth/signup', { name: 'x', email, password: 'Trader1234!', agree: true });
  ok('duplicate signup rejected', r.status === 409);
  // bad password
  r = await req('POST', '/api/auth/signup', { name: 'y', email: `z${Date.now()}@x.com`, password: 'short', agree: true });
  ok('weak password rejected', r.status === 400);
  // logout & login
  r = await req('POST', '/api/auth/logout', {}, userCookie);
  ok('logout ok', r.data.ok);
  r = await req('GET', '/api/auth/me', null, userCookie);
  ok('session revoked after logout', r.data.user === null);
  r = await req('POST', '/api/auth/login', { email, password: 'wrong' });
  ok('wrong password rejected', r.status === 401);
  r = await req('POST', '/api/auth/login', { email, password: 'Trader1234!' });
  ok('login ok', r.data.ok && r.data.user.email === email);
  userCookie = r.cookie;
  // forgot/reset
  r = await req('POST', '/api/auth/forgot', { email });
  ok('forgot returns reset url', r.data.ok && r.data.resetUrl && r.data.resetUrl.startsWith('/reset-password?token='));
  const token = new URL('http://x' + r.data.resetUrl).searchParams.get('token');
  r = await req('POST', '/api/auth/reset', { token, password: 'NewPass1234!' });
  ok('reset ok', r.data.ok);
  r = await req('POST', '/api/auth/login', { email, password: 'NewPass1234!' });
  ok('login with new password', r.data.ok);
  userCookie = r.cookie;
  r = await req('POST', '/api/auth/reset', { token, password: 'Another123!' });
  ok('reset token single-use', r.status === 400);

  console.log('== TRADING (DEMO) ==');
  r = await req('GET', '/api/trading/state', null, userCookie);
  ok('state demo default', r.data.ok && r.data.mode === 'demo' && r.data.equity.free === 10000);
  // live blocked without KYC
  r = await req('POST', '/api/trading/order', { assetId: 'cg-bitcoin', side: 'buy', type: 'market', mode: 'live', notional: 100, leverage: 2 }, userCookie);
  ok('live order blocked without KYC', r.status === 403);
  // demo market buy
  r = await req('POST', '/api/trading/order', { assetId: 'cg-bitcoin', side: 'buy', type: 'market', mode: 'demo', notional: 1000, leverage: 5 }, userCookie);
  ok('demo market buy ok', r.data.ok && r.data.position && r.data.position.side === 'buy', r.data);
  const posId = r.data.position && r.data.position.id;
  // insufficient funds
  r = await req('POST', '/api/trading/order', { assetId: 'cg-ethereum', side: 'buy', type: 'market', mode: 'demo', notional: 999999, leverage: 1 }, userCookie);
  ok('insufficient funds rejected', r.status === 400);
  // min size
  r = await req('POST', '/api/trading/order', { assetId: 'cg-solana', side: 'buy', type: 'market', mode: 'demo', notional: 5, leverage: 1 }, userCookie);
  ok('min size enforced ($10)', r.status === 400);
  // limit order
  r = await req('POST', '/api/trading/order', { assetId: 'cg-ethereum', side: 'buy', type: 'limit', mode: 'demo', notional: 200, leverage: 2, limitPrice: 1 }, userCookie);
  ok('limit order placed', r.data.ok && r.data.order && r.data.order.status === 'open', r.data);
  const orderId = r.data.order && r.data.order.id;
  r = await req('GET', '/api/trading/state', null, userCookie);
  ok('state shows 1 position + 1 order', (r.data.positions||[]).length === 1 && (r.data.orders||[]).length === 1, { p: r.data.positions && r.data.positions.length, o: r.data.orders && r.data.orders.length });
  ok('position pnl computes', typeof r.data.positions[0].pnl === 'number' && typeof r.data.positions[0].liquidationPrice === 'number');
  // cancel order
  r = await req('POST', '/api/trading/cancel', { orderId }, userCookie);
  ok('cancel order ok', r.data.ok);
  // close position
  r = await req('POST', '/api/trading/close', { positionId: posId }, userCookie);
  ok('close position ok', r.data.ok && typeof r.data.pnl === 'number', r.data);
  
  // sell/short works
  r = await req('POST', '/api/trading/order', { assetId: 'yh-AAPL', side: 'sell', type: 'market', mode: 'demo', notional: 300, leverage: 3 }, userCookie);
  ok('stock short ok', r.data.ok, r.data);
  const shortId = r.data.position.id;
  r = await req('POST', '/api/trading/close', { positionId: shortId }, userCookie);
  ok('close short ok', r.data.ok);
  r = await req('POST', '/api/trading/reset-demo', {}, userCookie);
  ok('demo reset restores $10k', r.data.ok);
  r = await req('GET', '/api/trading/state', null, userCookie);
  ok('state clean after reset', r.data.positions.length === 0 && r.data.equity.free === 10000);

  console.log('== COMMUNITY GATE ==');
  r = await req('GET', '/api/community/status', null, userCookie);
  ok('community status none', r.data.ok && r.data.status === 'none');
  r = await req('POST', '/api/community/apply', { experience: 'beginner', goals: 'learn charts', quizScore: 2, rulesAccepted: true });
  ok('apply requires auth', r.status === 401);
  r = await req('POST', '/api/community/apply', { experience: 'beginner', goals: 'learn', quizScore: 2, rulesAccepted: true }, userCookie);
  ok('low quiz score rejected', r.status === 400);
  r = await req('POST', '/api/community/apply', { experience: 'beginner', goals: 'learn charts and risk', quizScore: 5, rulesAccepted: true }, userCookie);
  ok('application submitted → pending', r.data.ok);
  r = await req('POST', '/api/community/apply', { experience: 'x', goals: 'y', quizScore: 5, rulesAccepted: true }, userCookie);
  ok('duplicate application blocked', r.status === 409);
  r = await req('GET', '/api/community/status', null, userCookie);
  ok('status pending', r.data.status === 'pending');

  console.log('== TRADING BOTS ==');
  r = await req('GET', '/api/copy/leaders');
  ok('bots listed publicly', r.data.ok && r.data.leaders.length >= 4 && r.data.leaders.every(l => l.bot && l.minBalance > 0), r.data.leaders.length);
  const bot = r.data.leaders[0]; // sorted ascending by minBalance
  ok('bot has stats + risk + min balance', bot.stats.demo.trades > 0 && !!bot.risk && bot.minBalance === 2500, { risk: bot.risk, min: bot.minBalance });
  ok('bots sorted by min balance', bot.minBalance <= r.data.leaders[r.data.leaders.length - 1].minBalance);
  r = await req('GET', '/api/bots/activity');
  ok('bot activity feed live', r.data.ok && r.data.activity.length >= 10 && r.data.activity[0].symbol && r.data.activity[0].botName, r.data.activity.length);
  r = await req('POST', '/api/bots/request-key', { botId: bot.id });
  ok('key request requires login', r.status === 401);
  r = await req('POST', '/api/bots/request-key', { botId: bot.id }, userCookie);
  ok('key request blocked below min balance', r.status === 400 && /minimum/.test(r.data.error || ''), r.data.error);
  r = await req('POST', '/api/bots/activate', { botId: bot.id, key: 'BB-WRNG', mode: 'demo', amount: 500 }, userCookie);
  ok('activation blocked without approved key', r.status === 400);
  const redir = await fetch(BASE + '/copy-trading', { redirect: 'manual' });
  ok('legacy /copy-trading redirects', redir.status === 302 && redir.headers.get('location') === '/trading-bots', redir.status);

  console.log('== SWAP ==');
  r = await req('GET', '/api/swap/assets');
  ok('swap assets list (USD + coins)', r.data.assets.length > 10 && r.data.assets[0].id === 'usd', r.data.assets.length);
  r = await req('GET', '/api/swap/quote?from=usd&to=cg-bitcoin&amount=200');
  ok('swap quote USD→BTC (0.5% fee)', r.data.ok && r.data.receiveQty > 0 && r.data.feeUsd === 1, { recv: r.data.receiveQty, fee: r.data.feeUsd });
  r = await req('POST', '/api/swap/execute', { from: 'usd', to: 'cg-bitcoin', amount: 200, mode: 'demo' }, userCookie);
  ok('swap executed USD→BTC', r.data.ok && r.data.balances.coins['cg-bitcoin'] > 0, r.data.balances);
  const btcQty = r.data.balances.coins['cg-bitcoin'];
  r = await req('POST', '/api/swap/execute', { from: 'usd', to: 'cg-bitcoin', amount: 9999999, mode: 'demo' }, userCookie);
  ok('insufficient balance blocked', r.status === 400);
  r = await req('POST', '/api/swap/execute', { from: 'cg-bitcoin', to: 'cg-ethereum', amount: btcQty / 2, mode: 'demo' }, userCookie);
  ok('coin→coin swap works', r.data.ok && r.data.balances.coins['cg-ethereum'] > 0 && r.data.balances.coins['cg-bitcoin'] < btcQty, r.data.balances);
  r = await req('POST', '/api/swap/execute', { from: 'usd', to: 'usd', amount: 10, mode: 'demo' }, userCookie);
  ok('same-coin swap blocked', r.status === 400);
  r = await req('GET', '/api/trading/state?mode=demo', null, userCookie);
  ok('equity includes spot coin holdings', r.data.equity.spot > 0 && r.data.equity.coins['cg-ethereum'] > 0, { spot: r.data.equity.spot });

  console.log('== FUNDING ==');
  r = await req('GET', '/api/funding/summary', null, userCookie);
  ok('funding summary', r.data.ok && r.data.addresses && r.data.addresses.BTC && r.data.kycStatus === 'not_submitted');
  r = await req('POST', '/api/funding/deposit', { asset: 'BTC', amountUsd: 100, txid: 'short' }, userCookie);
  ok('deposit needs txid', r.status === 400);
  r = await req('POST', '/api/funding/deposit', { asset: 'BTC', amountUsd: 100, txid: '0xlongenough123456' }, userCookie);
  ok('deposit requires proof upload', r.status === 400, r.data);
  r = await req('POST', '/api/funding/deposit', { asset: 'BTC', amountUsd: 100, txid: '0xlongenough123456', proof: { mime: 'text/html', name: 'x.html', data: 'PGh0bWw+' } }, userCookie);
  ok('deposit rejects bad proof type', r.status === 400);
  const PROOF_PNG = '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';
  r = await req('POST', '/api/funding/deposit', { asset: 'BTC', amountUsd: 100, txid: '0x1234567890abcdef1234567890abcdef12345678', proof: { mime: 'image/png', name: 'payment-proof.png', data: PROOF_PNG } }, userCookie);
  ok('deposit w/ proof submitted → pending', r.data.ok, r.data);
  // withdraw blocked without kyc
  r = await req('POST', '/api/funding/withdraw', { asset: 'USDT', amountUsd: 50, address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' }, userCookie);
  ok('withdraw blocked without KYC', r.status === 403);
  r = await req('POST', '/api/funding/demo-topup', {}, userCookie);
  ok('demo topup full-or-topped', r.status === 200 || r.status === 400, r.data);

  console.log('== STORE (crypto product checkout) ==');
  r = await req('GET', '/api/store/purchases', null, userCookie);
  ok('store purchases list', r.data.ok && Array.isArray(r.data.purchases));
  r = await req('GET', '/api/store/payment-wallets', null, userCookie);
  ok('product wallets = USDT-ERC20 only', r.data.ok && !!r.data.wallets['USDT-ERC20'] && !r.data.wallets.BTC && !r.data.wallets.SOL && !r.data.wallets.ETH, r.data.wallets);
  r = await req('POST', '/api/store/purchase', { productId: 'cheat', asset: 'USDT-ERC20', txid: 'short' }, userCookie);
  ok('product purchase needs txid', r.status === 400);
  r = await req('POST', '/api/store/purchase', { productId: 'does-not-exist', asset: 'USDT-ERC20', txid: '0xlongenough123456', proof: { mime: 'image/png', name: 'p.png', data: PROOF_PNG } }, userCookie);
  ok('unknown product rejected', r.status === 400);
  r = await req('POST', '/api/store/purchase', { productId: 'cheat', asset: 'FAKECOIN', txid: '0xlongenough123456', proof: { mime: 'image/png', name: 'p.png', data: PROOF_PNG } }, userCookie);
  ok('invalid payment coin rejected', r.status === 400);
  r = await req('POST', '/api/store/purchase', { productId: 'cheat', asset: 'SOL', txid: '0xlongenough123456', proof: { mime: 'image/png', name: 'p.png', data: PROOF_PNG } }, userCookie);
  ok('deposit-only coin rejected for products', r.status === 400);
  r = await req('POST', '/api/store/purchase', { productId: 'cheat', asset: 'BTC', txid: '0xlongenough123456', proof: { mime: 'image/png', name: 'p.png', data: PROOF_PNG } }, userCookie);
  ok('BTC rejected for products (USDT only)', r.status === 400);
  r = await req('POST', '/api/store/purchase', { productId: 'cheat', asset: 'USDT-ERC20', txid: '0xlongenough123456' }, userCookie);
  ok('product purchase requires proof', r.status === 400);
  r = await req('POST', '/api/store/purchase', { productId: 'cheat', asset: 'USDT-ERC20', txid: '0xpurchase1234567890abcdef', proof: { mime: 'image/png', name: 'payment.png', data: PROOF_PNG } }, userCookie);
  ok('product purchase submitted → pending', r.data.ok, r.data);
  r = await req('POST', '/api/store/purchase', { productId: 'cheat', asset: 'USDT-ERC20', txid: '0xpurchase1234567890abcdef', proof: { mime: 'image/png', name: 'payment.png', data: PROOF_PNG } }, userCookie);
  ok('duplicate purchase blocked', r.status === 400);

  console.log('== KYC ==');
  const png1x1 = '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';
  r = await req('POST', '/api/kyc/submit', { idType: 'passport', docs: [{ kind: 'front', mime: 'image/png', name: 'id.png', data: png1x1 }, { kind: 'selfie', mime: 'image/png', name: 'selfie.png', data: png1x1 }] }, userCookie);
  ok('kyc submitted → pending', r.data.ok, r.data);
  r = await req('GET', '/api/kyc/status', null, userCookie);
  ok('kyc status pending', r.data.kyc && r.data.kyc.status === 'pending');
  r = await req('POST', '/api/kyc/submit', { idType: 'passport', docs: [{ kind: 'front', mime: 'image/png', name: 'id.png', data: png1x1 }] }, userCookie);
  ok('kyc duplicate blocked while pending', r.status === 409);
  // bad mime on a FRESH user (this user is already pending → 409 guard fires first)
  const mEmail = `mime${Date.now()}@example.com`;
  let mr = await req('POST', '/api/auth/signup', { name: 'Mime Test', email: mEmail, password: 'Trader1234!', agree: true });
  mr = await req('POST', '/api/kyc/submit', { idType: 'passport', docs: [{ kind: 'front', mime: 'text/html', name: 'x.html', data: 'PGh0bWw+ PGh0bWw+PGh0bWw+' }, { kind: 'selfie', mime: 'text/html', name: 'y.html', data: 'PGh0bWw+PGh0bWw+' }] }, mr.cookie);
  ok('kyc bad mime rejected', mr.status === 400, mr.data);

  console.log('== CHAT ==');
  r = await req('POST', '/api/chat/init', {}, userCookie);
  ok('chat init', r.data.ok && r.data.convId);
  const convId = r.data.convId;
  r = await req('POST', '/api/chat/send', { text: 'Hello, how does the CMF engine work?' }, userCookie);
  ok('chat send ok', r.data.ok);
  await new Promise(res => setTimeout(res, 1200));
  r = await req('GET', `/api/chat/messages?after=0`, null, userCookie);
  ok('chat has messages incl bot ack', r.data.messages.length >= 2, r.data.messages.length);

  console.log('== ADMIN ==');
  r = await req('GET', '/api/admin/overview');
  ok('admin overview blocked', r.status === 401 || r.status === 403);
  r = await req('POST', '/api/auth/login', { email: (process.env.ADMIN_EMAIL || 'admin@blockchainbullhorn.com'), password: ADMIN_PW });
  ok('admin login', r.data.ok && r.data.user.role === 'admin');
  const adminCookie = r.cookie;

  // -- product purchase admin verification (from STORE section above) --
  r = await req('GET', '/api/admin/transactions', null, adminCookie);
  const ptx = r.data.transactions.find(t => t.type === 'product' && t.status === 'pending');
  ok('product payment visible to admin w/ proof + product name', !!ptx && ptx.productId === 'cheat' && !!ptx.proof && ptx.productName.includes('Cheat Guide') && ptx.asset === 'USDT-ERC20');
  r = await req('GET', '/api/admin/proof?id=' + ptx.id, null, adminCookie);
  ok('admin can open product payment proof', r.status === 200);
  r = await req('POST', '/api/admin/tx', { txId: ptx.id, action: 'approve' }, adminCookie);
  ok('product purchase approved & unlocked', r.data.ok);
  r = await req('GET', '/api/store/purchases', null, userCookie);
  ok('purchase completed in user list', r.data.purchases.some(p => p.productId === 'cheat' && p.status === 'completed'));
  r = await req('GET', '/api/admin/overview', null, adminCookie);
  ok('overview stats', r.data.ok && r.data.stats.totalUsers >= 5 && r.data.stats.kycPending === 1, r.data.stats);
  // find our test user
  r = await req('GET', `/api/admin/users?q=${email}`, null, adminCookie);
  ok('user search finds test user', r.data.ok && r.data.users.length === 1);
  const userId = r.data.users[0].id;
  r = await req('GET', `/api/admin/user?id=${userId}`, null, adminCookie);
  ok('user detail with kyc docs', r.data.ok && r.data.kyc && r.data.kyc.docs.length === 2, r.data.kyc);
  const docId = r.data.kyc.docs[0].id;
  const fileRes = await fetch(`${BASE}/api/admin/kyc-file?id=${docId}`, { headers: { Cookie: adminCookie } });
  ok('kyc file served to admin', fileRes.status === 200);
  const fileRes2 = await fetch(`${BASE}/api/admin/kyc-file?id=${docId}`, { headers: { Cookie: userCookie } });
  ok('kyc file BLOCKED for non-admin', fileRes2.status === 403);
  // approve kyc
  r = await req('POST', '/api/admin/kyc', { userId, action: 'approve' }, adminCookie);
  ok('kyc approved', r.data.ok);
  r = await req('GET', '/api/kyc/status', null, userCookie);
  ok('user sees kyc approved', r.data.kyc.status === 'approved');
  // approve deposit
  r = await req('GET', '/api/admin/transactions', null, adminCookie);
  ok('tx list has pending deposit', r.data.ok && r.data.transactions.some(t => t.status === 'pending' && t.type === 'deposit'));
  const tx = r.data.transactions.find(t => t.status === 'pending' && t.type === 'deposit' && t.userId === userId);
  r = await req('POST', '/api/admin/tx', { txId: tx.id, action: 'approve' }, adminCookie);
  ok('deposit approved', r.data.ok);
  r = await req('GET', '/api/funding/summary', null, userCookie);
  ok('live wallet credited $100', r.data.live.free === 100, r.data.live.free);
  // withdraw now allowed
  r = await req('POST', '/api/funding/withdraw', { asset: 'USDT', amountUsd: 60, address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' }, userCookie);
  ok('withdraw accepted after KYC', r.data.ok, r.data);
  r = await req('GET', '/api/funding/summary', null, userCookie);
  ok('live wallet 40 after withdraw hold', r.data.live.free === 40, r.data.live.free);
  // reject the withdrawal
  r = await req('GET', '/api/admin/transactions', null, adminCookie);
  const wd = r.data.transactions.find(t => t.status === 'pending' && t.type === 'withdraw');
  r = await req('POST', '/api/admin/tx', { txId: wd.id, action: 'reject', note: 'test refund' }, adminCookie);
  ok('withdrawal rejected + refunded', r.data.ok);
  r = await req('GET', '/api/funding/summary', null, userCookie);
  ok('live wallet back to 100', r.data.live.free === 100, r.data.live.free);
  // live trade now allowed
  r = await req('POST', '/api/trading/order', { assetId: 'cg-bitcoin', side: 'buy', type: 'market', mode: 'live', notional: 50, leverage: 1 }, userCookie);
  ok('live order allowed after KYC', r.data.ok, r.data);
  // community approve
  r = await req('GET', '/api/admin/community-apps', null, adminCookie);
  const app = r.data.apps.find(a => a.userId === userId);
  ok('community app found', !!app);
  r = await req('POST', '/api/admin/community-app', { appId: app.id, action: 'approve' }, adminCookie);
  ok('community approved', r.data.ok);
  r = await req('GET', '/api/community/status', null, userCookie);
  ok('user sees community approved', r.data.status === 'approved');
  // trading bot connection-key flow (admin approval required)
  r = await req('POST', '/api/admin/balance', { userId, mode: 'live', amountUsd: 3000, note: 'bot min balance' }, adminCookie);
  ok('live balance credited for bot test', r.data.ok);
  r = await req('POST', '/api/bots/request-key', { botId: bot.id }, userCookie);
  ok('connection key requested', r.data.ok, r.data);
  r = await req('POST', '/api/bots/request-key', { botId: bot.id }, userCookie);
  ok('duplicate key request blocked', r.status === 409);
  r = await req('GET', '/api/admin/copy', null, adminCookie);
  const pendReq = (r.data.requests || []).find(x => x.status === 'pending');
  ok('pending key request visible in admin', !!pendReq && pendReq.botMin === 2500, pendReq);
  r = await req('POST', '/api/admin/bot-key', { requestId: pendReq.id, action: 'approve' }, adminCookie);
  ok('connection key issued', r.data.ok && /^BB-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.data.key || ''), r.data.key);
  const connKey = r.data.key;
  r = await req('POST', '/api/bots/activate', { botId: bot.id, key: 'BB-WRONG', mode: 'demo', amount: 500 }, userCookie);
  ok('wrong connection key rejected', r.status === 400);
  r = await req('GET', '/api/copy/leaders', null, userCookie);
  ok('leaders endpoint exposes my approved key', r.data.myRequests && r.data.myRequests.some(q => q.leaderId === bot.id && q.key === connKey));
  r = await req('POST', '/api/bots/activate', { botId: bot.id, key: connKey, mode: 'demo', amount: 500 }, userCookie);
  ok('bot activated (demo $500)', r.data.ok, r.data);
  const allocId = r.data.allocation && r.data.allocation.id;
  r = await req('POST', '/api/copy/start', { leaderId: bot.id, mode: 'demo', amount: 100 }, userCookie);
  ok('second allocation for same bot blocked', r.status === 409);
  r = await req('GET', '/api/copy/my', null, userCookie);
  ok('my bots shows 1 allocation', r.data.ok && r.data.allocations.length === 1 && r.data.allocations[0].total >= 450 && r.data.allocations[0].total <= 540, r.data.allocations[0] && r.data.allocations[0].total); // upper bound loose: live bot mirrors can add P/L mid-test
  r = await req('POST', '/api/copy/stop', { allocationId: allocId }, userCookie);
  ok('bot stopped, funds returned', r.data.ok && r.data.returned >= 450 && r.data.returned <= 540, r.data);
  // balance adjust
  r = await req('POST', '/api/admin/balance', { userId, mode: 'live', amountUsd: 250, note: 'promo credit' }, adminCookie);
  ok('balance adjusted +250', r.data.ok && r.data.newBalance > 100, r.data);
  // user ban
  r = await req('POST', '/api/admin/user-action', { userId, action: 'ban' }, adminCookie);
  ok('user banned', r.data.ok);
  r = await req('GET', '/api/auth/me', null, userCookie);
  ok('banned user session dead', r.data.user === null);
  r = await req('POST', '/api/admin/user-action', { userId, action: 'unban' }, adminCookie);
  ok('user unbanned', r.data.ok);
  // audit
  r = await req('GET', '/api/admin/audit', null, adminCookie);
  ok('audit log records actions', r.data.ok && r.data.audit.length >= 5, r.data.audit.length);
  // settings
  r = await req('POST', '/api/admin/settings', { settings: { siteName: 'Blockchain Bullhorn' } }, adminCookie);
  ok('settings saved', r.data.ok);
  r = await req('GET', '/api/settings/public');
  ok('public settings: smartsupp present', typeof r.data.smartsuppKey === 'string' && Array.isArray(r.data.announcements));
  // announcement live feed
  r = await req('POST', '/api/admin/settings', { settings: { announcements: ['Welcome to Blockchain Bullhorn!', 'Golden Horn bot is on a winning streak', 'New: instant coin swaps live on the trading page'] } }, adminCookie);
  ok('3 announcements posted', r.data.ok);
  r = await req('GET', '/api/settings/public');
  ok('announcement feed public (3 items cycling)', r.data.announcements.length === 3 && r.data.announcements[0] === 'Welcome to Blockchain Bullhorn!', r.data.announcements);
  const tradeHtml = await (await fetch(BASE + '/trade')).text();
  ok('swap button present on trading session', tradeHtml.includes('swapBtn'));
  ok('TradingView embed uses live s3 host', tradeHtml.includes('s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js') && !tradeHtml.includes('src=\'https://s.tradingview.com'));
  const mktHtml = await (await fetch(BASE + '/markets')).text();
  ok('markets: bubbles view + coin view present', mktHtml.includes('id="bubblesCv"') && mktHtml.includes('coinView') && mktHtml.includes('viewSeg'));
  ok('markets: pulse strip + timeframe chips', mktHtml.includes('pulseStrip') && mktHtml.includes('data-tf="7D"') && mktHtml.includes('data-size="cap"'));
  ok('markets: candle chart lib included', mktHtml.includes('/assets/js/chart.js'));
  const cjs = await (await fetch(BASE + '/assets/js/common.js?v=11')).text();
  ok('announcement ticker engine served', cjs.includes('renderAnnouncement') && cjs.includes('fx-roll'));
  ok('live-chat open helper served', cjs.includes('openChat()') && cjs.includes("closest('[data-open-chat]')"));
  const idxHtml = await (await fetch(BASE + '/')).text();
  ok('homepage Elite Mentorship CTA opens live chat', idxHtml.includes('data-open-chat>Elite Mentorship'));
  const storeHtml = await (await fetch(BASE + '/store')).text();
  ok('store mentorship CTA opens live chat', storeHtml.includes('data-open-chat><i class="fas fa-crown"></i> Apply for Mentorship'));
  // admin chat reply
  r = await req('GET', `/api/admin/chat-messages?id=${convId}`, null, adminCookie);
  ok('admin reads chat', r.data.ok && r.data.messages.length >= 2);
  r = await req('POST', '/api/admin/chat-reply', { convId, text: 'Thanks for reaching out! The CMF engine is explained on the CMF page.' }, adminCookie);
  ok('admin reply sent', r.data.ok);
  r = await req('GET', `/api/chat/messages?after=0`, null, userCookie);
  ok('user receives admin reply', r.data.messages.some(m => m.from === 'admin'));

  console.log(`\n========== RESULT: ${pass} passed, ${fail} failed ==========`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(1); });
