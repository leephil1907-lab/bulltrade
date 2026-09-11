'use strict';
/**
 * Blockchain Bullhorn — full-stack server (zero dependencies).
 * Static site + JSON API + live market data + trading engine + admin backend.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const U = require('./lib/utils');
const D = require('./lib/db');
const Auth = require('./lib/auth');
const jwt = require('./lib/jwt');
const totp = require('./lib/totp');
const mailer = require('./lib/mailer');
const gamify = require('./lib/gamify');
const markets = require('./lib/markets');
const trading = require('./lib/trading');
const Backup = require('./lib/backup');
const bots = require('./lib/bots');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// NOTE: no top-level D.load() here — the async boot below calls D.init(),
// which restores the GitHub backup first when running on an ephemeral host.
markets.onTick(trading.tick);

// ---------------- helpers ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf'
};

function json(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}
const ok = (res, obj, headers) => json(res, 200, Object.assign({ ok: true }, obj), headers);
const fail = (res, code, error, extra) => json(res, code, Object.assign({ ok: false, error }, extra || {}));

function serveFile(res, filePath, code = 200) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return fail(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const cache = ['.woff2', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.svg'].includes(ext) ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(code, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}

function page(name) { return path.join(PUBLIC_DIR, name); }

const ROUTES = {
  '/': 'index.html', '/index.html': 'index.html', '/home': 'index.html',
  '/markets': 'markets.html', '/trade': 'trade.html', '/dashboard': 'dashboard.html',
  '/funding': 'funding.html', '/login': 'login.html', '/signup': 'signup.html',
  '/forgot-password': 'forgot-password.html', '/reset-password': 'reset-password.html',
  '/kyc': 'kyc.html', '/community': 'community.html', '/store': 'store.html',
  '/mentorship': 'mentorship.html', '/cmf-engine': 'cmf-engine.html', '/faq': 'faq.html',
  '/contact': 'contact.html', '/avoid-scams': 'avoid-scams.html', '/legal': 'legal.html',
  '/trading-bots': 'trading-bots.html',
  '/relay-setup': 'relay-setup.html', // public helper: copy the email-relay Apps Script code
  '/admin': 'admin.html', '/admin/': 'admin.html'
};

// ---------------- API handlers ----------------
const api = {};

function requireUser(req, res, cookies, optional) {
  const user = Auth.userFromRequest(req, cookies);
  if (!user) { if (!optional) fail(res, 401, 'Please log in to continue.'); return null; }
  return user;
}
function requireAdmin(req, res, cookies) {
  const user = Auth.userFromRequest(req, cookies);
  if (!user || user.role !== 'admin') { fail(res, 403, 'Admin access required.'); return null; }
  return user;
}

// ---- auth ----
api['POST /api/auth/signup'] = async (req, res, body, cookies) => {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!U.isEmail(email)) return fail(res, 400, 'Please enter a valid email address.');
  if (U.pwStrength(password) < 3) return fail(res, 400, 'Password must be at least 8 characters and include letters and numbers.');
  if (!body.agree) return fail(res, 400, 'You must accept the Terms & Risk Disclosure.');
  const result = Auth.registerUser({
    email, password, name: body.name, dob: body.dob, country: body.country, phone: body.phone,
    experience: body.experience, sourceOfFunds: body.sourceOfFunds, referredBy: body.referredBy, newsletter: body.newsletter
  });
  if (result.error) return fail(res, 409, result.error);
  // reward the referrer when a valid referral code was used
  if (body.referredBy) {
    const code = String(body.referredBy).trim().toUpperCase();
    const ref = D.find('users', u => u.referralCode === code && u.id !== result.user.id);
    if (ref) {
      gamify.addXP(ref.id, 100, 'referral');
      if (D.filter('users', x => String(x.referredBy || '').toUpperCase() === code).length >= 3) {
        gamify.grantBadge(ref.id, 'referrer');
      }
    }
  }
  const t = Auth.createSession(result.user.id);
  // welcome email — fire-and-forget; reserved test domains are never emailed
  if (!/@(example\.com|x\.com|t\.com)$/.test(email)) {
    mailer.sendMail({ to: email, subject: '🐂 Welcome to Blockchain Bullhorn — your account is ready', html: mailer.templates.welcome(result.user) }).catch(() => {});
  }
  const kycDocs = Array.isArray(body.kycDocs) ? body.kycDocs : null;
  let kycStatus = 'not_submitted';
  if (kycDocs && kycDocs.length) {
    const { submitKyc } = require('./lib/kyc');
    const r = submitKyc(result.user, body.idType || 'passport', kycDocs, body.kycDetails || {});
    kycStatus = r.ok ? 'pending' : 'not_submitted';
  }
  ok(res, { user: Object.assign(Auth.publicUser(result.user), { kycStatus }), token: t },
    { 'Set-Cookie': U.cookieStr(Auth.SESSION_COOKIE, t, { maxAge: 7 * 24 * 3600 }) });
};

api['POST /api/auth/login'] = async (req, res, body, cookies) => {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const key = email + '|' + (req.socket.remoteAddress || '');
  if (!Auth.checkRate(key)) return fail(res, 429, 'Too many failed attempts. Please wait 15 minutes and try again.');
  const user = D.find('users', u => u.email === email);
  if (!user || !U.verifyPassword(password, user.passwordHash)) {
    Auth.failRate(key);
    return fail(res, 401, 'Incorrect email or password.');
  }
  if (user.banned) return fail(res, 403, 'This account has been suspended. Contact support.');
  if (user.totpEnabled && user.totpSecret) {
    const challenge = jwt.sign({ uid: user.id, typ: '2fa' }, 600);
    const em = user.email.replace(/^(.).*(@.*)$/, '$1•••$2');
    return ok(res, { totpRequired: true, challenge, email: em });
  }
  Auth.okRate(key);
  completeLogin(req, res, user);
};

/** shared login completion: session cookie + login history + new-device email */
function completeLogin(req, res, user) {
  user.lastLogin = Date.now();
  try {
    const ua = String(req.headers['user-agent'] || 'Unknown device').slice(0, 200);
    const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').slice(0, 60);
    const deviceKey = U.crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16);
    const known = D.find('logins', l => l.userId === user.id && l.deviceKey === deviceKey);
    D.insert('logins', { id: U.uid('lg_'), userId: user.id, at: Date.now(), ip, ua, deviceKey, newDevice: !known });
    if (D.db().logins.length > 2000) D.db().logins.splice(0, D.db().logins.length - 2000);
    if (!known) {
      mailer.sendMail({ to: user.email, subject: '🔐 New device sign-in — Blockchain Bullhorn',
        html: mailer.templates.newDevice(user, ua.slice(0, 90), new Date().toUTCString()) }).catch(() => {});
    }
  } catch (e) { /* history must never block login */ }
  D.save();
  const t = Auth.createSession(user.id);
  ok(res, { user: Auth.publicUser(user), token: t },
    { 'Set-Cookie': U.cookieStr(Auth.SESSION_COOKIE, t, { maxAge: 7 * 24 * 3600 }) });
}

api['POST /api/auth/login-2fa'] = async (req, res, body, cookies) => {
  const payload = jwt.verify(String(body.challenge || ''));
  if (!payload || payload.typ !== '2fa') return fail(res, 401, 'Login session expired. Please sign in again.');
  const user = D.find('users', u => u.id === payload.uid);
  if (!user || user.banned) return fail(res, 403, 'This account is not available.');
  if (!user.totpEnabled || !totp.verify(user.totpSecret, String(body.code || ''))) {
    return fail(res, 401, 'Invalid authenticator code. Try the next code.');
  }
  completeLogin(req, res, user);
};

api['POST /api/auth/logout'] = async (req, res, body, cookies) => {
  if (cookies[Auth.SESSION_COOKIE]) Auth.destroySession(cookies[Auth.SESSION_COOKIE]);
  ok(res, {}, { 'Set-Cookie': U.cookieStr(Auth.SESSION_COOKIE, '', { clear: true }) });
};

api['GET /api/auth/me'] = async (req, res, body, cookies) => {
  const user = Auth.userFromRequest(req, cookies);
  if (!user) return ok(res, { user: null });
  const live = trading.equity(user.id, 'live');
  const demo = trading.equity(user.id, 'demo');
  live.manualPnl = ((D.wallet(user.id, 'live', false) || {}).manualPnl) || 0;
  demo.manualPnl = ((D.wallet(user.id, 'demo', false) || {}).manualPnl) || 0;
  ok(res, {
    user: Auth.publicUser(user), live, demo,
    gamify: gamify.profile(user),
    watchlist: user.watchlist || [],
    totpEnabled: !!user.totpEnabled
  });
};

api['POST /api/auth/forgot'] = async (req, res, body) => {
  const email = String(body.email || '').trim().toLowerCase();
  const user = D.find('users', u => u.email === email);
  if (!user) return ok(res, { sent: true, message: 'If an account exists for that email, a recovery link has been created.' });
  const t = U.token(20);
  D.insert('resets', { token: t, userId: user.id, expiresAt: Date.now() + 3600 * 1000, used: false });
  ok(res, {
    sent: true,
    // NOTE: SMTP is not configured on this deployment, so the secure recovery link is
    // returned directly. With SMTP configured this would be emailed instead.
    resetUrl: `/reset-password?token=${t}`,
    message: 'Recovery link created. Email delivery is not configured on this deployment, so use the link below (valid 1 hour).'
  });
};

api['POST /api/auth/reset'] = async (req, res, body) => {
  const token = String(body.token || '');
  const password = String(body.password || '');
  const rec = D.find('resets', r => r.token === token && !r.used && r.expiresAt > Date.now());
  if (!rec) return fail(res, 400, 'This reset link is invalid or has expired. Request a new one.');
  if (U.pwStrength(password) < 3) return fail(res, 400, 'Password must be at least 8 characters and include letters and numbers.');
  const user = D.find('users', u => u.id === rec.userId);
  if (!user) return fail(res, 400, 'Account no longer exists.');
  user.passwordHash = U.hashPassword(password);
  rec.used = true;
  D.save();
  ok(res, { message: 'Password updated. You can now log in with your new password.' });
};

