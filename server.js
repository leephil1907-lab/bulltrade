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
const HubSpot = require('./lib/hubspot');

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
    let body = buf;
    if (ext === '.html') {
      const html = buf.toString('utf8');
      body = Buffer.from(html.replace('</head>', '  <link rel="stylesheet" href="/assets/css/premium.css?v=1">\n</head>'));
    }
    const cache = ['.woff2', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.svg'].includes(ext) ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(code, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(body);
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

function healthSnapshot() {
  const db = D.db();
  return {
    service: 'bulltrade',
    ok: true,
    uptime: Math.round(process.uptime()),
    time: new Date().toISOString(),
    database: { users: db.users.length, ledgerEntries: db.ledger.length },
    markets: { lastRefresh: markets.lastRefresh || 0, assets: markets.ASSETS.length },
    trading: db.settings.trading || {}
  };
}


function requireUser(req, res, cookies, optional) {
  const user = Auth.userFromRequest(req, cookies);
  if (!user) { if (!optional) fail(res, 401, 'Please log in to continue.'); return null; }
  return user;
}
function requireAdmin(req, res, cookies) {
  const user = Auth.userFromRequest(req, cookies);  if (!user || user.role !== 'admin') { fail(res, 403, 'Admin access required.'); return null; }
  return user;
}

// KYC gate — accounts can be created and browsed without verification (Verify Later),
// but live trading, trading bots and money transactions stay locked until approved
function kycApproved(user) {
  const k = D.find('kyc', x => x.userId === user.id);
  return !!k && k.status === 'approved';
}
function requireKyc(res, user, what) {
  if (kycApproved(user)) return true;
  fail(res, 403, `KYC verification is required before you can ${what}. Verify your identity once — it takes about 2 minutes — and live trading, bots and transactions unlock.`, { kycRequired: true });
  return false;
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
  if (HubSpot.enabled()) {
    HubSpot.syncContact(result.user, { lifecyclestage: 'lead', hs_lead_status: kycStatus }).catch(() => {});
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