// ---- markets ----
/* ---------------- 2FA (TOTP) ---------------- */
api['POST /api/auth/2fa-setup'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  if (user.totpEnabled) return fail(res, 409, 'Two-factor authentication is already enabled.');
  const secret = totp.generateSecret();
  user.totpPending = secret;
  D.save();
  ok(res, { secret, otpauth: totp.otpauthUrl(secret, user.email) });
};

api['POST /api/auth/2fa-enable'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  if (!user.totpPending) return fail(res, 400, 'Start the setup again — no pending secret.');
  if (!totp.verify(user.totpPending, String(body.code || ''))) return fail(res, 400, 'That code didn\'t match. Check your authenticator and try the next code.');
  user.totpSecret = user.totpPending;
  user.totpEnabled = true;
  delete user.totpPending;
  D.save();
  gamify.addXP(user.id, 40, '2fa');
  mailer.sendMail({ to: user.email, subject: '2FA enabled — Blockchain Bullhorn', html: mailer.templates.twofaEnabled(user) }).catch(() => {});
  ok(res, { message: 'Two-factor authentication is now active. Keep a backup of your secret!' });
};

api['POST /api/auth/2fa-disable'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  if (!user.totpEnabled) return fail(res, 400, 'Two-factor authentication is not enabled.');
  if (!U.verifyPassword(String(body.password || ''), user.passwordHash)) return fail(res, 403, 'Incorrect password.');
  if (!totp.verify(user.totpSecret, String(body.code || ''))) return fail(res, 400, 'Invalid authenticator code.');
  user.totpEnabled = false;
  delete user.totpSecret;
  D.save();
  mailer.sendMail({ to: user.email, subject: '2FA disabled — Blockchain Bullhorn', html: mailer.templates.twofaDisabled(user) }).catch(() => {});
  ok(res, { message: 'Two-factor authentication has been turned off.' });
};

/* ---------------- Alerts / watchlist / modify ---------------- */
function pricesSnapshot() {
  const out = {};
  for (const a of markets.ASSETS) out[a.id] = markets.priceOf(a.id);
  return out;
}

api['GET /api/alerts'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  trading.checkAlerts(pricesSnapshot());   // fire any that crossed since last tick
  const alerts = D.filter('alerts', a => a.userId === user.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
  ok(res, { alerts, untriggered: alerts.filter(a => a.status === 'active').length });
};

api['POST /api/alerts'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const asset = markets.byId[String(body.assetId || '')];
  if (!asset) return fail(res, 400, 'Unknown asset.');
  const dir = body.dir === 'below' ? 'below' : 'above';
  const target = Number(body.price);
  if (!isFinite(target) || target <= 0) return fail(res, 400, 'Enter a valid target price.');
  const active = D.filter('alerts', a => a.userId === user.id && a.status === 'active');
  if (active.length >= 25) return fail(res, 400, 'Maximum 25 active alerts. Delete some first.');
  const alert = D.insert('alerts', {
    id: U.uid('al_'), userId: user.id, assetId: asset.id, symbol: asset.symbol, name: asset.name,
    dir, target: U.round(target, target >= 100 ? 2 : 6), status: 'active',
    createdAt: Date.now(), triggeredAt: 0, triggeredPrice: 0, seen: true
  });
  ok(res, { alert, message: `Alert set: ${asset.symbol} ${dir} $${target}` });
};

api['POST /api/alerts/delete'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  D.remove('alerts', a => a.id === body.id && a.userId === user.id);
  ok(res, { message: 'Alert deleted' });
};

api['POST /api/alerts/seen'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  for (const a of D.filter('alerts', x => x.userId === user.id)) a.seen = true;
  D.save();
  ok(res, {});
};

api['POST /api/watchlist/toggle'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const asset = markets.byId[String(body.assetId || '')];
  if (!asset) return fail(res, 400, 'Unknown asset.');
  user.watchlist = Array.isArray(user.watchlist) ? user.watchlist : [];
  const i = user.watchlist.indexOf(asset.id);
  if (i >= 0) user.watchlist.splice(i, 1);
  else { if (user.watchlist.length >= 30) return fail(res, 400, 'Watchlist is full (30 assets).'); user.watchlist.push(asset.id); }
  D.save();
  ok(res, { watchlist: user.watchlist, added: i < 0 });
};

api['POST /api/trading/modify'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const r = trading.modifyPosition(user, body.positionId, body);
  if (r.error) return fail(res, r.status, r.error);
  ok(res, r);
};

/* ---------------- Weekly demo contest & referrals ---------------- */
function weekStart(t) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

api['GET /api/contest'] = async (req, res, body, cookies) => {
  const ws = weekStart(Date.now());
  const agg = {};
  for (const t of D.db().trades) {
    if (t.mode !== 'demo' || t.action !== 'close' || t.copyOf || t.at < ws) continue;
    agg[t.userId] = agg[t.userId] || { pnl: 0, margin: 0, trades: 0 };
    agg[t.userId].pnl += t.pnl || 0;
    agg[t.userId].margin += t.margin || 0;
    agg[t.userId].trades++;
  }
  const standings = Object.entries(agg)
    .filter(([, v]) => v.trades >= 3)
    .map(([uid_, v]) => {
      const u = D.find('users', x => x.id === uid_);
      return {
        userId: uid_, name: u ? u.name : 'Unknown', avatarColor: (u && u.avatarColor) || '#1ba94b',
        roi: v.margin ? U.round(v.pnl / v.margin * 100, 1) : 0, pnl: U.round(v.pnl), trades: v.trades
      };
    })
    .sort((a, b) => b.roi - a.roi)
    .slice(0, 10)
    .map((row, i) => Object.assign(row, { rank: i + 1 }));
  const me = requireUser(req, res, cookies);
  const meRow = me ? standings.find(s => s.userId === me.id) : null;
  const cs = D.db().settings.contest || {};
  ok(res, { enabled: cs.enabled !== false, prize: cs.prize || '', weekStart: ws, weekEnd: ws + 7 * 864e5, standings, me: meRow || null });
};

api['GET /api/referrals'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const code = user.referralCode || '';
  const referred = D.filter('users', u => String(u.referredBy || '').toUpperCase() === code && u.id !== user.id)
    .sort((a, b) => b.joinedAt - a.joinedAt)
    .map(u => {
      const kyc = D.find('kyc', k => k.userId === u.id);
      const last = D.db().trades.filter(t => t.userId === u.id).sort((a, b) => b.at - a.at)[0];
      return {
        name: u.firstName + (u.lastName ? ' ' + u.lastName[0] + '.' : ''),
        joinedAt: u.joinedAt, kycStatus: kyc ? kyc.status : 'not_submitted',
        active: !!(last && last.at > Date.now() - 30 * 864e5)
      };
    });
  ok(res, {
    code, link: '/signup?ref=' + encodeURIComponent(code), referred,
    total: referred.length, active: referred.filter(r => r.active).length,
    xpPerReferral: 100
  });
};

api['GET /api/auth/logins'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const logins = D.filter('logins', l => l.userId === user.id).sort((a, b) => b.at - a.at).slice(0, 15)
    .map(l => ({ at: l.at, ip: l.ip, ua: l.ua, newDevice: l.newDevice }));
  ok(res, { logins });
};

api['GET /api/markets'] = async (req, res) => { ok(res, markets.snapshot()); };

api['GET /api/markets/candles'] = async (req, res, body, cookies, query) => {
  try {
    const data = await markets.candles(query.get('asset'), query.get('range') || '1D');
    ok(res, { candles: data });
  } catch (e) { fail(res, e.status || 502, e.status ? e.message : 'Market data temporarily unavailable'); }
};

// ---- trading ----
api['GET /api/trading/state'] = async (req, res, body, cookies, query) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const qMode = query.get('mode');
  const mode = (qMode === 'live' || qMode === 'demo') ? qMode : (cookies['bb_mode'] === 'live' ? 'live' : 'demo');
  const book = trading.userBook(user.id, mode);
  const decorate = p => {
    const price = markets.priceOf(p.assetId);
    const pnl = trading.positionPnl(p, price);
    return Object.assign({}, p, { currentPrice: price, pnl: U.round(pnl), pnlPct: U.round(pnl / p.margin * 100), liquidationPrice: U.round(p.side === 'buy' ? p.entry * (1 - 0.9 / p.leverage) : p.entry * (1 + 0.9 / p.leverage), 6) });
  };
  ok(res, {
    mode, equity: trading.equity(user.id, mode),
    positions: book.positions.map(decorate),
    mirrored: book.mirrored.map(decorate),
    orders: book.orders, recentTrades: book.trades, feeRate: trading.FEE_RATE
  });
};

api['POST /api/trading/order'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const r = trading.placeOrder(user, Object.assign({}, body, { mode: body.mode || cookies['bb_mode'] || 'demo' }));
  if (r.error) return fail(res, r.status, r.error);
  ok(res, r);
};

api['POST /api/trading/close'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const r = trading.closePosition(user, body.positionId);
  if (r.error) return fail(res, r.status, r.error);
  ok(res, r);
};

api['POST /api/trading/cancel'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const r = trading.cancelOrder(user, body.orderId);
  if (r.error) return fail(res, r.status, r.error);
  ok(res, r);
};

api['POST /api/trading/mode'] = async (req, res, body) => {
  const mode = body.mode === 'live' ? 'live' : 'demo';
  ok(res, { mode }, { 'Set-Cookie': U.cookieStr('bb_mode', mode, { maxAge: 3600 * 24 * 365 }) });
};

api['POST /api/trading/reset-demo'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  ok(res, trading.resetDemo(user));
};

// ---- funding ----
api['GET /api/funding/summary'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const txs = D.filter('transactions', t => t.userId === user.id).sort((a, b) => b.createdAt - a.createdAt);
  const kyc = D.find('kyc', k => k.userId === user.id);
  ok(res, {
    live: trading.equity(user.id, 'live'),
    demo: trading.equity(user.id, 'demo'),
    transactions: txs.slice(0, 100).map(t => Object.assign({ adminNote: t.adminNote || '' }, t)),
    addresses: D.db().settings.depositAddresses,
    minDeposit: D.db().settings.minDeposit,
    minWithdraw: D.db().settings.minWithdraw,
    kycStatus: kyc ? kyc.status : 'not_submitted'
  });
};

const PROOF_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

// purchasable education products (keep in sync with public/store.html)
const PRODUCTS = {
  ssc:   { id: 'ssc',   name: 'Super Simple Crypto (Trading) System', price: 497 },
  cheat: { id: 'cheat', name: 'The Crypto Cheat Guide (Solo) 2026',   price: 27  },
  combo: { id: 'combo', name: 'Crypto Cheat Guide — COMBO PACK',      price: 47  }
};
const PROOF_MAX = 5 * 1024 * 1024;

api['POST /api/funding/deposit'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const amount = Number(body.amountUsd);
  const asset = String(body.asset || '');
  const txid = String(body.txid || '').trim();
  const s = D.db().settings;
  if (!(asset in s.depositAddresses)) return fail(res, 400, 'Choose a valid deposit asset.');
  if (!String(s.depositAddresses[asset]).trim()) return fail(res, 400, `${asset} deposits are not yet available — please use another coin or contact support.`);
  if (!isFinite(amount) || amount < s.minDeposit) return fail(res, 400, `Minimum deposit is $${s.minDeposit}.`);
  if (txid.length < 10) return fail(res, 400, 'Please paste your transaction hash (TXID) so we can verify the transfer.');
  // proof screenshot / receipt (image or PDF, max 5MB) — required
  let proof = null;
  const p = body.proof || {};
  if (!p.data || !PROOF_TYPES[p.mime]) return fail(res, 400, 'Please upload a screenshot or receipt of your completed transaction (JPG, PNG, WEBP or PDF).');
  {
    const buf = Buffer.from(String(p.data), 'base64');
    if (!buf || buf.length < 100) return fail(res, 400, 'The uploaded proof file appears to be empty.');
    if (buf.length > PROOF_MAX) return fail(res, 400, 'Proof file must be under 5MB.');
    try {
      const dir = path.join(D.UPLOAD_DIR, user.id);
      fs.mkdirSync(dir, { recursive: true });
      const fname = U.uid('dpf_') + PROOF_TYPES[p.mime];
      fs.writeFileSync(path.join(dir, fname), buf);
      Backup.pushFile(path.join(dir, fname)); // GitHub data-sync
      proof = { file: fname, mime: p.mime, name: String(p.name || 'proof').slice(0, 120), size: buf.length };
    } catch (e) { return fail(res, 500, 'Could not store the proof file. Try again.'); }
  }
  D.insert('transactions', {
    id: U.uid('tx_'), userId: user.id, type: 'deposit', asset, amountUsd: U.round(amount),
    txid, status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), note: body.note || '',
    proof: proof || null
  });
  ok(res, { message: 'Deposit submitted with your transaction proof. Our admin team will verify it and credit your live wallet — you will be notified.' });
};

api['POST /api/store/purchase'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const prod = PRODUCTS[String(body.productId || '')];
  if (!prod) return fail(res, 400, 'Product not found.');
  const asset = String(body.asset || '');
  const txid = String(body.txid || '').trim();
  const s = D.db().settings;
  const pw = s.productPaymentAddresses || {};
  if (!(asset in pw)) return fail(res, 400, 'Products can be purchased with USDT (ERC-20) only.');
  if (!String(pw[asset]).trim()) return fail(res, 400, 'USDT (ERC-20) product payments are temporarily unavailable — please contact support.');
  if (txid.length < 10) return fail(res, 400, 'Please paste your transaction hash (TXID) so we can verify the payment.');
  const existing = D.find('transactions', t => t.userId === user.id && t.type === 'product' && t.productId === prod.id && (t.status === 'pending' || t.status === 'completed'));
  if (existing) return fail(res, 400, existing.status === 'completed'
    ? `You already own "${prod.name}" — it is unlocked on your account.`
    : `Your payment for "${prod.name}" is already being verified.`);
  // payment proof (same rules as deposit proofs)
  const p = body.proof || {};
  if (!p.data || !PROOF_TYPES[p.mime]) return fail(res, 400, 'Please upload a screenshot or receipt of your payment (JPG, PNG, WEBP or PDF).');
  const buf = Buffer.from(String(p.data), 'base64');
  if (!buf || buf.length < 100) return fail(res, 400, 'The uploaded proof file appears to be empty.');
  if (buf.length > PROOF_MAX) return fail(res, 400, 'Proof file must be under 5MB.');
  let proof;
  try {
    const dir = path.join(D.UPLOAD_DIR, user.id);
    fs.mkdirSync(dir, { recursive: true });
    const fname = U.uid('ppf_') + PROOF_TYPES[p.mime];
    fs.writeFileSync(path.join(dir, fname), buf);
    Backup.pushFile(path.join(dir, fname)); // GitHub data-sync
    proof = { file: fname, mime: p.mime, name: String(p.name || 'proof').slice(0, 120), size: buf.length };
  } catch (e) { return fail(res, 500, 'Could not store the proof file. Try again.'); }
  D.insert('transactions', {
    id: U.uid('tx_'), userId: user.id, type: 'product', productId: prod.id, productName: prod.name,
    asset, amountUsd: prod.price, txid, status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), proof
  });
  ok(res, { message: `Payment submitted for "${prod.name}". Our team will verify it and unlock your product — you will be notified.` });
};

api['GET /api/store/payment-wallets'] = (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const pw = D.db().settings.productPaymentAddresses || {};
  const wallets = {};
  for (const k of Object.keys(pw)) if (String(pw[k]).trim()) wallets[k] = pw[k];
  ok(res, { wallets });
};

api['GET /api/store/purchases'] = (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const purchases = D.filter('transactions', t => t.userId === user.id && t.type === 'product')
    .map(t => ({ id: t.id, productId: t.productId, productName: t.productName, amountUsd: t.amountUsd, asset: t.asset, status: t.status, createdAt: t.createdAt }));
  ok(res, { purchases });
};

api['POST /api/funding/withdraw'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const kyc = D.find('kyc', k => k.userId === user.id);
  if (!kyc || kyc.status !== 'approved') return fail(res, 403, 'KYC verification is required for withdrawals.');
  const amount = Number(body.amountUsd);
  const asset = String(body.asset || '');
  const address = String(body.address || '').trim();
  const s = D.db().settings;
  if (!(asset in s.depositAddresses)) return fail(res, 400, 'Choose a valid withdrawal asset.');
  if (!String(s.depositAddresses[asset]).trim()) return fail(res, 400, `${asset} withdrawals are not yet available — please choose another coin or contact support.`);
  if (!isFinite(amount) || amount < s.minWithdraw) return fail(res, 400, `Minimum withdrawal is $${s.minWithdraw}.`);
  if (address.length < 12) return fail(res, 400, 'Please enter a valid destination wallet address.');
  const eq = trading.equity(user.id, 'live');
  if (amount > eq.free) return fail(res, 400, `Insufficient free balance. Available: $${eq.free}.`);
  const w = D.wallet(user.id, 'live');
  w.usd = U.round(w.usd - amount);
  D.insert('transactions', {
    id: U.uid('tx_'), userId: user.id, type: 'withdraw', asset, amountUsd: U.round(amount),
    address, status: 'pending', createdAt: Date.now(), updatedAt: Date.now()
  });
  D.save();
  ok(res, { message: 'Withdrawal request submitted. Funds are on hold and will be sent after review.' });
};

api['POST /api/funding/demo-topup'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const w = D.wallet(user.id, 'demo');
  const target = Number(D.db().settings.demoStartBalance) || 10000;
  if (w.usd >= target) return fail(res, 400, `Demo balance is already at $${target.toLocaleString()}.`);
  const add = target - w.usd;
  D.creditWallet(user.id, 'demo', add);
  D.insert('transactions', { id: U.uid('tx_'), userId: user.id, type: 'demo_topup', asset: 'USD', amountUsd: U.round(add), status: 'completed', createdAt: Date.now(), updatedAt: Date.now() });
  ok(res, { message: `Demo wallet topped up to $${target.toLocaleString()}.` });
};

// ---- KYC ----
api['POST /api/kyc/submit'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const { submitKyc } = require('./lib/kyc');
  const r = submitKyc(user, body.idType, Array.isArray(body.docs) ? body.docs : [], body.details || {});
  if (r.error) return fail(res, r.status, r.error);
  gamify.addXP(user.id, 25, 'kyc');
  ok(res, r);
};
api['GET /api/kyc/status'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const kyc = D.find('kyc', k => k.userId === user.id);
  ok(res, { kyc: kyc ? { status: kyc.status, reason: kyc.reason || '', submittedAt: kyc.submittedAt, reviewedAt: kyc.reviewedAt, idType: kyc.idType } : null });
};

// ---- chat ----
function getConv(req, cookies, user, create) {
  let conv = null;
  if (user) conv = D.find('chats', c => c.userId === user.id);
  if (!conv) {
    const gk = cookies[Auth.CHAT_COOKIE];
    if (gk) conv = D.find('chats', c => c.guestKey === gk);
  }
  if (!conv && create) {
    const gk = cookies[Auth.CHAT_COOKIE] || U.token(12);
    conv = D.insert('chats', {
      id: U.uid('c_'), userId: user ? user.id : null, guestKey: gk,
      name: user ? (user.name || user.email) : 'Guest visitor',
      email: user ? user.email : '', lastMsgAt: Date.now(), unreadAdmin: 0, createdAt: Date.now()
    });
    if (!user) conv._setCookie = U.cookieStr(Auth.CHAT_COOKIE, gk, { maxAge: 3600 * 24 * 365 });
    D.save();
  }
  return conv;
}

api['POST /api/chat/init'] = async (req, res, body, cookies) => {
  const user = Auth.userFromRequest(req, cookies);
  const conv = getConv(req, cookies, user, true);
  const msgs = D.filter('messages', m => m.convId === conv.id).sort((a, b) => a.at - b.at);
  const headers = conv._setCookie ? { 'Set-Cookie': conv._setCookie } : undefined;
  ok(res, { convId: conv.id, messages: msgs, name: conv.name }, headers);
};

api['GET /api/chat/messages'] = async (req, res, body, cookies, query) => {
  const user = Auth.userFromRequest(req, cookies);
  const conv = getConv(req, cookies, user, false);
  if (!conv) return ok(res, { messages: [] });
  const after = Number(query.get('after') || 0);
  const msgs = D.filter('messages', m => m.convId === conv.id && m.at > after).sort((a, b) => a.at - b.at);
  ok(res, { messages: msgs });
};

api['POST /api/chat/send'] = async (req, res, body, cookies) => {
  const user = Auth.userFromRequest(req, cookies);
  const text = String(body.text || '').trim().slice(0, 1000);
  if (!text) return fail(res, 400, 'Message is empty');
  const conv = getConv(req, cookies, user, true);
  const headers = conv._setCookie ? { 'Set-Cookie': conv._setCookie } : undefined;
  D.insert('messages', { id: U.uid('m_'), convId: conv.id, from: 'user', text, at: Date.now(), seen: false });
  conv.lastMsgAt = Date.now(); conv.unreadAdmin++;
  if (user) { conv.userId = user.id; conv.name = user.name || user.email; conv.email = user.email; }
  // auto-acknowledge on first message
  const count = D.filter('messages', m => m.convId === conv.id && m.from === 'user').length;
  if (count === 1) {
    setTimeout(() => {
      D.insert('messages', {
        id: U.uid('m_'), convId: conv.id, from: 'bot', at: Date.now(),
        text: "Thanks for reaching out to Blockchain Bullhorn Support! 🐂 Our team has been notified and will reply here shortly. For quick answers about spreadsheets, logins and orders, check the FAQ page — and catch Calvin live on TikTok 7–8PM EST."
      });
      D.save();
    }, 900);
  }
  D.save();
  ok(res, {}, headers);
};

// ---- community (gated: apply → admin approval) ----
api['GET /api/community/status'] = async (req, res, body, cookies) => {
  const user = Auth.userFromRequest(req, cookies);
  if (!user) return ok(res, { status: 'guest', memberCount: D.filter('community_apps', a => a.status === 'approved').length });
  const app = D.find('community_apps', a => a.userId === user.id);
  ok(res, {
    status: app ? app.status : 'none',
    reason: app && app.status === 'rejected' ? app.reason : '',
    appliedAt: app ? app.appliedAt : 0,
    quizScore: app ? app.quizScore : null,
    memberCount: D.filter('community_apps', a => a.status === 'approved').length
  });
};

api['POST /api/community/apply'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const existing = D.find('community_apps', a => a.userId === user.id);
  if (existing && existing.status === 'pending') return fail(res, 409, 'Your membership application is already under review.');
  if (existing && existing.status === 'approved') return fail(res, 409, 'You are already a community member.');
  const quizScore = parseInt(body.quizScore);
  if (!body.rulesAccepted) return fail(res, 400, 'You must accept the community rules and risk disclosure.');
  if (!isFinite(quizScore) || quizScore < 4) return fail(res, 400, 'You need at least 4/5 on the onboarding quiz — review the lessons and try again.');
  if (quizScore >= 4) gamify.grantBadge(user.id, 'quiz_pass');
  const app = {
    id: U.uid('cm_'), userId: user.id, status: 'pending',
    experience: String(body.experience || '').slice(0, 300),
    goals: String(body.goals || '').slice(0, 600),
    quizScore, rulesAccepted: true, appliedAt: Date.now(), reviewedAt: 0, reason: ''
  };
  if (existing) { Object.assign(existing, app, { id: existing.id }); D.save(); }
  else D.insert('community_apps', app);
  ok(res, { message: 'Application submitted! Our team reviews every request manually — you will see the result here, usually within 24 hours.' });
};

// ---- copy trading ----
api['GET /api/copy/leaders'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies, true);
  const leaders = D.filter('copy_leaders', l => l.status !== 'pending').map(l => {
    const u = D.find('users', x => x.id === l.userId);
    return {
      id: l.id, userId: l.userId, status: l.status, title: l.title, style: l.style, description: l.description,
      name: u ? u.name : 'Unknown', avatarColor: u ? (u.avatarColor || '#d3a877') : '#d3a877',
      emoji: l.emoji || '\u{1F916}', avatar: l.avatar || '', bot: !!l.bot, minBalance: l.minBalance || 0, risk: l.risk || '',
      joinedAt: u ? u.joinedAt : 0, stats: trading.leaderStats(l)
    };
  }).sort((a, b) => (a.minBalance || 0) - (b.minBalance || 0));
  const out = { leaders, minCopy: trading.MIN_COPY };
  if (user) {
    out.liveEquity = trading.equity(user.id, 'live').equity;
    out.myRequests = D.filter('bot_requests', r => r.userId === user.id && r.leaderId).map(r => ({
      leaderId: r.leaderId, status: r.status, key: r.status === 'approved' ? r.key : '', requestedAt: r.requestedAt
    }));
    out.myActive = D.filter('copy_allocations', a => a.userId === user.id && a.active).map(a => ({ leaderId: a.leaderId, mode: a.mode }));
  }
  ok(res, out);
};

api['GET /api/copy/my'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const allocations = D.filter('copy_allocations', a => a.userId === user.id && a.active).map(a => {
    const l = D.find('copy_leaders', x => x.id === a.leaderId);
    const lu = l ? D.find('users', x => x.id === l.userId) : null;
    const mirrors = D.filter('positions', p => p.allocId === a.id).map(p => {
      const price = markets.priceOf(p.assetId);
      return Object.assign({}, p, { currentPrice: price, pnl: U.round(trading.positionPnl(p, price)) });
    });
    const openValue = mirrors.reduce((s, p) => s + p.margin + p.pnl, 0);
    return {
      id: a.id, leaderId: a.leaderId, leaderName: lu ? lu.name : 'Unknown', leaderTitle: l ? l.title : '',
      leaderAvatar: l ? (l.avatar || '') : '', leaderEmoji: l ? (l.emoji || '\u{1F916}') : '\u{1F916}',
      mode: a.mode, allocated: a.allocated, cash: a.equity, openValue: U.round(openValue),
      total: U.round(a.equity + openValue), pnl: U.round(a.equity + openValue - a.allocated),
      startedAt: a.startedAt, mirrors
    };
  });
  const myLeader = D.find('copy_leaders', l => l.userId === user.id);
  ok(res, { allocations, myLeaderStatus: myLeader ? myLeader.status : null });
};

api['POST /api/copy/start'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  // bots are gated behind admin-approved connection keys + minimum live portfolio balance
  const leader = D.find('copy_leaders', l => l.id === body.leaderId);
  if (leader && leader.bot) {
    const approved = D.find('bot_requests', q => q.userId === user.id && q.leaderId === leader.id && q.status === 'approved');
    if (!approved) return fail(res, 403, 'This bot requires an admin-issued connection key. Request one from the Trading Bots page.');
    const liveEq = trading.equity(user.id, 'live').equity;
    if (liveEq < leader.minBalance) return fail(res, 400, `This bot requires a minimum live portfolio balance of $${leader.minBalance.toLocaleString()}. Your live portfolio is currently $${liveEq.toLocaleString()}.`);
  }
  const r = trading.startCopy(user, body.leaderId, body.mode, body.amount);
  if (r.error) return fail(res, r.status, r.error);
  ok(res, r);
};

api['POST /api/copy/stop'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const r = trading.stopCopy(user, body.allocationId);
  if (r.error) return fail(res, r.status, r.error);
  ok(res, r);
};

api['GET /api/swap/assets'] = async (req, res) => {
  ok(res, { assets: trading.swapAssets(), feeRate: trading.SWAP_FEE });
};

api['GET /api/swap/quote'] = async (req, res, body, cookies, query) => {
  const q = trading.swapQuote(query.get('from') || 'usd', query.get('to') || '', query.get('amount') || 0);
  if (q.error) return fail(res, 400, q.error);
  ok(res, q);
};

api['POST /api/swap/execute'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const r = trading.executeSwap(user, { from: body.from, to: body.to, amount: body.amount, mode: body.mode });
  if (r.error) return fail(res, r.status, r.error);
  ok(res, r);
};

api['POST /api/bots/request-key'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const leader = D.find('copy_leaders', l => l.id === String(body.botId || '') && l.bot && l.status === 'active');
  if (!leader) return fail(res, 404, 'Trading bot not found.');
  const liveEq = trading.equity(user.id, 'live').equity;
  if (liveEq < leader.minBalance) {
    return fail(res, 400, `This bot requires a minimum live portfolio balance of $${leader.minBalance.toLocaleString()}. Your live portfolio is currently $${liveEq.toLocaleString()}.`);
  }
  const existing = D.find('bot_requests', r => r.userId === user.id && r.leaderId === leader.id && (r.status === 'pending' || r.status === 'approved'));
  if (existing) return fail(res, 409, existing.status === 'pending'
    ? 'Your connection key request for this bot is already under review.'
    : 'You already have a connection key for this bot — activate it below.');
  D.insert('bot_requests', {
    id: U.uid('br_'), userId: user.id, leaderId: leader.id, status: 'pending', key: '',
    requestedAt: Date.now(), reviewedAt: 0
  });
  ok(res, { message: 'Connection key requested. Our team reviews every request manually — you will be notified once your key is issued.' });
};

api['POST /api/bots/activate'] = async (req, res, body, cookies) => {
  const user = requireUser(req, res, cookies); if (!user) return;
  const leader = D.find('copy_leaders', l => l.id === String(body.botId || '') && l.bot && l.status === 'active');
  if (!leader) return fail(res, 404, 'Trading bot not found.');
  const req_ = D.find('bot_requests', r => r.userId === user.id && r.leaderId === leader.id && r.status === 'approved');
  if (!req_ || !req_.key) return fail(res, 400, 'No approved connection key for this bot. Request a key first — it is issued after admin approval.');
  if (String(body.key || '').trim().toUpperCase() !== req_.key.toUpperCase()) return fail(res, 400, 'Invalid connection key. Check the key issued to you and try again.');
  const liveEq = trading.equity(user.id, 'live').equity;
  if (liveEq < leader.minBalance) {
    return fail(res, 400, `This bot requires a minimum live portfolio balance of $${leader.minBalance.toLocaleString()}. Your live portfolio is currently $${liveEq.toLocaleString()}.`);
  }
  const r = trading.startCopy(user, leader.id, body.mode, body.amount);
  if (r.error) return fail(res, r.status, r.error);
  ok(res, r);
};

api['GET /api/bots/activity'] = async (req, res) => {
  const leaders = D.filter('copy_leaders', l => l.bot);
  const byUser = new Map(leaders.map(l => [l.userId, l]));
  const activity = D.filter('trades', t => byUser.has(t.userId) && !t.copyOf)
    .slice(-40).reverse()
    .map(t => {
      const l = byUser.get(t.userId);
      const u = D.find('users', x => x.id === t.userId);
      return {
        botName: u ? u.name.replace(' Bot', '') : 'Bot', botTitle: l.title,
        emoji: l.emoji || '\u{1F916}', avatar: l.avatar || '',
        symbol: t.symbol, name: t.name, side: t.side, action: t.action, mode: t.mode,
        price: t.price, notional: t.notional, pnl: t.pnl || 0, reason: t.reason || '', at: t.at
      };
    });
  ok(res, { activity });
};


// ---- public settings ----
api['GET /api/settings/public'] = async (req, res) => {
  const s = D.db().settings;
  const adminOnline = D.filter('sessions', x => x.expiresAt > Date.now()).some(x => {
    const u = D.find('users', u => u.id === x.userId);
    return u && u.role === 'admin';
  });
  ok(res, {
    smartsuppKey: s.smartsuppKey || '',
    announcements: Array.isArray(s.announcements) ? s.announcements : [],
    siteName: s.siteName,
    supportEmail: s.supportEmail,
    contest: { enabled: s.contest ? s.contest.enabled !== false : true, prize: (s.contest && s.contest.prize) || '' },
    chatOnline: adminOnline
  });
};

// ---- admin ----
// ---- silent visitor geo-detection (country only; used once to pick a display currency) ----
api['GET /api/geo'] = async (req, res) => {
  const crypto = require('crypto');
  const rawIp = String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
  const priv = !rawIp || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|localhost|0\.0\.0\.0)/.test(rawIp);
  const ipKey = priv ? 'local' : crypto.createHash('sha256').update(rawIp).digest('hex').slice(0, 20); // privacy: hash, never store raw IPs
  if (priv) return ok(res, { country: null });
  const s = D.db().settings || (D.db().settings = {});
  const cache = s.geoCache || (s.geoCache = {});
  const hit = cache[ipKey];
  if (hit && Date.now() - hit.at < 30 * 86400000) return ok(res, { country: hit.c || null });
  try {
    const r = await fetch('https://ipwho.is/' + encodeURIComponent(rawIp), { headers: { accept: 'application/json' } });
    const j = await r.json();
    const cc = (j && j.success && j.country_code && String(j.country_code).toUpperCase()) || null;
    cache[ipKey] = { c: cc, at: Date.now() }; s.geoCache = cache; D.save();
    return ok(res, { country: cc });
  } catch (e) {
    cache[ipKey] = { c: null, at: Date.now() - 25 * 86400000 }; s.geoCache = cache; D.save(); // short negative cache
    return ok(res, { country: null });
  }
};

// ---- FX rates (display-currency conversion; accounts are held in USD) ----
const FX_SEED = { USD: 1, EUR: 0.90, GBP: 0.78, CAD: 1.37, AUD: 1.52, JPY: 150, CNY: 7.15, INR: 88, NGN: 1550, ZAR: 18.2, BRL: 5.45, MXN: 18.4, AED: 3.67, SAR: 3.75, TRY: 42, CHF: 0.88, KES: 129, GHS: 15.5, PHP: 58 };
api['GET /api/fx'] = async (req, res) => {
  const s = D.db().settings || (D.db().settings = {});
  const fx = s.fx;
  const fresh = fx && fx.rates && fx.base === 'USD' && (Date.now() - fx.updatedAt < 12 * 3600 * 1000);
  if (fresh) return ok(res, { base: 'USD', rates: fx.rates, updatedAt: fx.updatedAt });
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD', { headers: { accept: 'application/json' } });
    const j = await r.json();
    if (j && j.result === 'success' && j.rates && j.rates.EUR) {
      s.fx = { base: 'USD', rates: j.rates, updatedAt: Date.now() };
      D.save();
      return ok(res, { base: 'USD', rates: j.rates, updatedAt: s.fx.updatedAt });
    }
    throw new Error('unexpected FX payload');
  } catch (e) {
    if (fx && fx.rates) return ok(res, { base: 'USD', rates: fx.rates, updatedAt: fx.updatedAt, stale: true });
    return ok(res, { base: 'USD', rates: FX_SEED, updatedAt: 0, stale: true });
  }
};

// ---- web push ----
api['GET /api/push/config'] = async (req, res) => {
  const push = require('./lib/push');
  const k = push.keys();
  // diagnostics: is the vendored web-push tree present, and does it load?
  let vendorFiles = false, requireErr = null;
  try { vendorFiles = fs.existsSync(path.join(__dirname, 'public', 'assets', 'js', 'webpush.bundle.js')); } catch (e) { vendorFiles = false; }
  try { require('./public/assets/js/webpush.bundle.js'); } catch (e) { requireErr = (e && e.message || String(e)).slice(0, 200); }
  ok(res, { publicKey: k ? k.publicKey : null, ready: !!(k && push.webpush()), vendorFiles, requireErr });
};

api['POST /api/push/subscribe'] = async (req, res, body, cookies) => {
  const user = Auth.userFromRequest(req, cookies); // may be null (guests can subscribe too)
  const endpoint = String(body.endpoint || '');
  const keys = body.keys || {};
  if (!/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) return fail(res, 400, 'Invalid subscription');
  if (!(D.db().push_subs || []).some(s => s.endpoint === endpoint)) {
    D.insert('push_subs', { id: U.uid('ps_'), userId: user ? user.id : null, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, createdAt: Date.now() });
    D.save();
  }
  ok(res, { subscribed: true });
};

api['POST /api/push/unsubscribe'] = async (req, res, body) => {
  const endpoint = String(body.endpoint || '');
  const before = (D.db().push_subs || []).length;
  D.db().push_subs = (D.db().push_subs || []).filter(s => s.endpoint !== endpoint);
  if (D.db().push_subs.length !== before) D.save();
  ok(res, { unsubscribed: true });
};

api['POST /api/admin/push-keys'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  try {
    const push = require('./lib/push');
    const k = push.generateKeys();
    D.logAudit(admin.id, 'push.keys', '', 'VAPID keys generated');
    ok(res, { publicKey: k.publicKey, message: 'Push keys generated. Subscribers can now enable notifications.' });
  } catch (e) { return fail(res, 500, e.message); }
};

api['GET /api/admin/push-subs'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const subs = D.db().push_subs || [];
  const users = new Set(subs.map(s => s.userId).filter(Boolean));
  ok(res, { total: subs.length, identifiedUsers: users.size, keysConfigured: !!(require('./lib/push').keys()) });
};

api['POST /api/admin/push'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const title = String(body.title || '').trim().slice(0, 80);
  const message = String(body.body || '').trim().slice(0, 200);
  const url = String(body.url || '/').trim().slice(0, 200);
  if (!title || !message) return fail(res, 400, 'Title and message are required');
  const push = require('./lib/push');
  if (!push.keys() || !push.webpush()) return fail(res, 400, 'Push is not configured yet — generate keys first (and run npm install on the server).');
  const r = await push.broadcast({ title, body: message, url, tag: 'bb-broadcast-' + Date.now() });
  D.logAudit(admin.id, 'push.broadcast', '', `${r.sent} sent / ${r.failed} failed / ${r.removed} removed — "${title}"`);
  ok(res, { message: `Notification sent to ${r.sent} subscriber(s)${r.failed ? `, ${r.failed} failed` : ''}${r.removed ? `, ${r.removed} stale removed` : ''}.`, ...r });
};

api['GET /api/admin/overview'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const db = D.db();
  const users = db.users;
  const week = Date.now() - 7 * 86400000;
  const deposits = db.transactions.filter(t => t.type === 'deposit');
  const withdraws = db.transactions.filter(t => t.type === 'withdraw');
  const openPositions = db.positions;
  const totalVolume = db.trades.reduce((s, t) => s + (t.notional || 0), 0);
  const liveEquity = users.reduce((s, u) => {
    const w = D.wallet(u.id, 'live', false);
    const eq = w ? w.usd : 0;
    return s + eq;
  }, 0) + openPositions.filter(p => p.mode === 'live').reduce((s, p) => s + p.margin, 0);
  const recentUsers = users.slice().sort((a, b) => b.joinedAt - a.joinedAt).slice(0, 8)
    .map(u => ({ id: u.id, email: u.email, name: u.name, joinedAt: u.joinedAt, kyc: (D.find('kyc', k => k.userId === u.id) || {}).status || 'not_submitted', role: u.role }));
  const movers = markets.snapshot().assets.filter(a => a.price != null).sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  ok(res, {
    stats: {
      totalUsers: users.filter(u => u.role !== 'admin').length,
      newUsersWeek: users.filter(u => u.joinedAt > week).length,
      kycPending: db.kyc.filter(k => k.status === 'pending').length,
      depositsPending: deposits.filter(t => t.status === 'pending').length,
      withdrawalsPending: withdraws.filter(t => t.status === 'pending').length,
      openPositions: openPositions.length,
      totalVolume: U.round(totalVolume),
      liveEquity: U.round(liveEquity),
      unreadChats: db.chats.reduce((s, c) => s + c.unreadAdmin, 0),
      totalTrades: db.trades.length,
      communityPending: db.community_apps.filter(a => a.status === 'pending').length,
      leaderPending: db.bot_requests.filter(r => r.status === 'pending').length, // bot connection-key requests
      copyAllocations: db.copy_allocations.filter(a => a.active).length
    },
    recentUsers,
    topGainers: movers.slice(0, 5),
    topLosers: movers.slice(-5).reverse(),
    marketUpdated: markets.lastRefresh
  });
};

api['GET /api/admin/users'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const q = String((body.q || '')).toLowerCase();
  const users = D.db().users.filter(u => {
    if (!q) return true;
    return u.email.toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q);
  }).slice().sort((a, b) => b.joinedAt - a.joinedAt).map(u => {
    const kyc = D.find('kyc', k => k.userId === u.id);
    const live = trading.equity(u.id, 'live'), demo = trading.equity(u.id, 'demo');
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, banned: !!u.banned,
      joinedAt: u.joinedAt, lastLogin: u.lastLogin, country: u.country,
      kycStatus: kyc ? kyc.status : 'not_submitted',
      communityStatus: (D.find('community_apps', a => a.userId === u.id) || { status: 'none' }).status,
      copyLeader: (D.find('copy_leaders', l => l.userId === u.id) || { status: '' }).status,
      liveEquity: live.equity, demoEquity: demo.equity,
      positions: D.filter('positions', p => p.userId === u.id).length,
      referralCode: u.referralCode
    };
  });
  ok(res, { users });
};

api['GET /api/admin/user'] = async (req, res, body, cookies, query) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const u = D.find('users', x => x.id === query.get('id'));
  if (!u) return fail(res, 404, 'User not found');
  const kyc = D.find('kyc', k => k.userId === u.id);
  ok(res, {
    user: {
      id: u.id, email: u.email, name: u.name, role: u.role, banned: !!u.banned, joinedAt: u.joinedAt,
      lastLogin: u.lastLogin, country: u.country, phone: u.phone, dob: u.dob, experience: u.experience,
      sourceOfFunds: u.sourceOfFunds, referralCode: u.referralCode, newsletter: !!u.newsletter
    },
    kyc: kyc ? {
      status: kyc.status, reason: kyc.reason, idType: kyc.idType, submittedAt: kyc.submittedAt, reviewedAt: kyc.reviewedAt,
      details: kyc.details || null,
      docs: (kyc.docs || []).map(d => ({ id: d.id, kind: d.kind, origName: d.origName, mime: d.mime, size: d.size }))
    } : null,
    live: Object.assign(trading.equity(u.id, 'live'), { manualPnl: ((D.wallet(u.id, 'live', false) || {}).manualPnl) || 0 }),
    demo: Object.assign(trading.equity(u.id, 'demo'), { manualPnl: ((D.wallet(u.id, 'demo', false) || {}).manualPnl) || 0 }),
    positions: D.filter('positions', p => p.userId === u.id),
    orders: D.filter('orders', o => o.userId === u.id),
    trades: D.filter('trades', t => t.userId === u.id).sort((a, b) => b.at - a.at).slice(0, 50),
    transactions: D.filter('transactions', t => t.userId === u.id).sort((a, b) => b.createdAt - a.createdAt)
  });
};

api['POST /api/admin/kyc'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const kyc = D.find('kyc', k => k.userId === body.userId);
  if (!kyc) return fail(res, 404, 'No KYC submission found');
  const action = body.action === 'approve' ? 'approved' : 'rejected';
  kyc.status = action;
  kyc.reason = String(body.reason || '').slice(0, 500);
  kyc.reviewedAt = Date.now();
  kyc.reviewerId = admin.id;
  const u = D.find('users', x => x.id === body.userId);
  if (action === 'approved' && u) { gamify.grantBadge(u.id, 'kyc_verified'); gamify.addXP(u.id, 75, 'kyc-approved'); }
  D.save();
  D.logAudit(admin.id, 'kyc.' + action, body.userId, kyc.reason);
  if (u) {
    mailer.sendMail(action === 'approved'
      ? { to: u.email, subject: '✅ KYC verified — Blockchain Bullhorn', html: mailer.templates.kycApproved(u) }
      : { to: u.email, subject: 'KYC verification update — Blockchain Bullhorn', html: mailer.templates.kycRejected(u, kyc.reason) }
    ).catch(() => {});
  }
  ok(res, { message: `KYC ${action} for ${kyc.idType}` });
};

api['POST /api/admin/balance'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const amount = Number(body.amountUsd);
  if (!isFinite(amount) || amount === 0) return fail(res, 400, 'Enter a non-zero amount');
  const mode = body.mode === 'demo' ? 'demo' : 'live';
  const w = D.wallet(body.userId, mode, false);
  if (!w) return fail(res, 404, 'Wallet not found');
  if (w.usd + amount < 0) return fail(res, 400, 'Adjustment would make balance negative');
  w.usd = U.round(w.usd + amount);
  D.insert('transactions', {
    id: U.uid('tx_'), userId: body.userId, type: 'adjust', asset: 'USD', amountUsd: U.round(amount),
    status: 'completed', createdAt: Date.now(), updatedAt: Date.now(),
    note: body.note || `Admin adjustment by ${admin.email}`, adminId: admin.id
  });
  D.save();
  D.logAudit(admin.id, 'balance.adjust', body.userId, `${amount > 0 ? '+' : ''}${amount} ${mode} — ${body.note || ''}`);
  ok(res, { message: `Balance adjusted (${amount > 0 ? '+' : ''}$${U.round(amount)} ${mode}).`, newBalance: w.usd });
};

api['POST /api/admin/user-action'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const u = D.find('users', x => x.id === body.userId);
  if (!u) return fail(res, 404, 'User not found');
  if (u.id === admin.id && body.action !== 'unban') return fail(res, 400, 'You cannot perform this action on your own account.');
  switch (body.action) {
    case 'ban': u.banned = true; D.logAudit(admin.id, 'user.ban', u.id, body.reason || ''); break;
    case 'unban': u.banned = false; D.logAudit(admin.id, 'user.unban', u.id, ''); break;
    case 'make-admin': u.role = 'admin'; D.logAudit(admin.id, 'user.makeAdmin', u.id, ''); break;
    case 'revoke-admin': u.role = 'user'; D.logAudit(admin.id, 'user.revokeAdmin', u.id, ''); break;
    case 'forcelogout': {
      const before = D.db().sessions.length;
      D.db().sessions = D.db().sessions.filter(x => x.userId !== u.id);
      D.logAudit(admin.id, 'user.forceLogout', u.id, `${before - D.db().sessions.length} session(s) cleared`);
      break;
    }
    case 'reset-password': {
      const t = U.token(20);
      D.insert('resets', { token: t, userId: u.id, expiresAt: Date.now() + 3600 * 1000, used: false });
      mailer.sendMail({
        to: u.email, subject: '🔐 Password reset requested — Blockchain Bullhorn',
        html: mailer.templates.wrap('🔐 Password Reset',
          `A password reset was requested for your account by platform support. If this wasn't you, contact support immediately — your password is still unchanged.<br><br>The link below is valid for 1 hour.`,
          `/reset-password?token=${t}`, 'Choose a New Password')
      }).catch(() => {});
      D.logAudit(admin.id, 'user.resetPassword', u.id, 'reset link emailed');
      break;
    }
    case 'reset-demo': {
      const w = D.wallet(u.id, 'demo', true);
      const start = Number((D.db().settings || {}).demoStartBalance) || 10000;
      w.usd = U.round(start); w.manualPnl = 0;
      D.insert('transactions', { id: U.uid('tx_'), userId: u.id, type: 'adjust', asset: 'USD', amountUsd: 0, status: 'completed', createdAt: Date.now(), updatedAt: Date.now(), note: `Demo wallet reset to $${start} by admin`, adminId: admin.id });
      D.logAudit(admin.id, 'user.resetDemo', u.id, `demo reset to $${start}`);
      break;
    }
    case 'delete': {
      if (body.confirm !== u.email) return fail(res, 400, 'Type the user\'s exact email to confirm deletion.');
      const uid2 = u.id;
      D.db().users = D.db().users.filter(x => x.id !== uid2);
      D.db().sessions = D.db().sessions.filter(x => x.userId !== uid2);
      for (const coll of ['wallets','kyc','positions','orders','trades','transactions','community_apps','alerts','logins','emails','bot_requests','copy_allocations','resets','chats','messages']) {
        if (D.db()[coll]) D.db()[coll] = D.db()[coll].filter(x => x.userId !== uid2);
      }
      D.logAudit(admin.id, 'user.delete', uid2, u.email);
      D.save();
      return ok(res, { message: `User ${u.email} and all their records were deleted.` });
    }
    default: return fail(res, 400, 'Unknown action');
  }
  D.save();
  ok(res, { message: 'Action applied' });
};

// ---- super admin: manual P/L adjustment ----
api['POST /api/admin/pnl'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const amount = Number(body.amount);
  if (!isFinite(amount) || amount === 0) return fail(res, 400, 'Enter a non-zero P/L amount');
  const mode = body.mode === 'demo' ? 'demo' : 'live';
  const w = D.wallet(body.userId, mode, false);
  if (!w) return fail(res, 404, 'Wallet not found');
  w.manualPnl = U.round((w.manualPnl || 0) + amount);
  D.insert('transactions', {
    id: U.uid('tx_'), userId: body.userId, type: 'pnl_adjust', asset: 'USD', amountUsd: U.round(amount),
    status: 'completed', createdAt: Date.now(), updatedAt: Date.now(),
    note: body.note || `P/L adjusted by ${admin.email}`, adminId: admin.id
  });
  D.save();
  D.logAudit(admin.id, 'pnl.adjust', body.userId, `${amount > 0 ? '+' : ''}${amount} ${mode} — ${body.note || ''}`);
  ok(res, { message: `P/L adjusted (${amount > 0 ? '+' : ''}$${U.round(amount)} ${mode}).`, manualPnl: w.manualPnl });
};

// ---- super admin: email a user directly ----
api['POST /api/admin/user-email'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const u = D.find('users', x => x.id === body.userId);
  if (!u) return fail(res, 404, 'User not found');
  const subject = String(body.subject || '').trim().slice(0, 160);
  const message = String(body.message || '').trim().slice(0, 4000);
  if (!subject || !message) return fail(res, 400, 'Subject and message are required');
  const r = await mailer.sendMail({
    to: u.email, subject: subject + ' — Blockchain Bullhorn',
    html: mailer.templates.wrap('📩 Message from Blockchain Bullhorn', message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'))
  });
  D.logAudit(admin.id, 'user.email', u.id, subject);
  if (r.sent) ok(res, { message: 'Email sent to ' + u.email });
  else if (r.skipped) ok(res, { message: 'Email suppressed (test-domain recipient)' });
  else return fail(res, 502, 'Send failed: ' + (r.error || 'unknown'));
};

api['GET /api/admin/transactions'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const txs = D.db().transactions.slice().sort((a, b) => b.createdAt - a.createdAt).map(t => {
    const u = D.find('users', x => x.id === t.userId);
    return Object.assign({}, t, { userEmail: u ? u.email : 'deleted', userName: u ? u.name : '' });
  });
  ok(res, { transactions: txs });
};

api['POST /api/admin/tx'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const tx = D.find('transactions', t => t.id === body.txId);
  if (!tx || tx.status !== 'pending') return fail(res, 404, 'Pending transaction not found');
  if (body.action === 'approve') {
    if (tx.type === 'deposit') {
      D.creditWallet(tx.userId, 'live', tx.amountUsd);
      tx.status = 'completed';
    } else if (tx.type === 'withdraw') {
      tx.status = 'completed';
    } else if (tx.type === 'product') {
      tx.status = 'completed'; // product unlocked for the buyer
    }
    tx.adminNote = body.note || '';
    tx.updatedAt = Date.now();
    D.save();
    D.logAudit(admin.id, 'tx.approve', tx.id, `${tx.type} $${tx.amountUsd}`);
    const tu = D.find('users', x => x.id === tx.userId);
    if (tu) {
      const tpl = tx.type === 'deposit'
        ? { to: tu.email, subject: '💰 Deposit credited — Blockchain Bullhorn', html: mailer.templates.depositApproved(tu, tx.amountUsd, tx.asset) }
        : tx.type === 'product'
        ? { to: tu.email, subject: `📦 Purchase confirmed — ${tx.productName}`, html: mailer.templates.purchaseApproved(tu, tx.productName) }
        : { to: tu.email, subject: '📤 Withdrawal processed — Blockchain Bullhorn', html: mailer.templates.withdrawDone(tu, tx.amountUsd, tx.asset, tx.address || '') };
      mailer.sendMail(tpl).catch(() => {});
    }
    ok(res, { message: 'Transaction approved' });
  } else if (body.action === 'reject') {
    if (tx.type === 'withdraw') D.creditWallet(tx.userId, 'live', tx.amountUsd); // refund hold
    tx.status = 'rejected';
    tx.adminNote = body.note || '';
    tx.updatedAt = Date.now();
    D.save();
    D.logAudit(admin.id, 'tx.reject', tx.id, `${tx.type} $${tx.amountUsd} — ${body.note || ''}`);
    if (tx.type === 'withdraw') {
      const tu = D.find('users', x => x.id === tx.userId);
      if (tu) mailer.sendMail({ to: tu.email, subject: 'Withdrawal declined — Blockchain Bullhorn',
        html: mailer.templates.withdrawRejected(tu, tx.amountUsd, tx.adminNote) }).catch(() => {});
    } else if (tx.type === 'product') {
      const tu = D.find('users', x => x.id === tx.userId);
      if (tu) mailer.sendMail({ to: tu.email, subject: 'Purchase payment not verified — Blockchain Bullhorn',
        html: mailer.templates.purchaseRejected(tu, tx.productName, tx.adminNote) }).catch(() => {});
    }
    ok(res, { message: 'Transaction rejected' + (tx.type === 'withdraw' ? ' and funds returned to user wallet' : '') });
  } else fail(res, 400, 'Unknown action');
};

api['GET /api/admin/positions'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const positions = D.db().positions.map(p => {
    const u = D.find('users', x => x.id === p.userId);
    const price = markets.priceOf(p.assetId);
    return Object.assign({}, p, { userEmail: u ? u.email : 'deleted', currentPrice: price, pnl: U.round(trading.positionPnl(p, price)) });
  });
  const trades = D.db().trades.slice().sort((a, b) => b.at - a.at).slice(0, 200).map(t => {
    const u = D.find('users', x => x.id === t.userId);
    return Object.assign({}, t, { userEmail: u ? u.email : 'deleted' });
  });
  ok(res, { positions, trades });
};

api['GET /api/admin/chats'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const chats = D.db().chats.slice().sort((a, b) => b.lastMsgAt - a.lastMsgAt).map(c => {
    const last = D.filter('messages', m => m.convId === c.id).sort((a, b) => b.at - a.at)[0];
    return { id: c.id, name: c.name, email: c.email, userId: c.userId, unread: c.unreadAdmin, lastMsgAt: c.lastMsgAt, lastText: last ? last.text.slice(0, 80) : '' };
  });
  ok(res, { chats });
};

api['GET /api/admin/chat-messages'] = async (req, res, body, cookies, query) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const id = query.get('id');
  const conv = D.find('chats', c => c.id === id);
  if (!conv) return fail(res, 404, 'Conversation not found');
  conv.unreadAdmin = 0;
  D.save();
  const msgs = D.filter('messages', m => m.convId === id).sort((a, b) => a.at - b.at);
  ok(res, { messages: msgs, conv: { id: conv.id, name: conv.name, email: conv.email } });
};

api['POST /api/admin/chat-reply'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const text = String(body.text || '').trim().slice(0, 2000);
  if (!text) return fail(res, 400, 'Message is empty');
  const conv = D.find('chats', c => c.id === body.convId);
  if (!conv) return fail(res, 404, 'Conversation not found');
  D.insert('messages', { id: U.uid('m_'), convId: conv.id, from: 'admin', text, at: Date.now(), adminName: (admin.name || 'Support').split(' ')[0] });
  conv.lastMsgAt = Date.now();
  D.save();
  ok(res, {});
};

// ---- admin: community applications ----
api['GET /api/admin/community-apps'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const apps = D.db().community_apps.slice().sort((a, b) => b.appliedAt - a.appliedAt).map(a => {
    const u = D.find('users', x => x.id === a.userId);
    return {
      id: a.id, userId: a.userId, status: a.status, experience: a.experience, goals: a.goals,
      quizScore: a.quizScore, appliedAt: a.appliedAt, reviewedAt: a.reviewedAt, reason: a.reason,
      userName: u ? u.name : 'deleted', userEmail: u ? u.email : '', country: u ? u.country : '',
      kyc: (D.find('kyc', k => k.userId === a.userId) || { status: 'not_submitted' }).status
    };
  });
  ok(res, { apps });
};

api['POST /api/admin/community-app'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const app = D.find('community_apps', a => a.id === body.appId);
  if (!app) return fail(res, 404, 'Application not found');
  if (body.action !== 'approve' && body.action !== 'reject') return fail(res, 400, 'Unknown action');
  app.status = body.action === 'approve' ? 'approved' : 'rejected';
  app.reason = String(body.reason || '').slice(0, 400);
  app.reviewedAt = Date.now();
  if (app.status === 'approved') { gamify.grantBadge(app.userId, 'herd_member'); gamify.addXP(app.userId, 60, 'community'); }
  D.save();
  D.logAudit(admin.id, 'community.' + app.status, app.userId, app.reason);
  ok(res, { message: 'Application ' + app.status });
};

// ---- admin: copy trading management ----
api['GET /api/admin/copy'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const leaders = D.db().copy_leaders.slice().sort((a, b) => (b.approvedAt || 0) - (a.approvedAt || 0)).map(l => {
    const u = D.find('users', x => x.id === l.userId);
    return {
      id: l.id, userId: l.userId, status: l.status, title: l.title, style: l.style, description: l.description,
      userName: u ? u.name : 'deleted', userEmail: u ? u.email : '', avatar: l.avatar || '',
      minBalance: l.minBalance || 0, risk: l.risk || '',
      stats: trading.leaderStats(l), approvedAt: l.approvedAt
    };
  });
  const allocations = D.db().copy_allocations.filter(a => a.active).map(a => {
    const l = D.find('copy_leaders', x => x.id === a.leaderId);
    const u = D.find('users', x => x.id === a.userId);
    const lu = l ? D.find('users', x => x.id === l.userId) : null;
    return {
      id: a.id, mode: a.mode, allocated: a.allocated, equity: a.equity, startedAt: a.startedAt,
      userName: u ? u.name : 'deleted', userEmail: u ? u.email : '', leaderName: lu ? lu.name : 'unknown'
    };
  });
  const requests = D.db().bot_requests.slice().sort((a, b) => b.requestedAt - a.requestedAt).map(r => {
    const u = D.find('users', x => x.id === r.userId);
    const l = D.find('copy_leaders', x => x.id === r.leaderId);
    return {
      id: r.id, status: r.status, key: r.key, requestedAt: r.requestedAt, reviewedAt: r.reviewedAt,
      userName: u ? u.name : 'deleted', userEmail: u ? u.email : '',
      botName: l ? l.title : 'unknown bot', botMin: l ? l.minBalance : 0
    };
  });
  ok(res, { leaders, allocations, requests });
};

api['POST /api/admin/copy-leader'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const l = D.find('copy_leaders', x => x.id === body.leaderId);
  if (!l) return fail(res, 404, 'Leader record not found');
  const action = body.action;
  if (!['approve', 'reject', 'suspend', 'activate'].includes(action)) return fail(res, 400, 'Unknown action');
  if (action === 'approve' || action === 'activate') {
    l.status = 'active';
    l.approvedAt = Date.now();
  } else if (action === 'reject') l.status = 'rejected';
  else if (action === 'suspend') l.status = 'suspended';
  D.save();
  D.logAudit(admin.id, 'copyleader.' + action, l.userId, l.title);
  ok(res, { message: 'Leader updated' });
};

api['POST /api/admin/bot-key'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const r = D.find('bot_requests', x => x.id === body.requestId);
  if (!r || r.status !== 'pending') return fail(res, 404, 'Pending key request not found');
  const l = D.find('copy_leaders', x => x.id === r.leaderId);
  const u = D.find('users', x => x.id === r.userId);
  if (body.action === 'approve') {
    r.status = 'approved';
    r.key = 'BB-' + Math.random().toString(36).slice(2, 6).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    r.reviewedAt = Date.now();
    D.save();
    D.logAudit(admin.id, 'botkey.approve', r.userId, (l ? l.title : '') + ' key ' + r.key);
    if (u && l) mailer.sendMail({ to: u.email, subject: `\u{1F511} Connection key approved — ${l.title}`, html: mailer.templates.botKeyApproved(u, l.title, r.key) }).catch(() => {});
    ok(res, { message: 'Key issued and emailed to the user', key: r.key });
  } else if (body.action === 'reject') {
    r.status = 'rejected';
    r.reviewedAt = Date.now();
    D.save();
    D.logAudit(admin.id, 'botkey.reject', r.userId, l ? l.title : '');
    if (u) mailer.sendMail({ to: u.email, subject: 'Connection key request declined — Blockchain Bullhorn', html: mailer.templates.botKeyRejected(u, l ? l.title : 'the bot') }).catch(() => {});
    ok(res, { message: 'Key request rejected' });
  } else fail(res, 400, 'Unknown action');
};

api['GET /api/admin/settings'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  ok(res, { settings: D.db().settings });
};
api['POST /api/admin/settings'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const s = D.db().settings;
  const b = body.settings || {};
  if (Array.isArray(b.announcements)) {
    s.announcements = b.announcements.map(x => String(x || '').trim().slice(0, 300)).filter(Boolean).slice(0, 20);
  }
  if (typeof b.smartsuppKey === 'string') {
    let k = b.smartsuppKey.trim();
    // tolerate the full Smartsupp embed snippet being pasted: extract the key
    const m = k.match(/_smartsupp\.key\s*=\s*['"]([a-zA-Z0-9]+)['"]/) || k.match(/smartsupp\(\s*['"]key['"]\s*,\s*['"]([a-zA-Z0-9]+)['"]/) || k.match(/data-key\s*=\s*['"]([a-zA-Z0-9]+)['"]/);
    if (m) k = m[1];
    if (!/^[a-zA-Z0-9]{0,100}$/.test(k)) k = ''; // keys are alphanumeric only
    s.smartsuppKey = k;
  }
  if (b.depositAddresses && typeof b.depositAddresses === 'object') {
    for (const k of Object.keys(s.depositAddresses)) {
      if (typeof b.depositAddresses[k] === 'string') s.depositAddresses[k] = b.depositAddresses[k].trim().slice(0, 120);
    }
  }
  if (b.productPaymentAddresses && typeof b.productPaymentAddresses === 'object') {
    for (const k of Object.keys(s.productPaymentAddresses)) {
      if (typeof b.productPaymentAddresses[k] === 'string') s.productPaymentAddresses[k] = b.productPaymentAddresses[k].trim().slice(0, 120);
    }
  }
  if (isFinite(Number(b.demoStartBalance))) s.demoStartBalance = Math.max(100, Math.min(1000000, Number(b.demoStartBalance)));
  if (isFinite(Number(b.minDeposit))) s.minDeposit = Math.max(1, Number(b.minDeposit));
  if (isFinite(Number(b.minWithdraw))) s.minWithdraw = Math.max(1, Number(b.minWithdraw));
  if (typeof b.supportEmail === 'string') s.supportEmail = b.supportEmail.trim().slice(0, 120);
  if (typeof b.siteUrl === 'string') s.siteUrl = b.siteUrl.trim().slice(0, 200);
  if (b.contest && typeof b.contest === 'object') {
    s.contest = s.contest || { enabled: true, prize: '' };
    s.contest.enabled = !!b.contest.enabled;
    s.contest.prize = String(b.contest.prize || '').slice(0, 300);
  }
  if (b.email && typeof b.email === 'object') {
    s.email = s.email || { transport: 'smtp', sendgridKey: '', relayUrl: '', relaySecret: '' };
    if (typeof b.email.transport === 'string' && ['smtp', 'sendgrid', 'relay'].includes(b.email.transport)) s.email.transport = b.email.transport;
    for (const k of ['sendgridKey', 'relayUrl', 'relaySecret']) {
      if (typeof b.email[k] === 'string') s.email[k] = b.email[k].trim().slice(0, 500);
    }
  }
  if (b.smtp && typeof b.smtp === 'object') {
    s.smtp = s.smtp || { host: '', port: 587, user: '', pass: '', from: '' };
    if (typeof b.smtp.host === 'string') s.smtp.host = b.smtp.host.trim().slice(0, 200);
    if (isFinite(Number(b.smtp.port))) s.smtp.port = Math.max(1, Math.min(65535, Number(b.smtp.port)));
    if (typeof b.smtp.user === 'string') s.smtp.user = b.smtp.user.trim().slice(0, 200);
    if (typeof b.smtp.pass === 'string') s.smtp.pass = b.smtp.pass.slice(0, 200);
    if (typeof b.smtp.from === 'string') s.smtp.from = b.smtp.from.trim().slice(0, 200);
  }
  D.save();
  D.logAudit(admin.id, 'settings.update', '', '');
  ok(res, { message: 'Settings saved', settings: s });
};

api['GET /api/admin/emails'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const emails = D.db().emails.slice().sort((a, b) => b.at - a.at).slice(0, 150);
  ok(res, { emails });
};

api['POST /api/admin/test-email'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const to = String(body.to || admin.email).trim();
  const r = await mailer.sendMail({ to, subject: 'Blockchain Bullhorn — test email',
    html: mailer.templates.wrap('✉️ Test Email', 'Great news — your SMTP settings work! Transactional emails (KYC updates, deposits, withdrawals, security alerts) will now reach your traders\' inboxes.') });
  if (r.skipped) return fail(res, 400, /test-domain/i.test(r.reason || '') || /Test-domain/.test(r.error || '')
    ? 'Not sent: ' + to + ' is a reserved test-domain address (no real inbox). Try a real address.'
    : 'No transport is configured. Set up Email Delivery (relay, SendGrid or SMTP) in Settings first.');
  if (!r.sent) return fail(res, 502, 'Send failed: ' + (r.error || 'unknown error'));
  ok(res, { message: 'Test email sent to ' + to });
};

api['GET /api/admin/audit'] = async (req, res, body, cookies) => {
  const admin = requireAdmin(req, res, cookies); if (!admin) return;
  const audit = D.db().audit.slice().sort((a, b) => b.at - a.at).slice(0, 300).map(a => {
    const u = D.find('users', x => x.id === a.adminId);
    return Object.assign({}, a, { adminEmail: u ? u.email : '' });
  });
  ok(res, { audit });
};

// ---------------- Deposit proof serving (admin only, binary) ----------------
function serveProofFile(req, res, cookies, query) {
  const admin = Auth.userFromRequest(req, cookies);
  if (!admin || admin.role !== 'admin') return fail(res, 403, 'Admin access required.');
  const tx = D.find('transactions', t => t.id === query.get('id'));
  if (!tx || !tx.proof) return fail(res, 404, 'No proof file on this transaction.');
  const p = path.join(D.UPLOAD_DIR, tx.userId, tx.proof.file);
  if (fs.existsSync(p)) return serveFile(res, p);
  fail(res, 404, 'Proof file not found');
}

// ---------------- KYC file serving (admin only, binary) ----------------
function serveKycFile(req, res, cookies, query) {
  const admin = Auth.userFromRequest(req, cookies);
  if (!admin || admin.role !== 'admin') return fail(res, 403, 'Admin access required.');
  const docId = query.get('id');
  for (const k of D.db().kyc) {
    const doc = (k.docs || []).find(d => d.id === docId);
    if (doc) {
      const p = path.join(D.UPLOAD_DIR, k.userId, doc.file);
      if (fs.existsSync(p)) return serveFile(res, p);
    }
  }
  fail(res, 404, 'Document not found');
}

// ---------------- request router ----------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    const cookies = U.parseCookies(req);

    // ---- API ----
    if (pathname.startsWith('/api/')) {
      // admin binary file route
      if (req.method === 'GET' && pathname === '/api/admin/kyc-file') return serveKycFile(req, res, cookies, url.searchParams);
    if (req.method === 'GET' && pathname === '/api/admin/proof') return serveProofFile(req, res, cookies, url.searchParams);

      const key = `${req.method} ${pathname}`;
      const handler = api[key];
      if (!handler) return fail(res, 404, 'Unknown API endpoint');
      let body = {};
      if (req.method === 'POST') {
        try { body = await U.readBody(req); }
        catch (e) { return fail(res, 400, e.message === 'Payload too large' ? 'Upload too large (max 8MB)' : 'Invalid request body'); }
      } else if (req.method === 'GET') {
        body = Object.fromEntries(url.searchParams.entries());
      }
      return await handler(req, res, body, cookies, url.searchParams);
    }

    // ---- static assets ----
    if (pathname.startsWith('/assets/')) {
      const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      const fp = path.join(PUBLIC_DIR, safe);
      if (!fp.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return serveFile(res, fp);
      return fail(res, 404, 'Not found');
    }
    if (pathname === '/sw.js') return serveFile(res, page('sw.js'));
    if (pathname === '/favicon.ico') return serveFile(res, page('favicon.ico'));
    if (pathname === '/favicon.png') return serveFile(res, page('assets/img/favicon-64.png'));
    if (pathname === '/apple-touch-icon.png') return serveFile(res, page('assets/img/apple-touch-icon.png'));
    if (pathname === '/manifest.webmanifest') return serveFile(res, page('manifest.webmanifest'));
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\nSitemap: https://blockchainbullhorn.onrender.com/sitemap.xml\n');
    }
    if (pathname === '/sitemap.xml') return serveFile(res, page('sitemap.xml'));

    // ---- pages ----
    if (pathname === '/copy-trading') { // legacy URL → Trading Bots
      res.writeHead(302, { Location: '/trading-bots' });
      return res.end();
    }
    const pageName = ROUTES[pathname];
    if (pageName) return serveFile(res, page(pageName));
    if (pathname.endsWith('.html')) {
      const fp = path.join(PUBLIC_DIR, path.basename(pathname));
      if (fs.existsSync(fp)) return serveFile(res, fp);
    }
    return serveFile(res, page('404.html'), 404);
  } catch (e) {
    console.error('[server]', req.method, req.url, e);
    try { fail(res, 500, 'Internal server error'); } catch (_) {}
  }
});

(async () => {
  // restore data/ from the GitHub backup first (ephemeral hosts), then serve
  await D.init();
  Backup.start();
  markets.start().catch(() => {});
  bots.start();
  server.listen(PORT, HOST, () => {
    console.log(`Blockchain Bullhorn server running at http://localhost:${PORT} (bound ${HOST})`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
  });
})().catch(e => { console.error('Boot failed:', e); process.exit(1); });
