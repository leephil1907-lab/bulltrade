'use strict';
/**
 * Blockchain Bullhorn — lightweight JSON file database.
 * Collections are plain arrays / objects; every mutation calls db.save()
 * (debounced + atomic write) so data survives restarts.
 */
const fs = require('fs');
const path = require('path');
const Backup = require('./backup');
const { uid, now, hashPassword } = require('./utils');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DEFAULTS = () => ({
  users: [],            // {id,email,passwordHash,name,firstName,lastName,dob,country,phone,experience,sourceOfFunds,role,joinedAt,lastLogin,banned,profile:{avatarColor},referralCode,referredBy,newsletter}
  sessions: [],         // {token(sid),userId,createdAt,expiresAt}
  wallets: [],          // {userId,mode,usd}  mode: live|demo
  kyc: [],              // {id,userId,status:'pending'|'approved'|'rejected',idType,docs:[{id,kind,file,origName,mime,size}],submittedAt,reviewedAt,reviewerId,reason}
  positions: [],        // open positions (incl. mirrored copy positions: copyOf, allocId)
  orders: [],           // open limit orders
  trades: [],           // closed/executed trade log
  transactions: [],     // deposits/withdrawals/adjustments/demo top-ups
  chats: [],            // support conversations
  messages: [],         // chat messages
  resets: [],           // password reset tokens
  community_apps: [],   // {id,userId,status:'pending'|'approved'|'rejected',experience,goals,quizScore,rulesAccepted,appliedAt,reviewedAt,reason}
  alerts: [],           // {id,userId,assetId,symbol,dir:'above'|'below',target,status:'active'|'triggered',createdAt,triggeredAt,triggeredPrice,seen}
  logins: [],           // {id,userId,at,ip,ua,deviceKey,newDevice}
  emails: [],           // outbox journal {id,to,subject,status,error,at}
  copy_leaders: [],     // {id,userId,status:'pending'|'active'|'suspended',title,style,description,approvedAt}
  bot_requests: [],     // {id,userId,leaderId,status:'pending'|'approved'|'rejected',key,requestedAt,reviewedAt} — trading-bot connection keys
  push_subs: [],        // web-push subscriptions {id,userId,endpoint,keys:{p256dh,auth},createdAt}
  // settings.announcements: string[] — live-feed announcement bar (admin-managed)
  copy_allocations: [], // {id,userId,leaderId,mode,allocated,equity,active,startedAt,stoppedAt}
  audit: [],            // admin audit trail
  settings: {
    siteName: 'Blockchain Bullhorn',
    smartsuppKey: '',
    announcement: { enabled: false, text: '' },
    depositAddresses: {
      USDT: '',
      'USDT-ERC20': '',
      BTC: '',
      ETH: '',
      SOL: '',
      BNB: '',
      XRP: '',
      LTC: '',
      DOGE: '',
      TRX: '',
      ZEC: ''
    },
    // dedicated wallet for PRODUCT purchases (USDT ERC-20 only)
    productPaymentAddresses: { 'USDT-ERC20': '' },
    demoStartBalance: 10000,
    minDeposit: 50,
    minWithdraw: 20,
    supportEmail: 'blockchainbullhornfaqs@gmail.com',
    contest: { enabled: true, prize: '🥇 1st: $200 live credit · 🥈 2nd: $100 · 🥉 3rd: $50' },
    smtp: { host: '', port: 587, user: '', pass: '', from: '' }
  }
});

let state = null;
let saveTimer = null;

function load() {
  try {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    const d = DEFAULTS();
    for (const k of Object.keys(d)) if (state[k] === undefined) state[k] = d[k];
    for (const k of Object.keys(d.settings)) if (state.settings[k] === undefined) state.settings[k] = d.settings[k];
    // merge new deposit coins into an existing settings object
    for (const k of Object.keys(d.settings.depositAddresses)) {
      if (state.settings.depositAddresses[k] === undefined) state.settings.depositAddresses[k] = d.settings.depositAddresses[k];
    }
    for (const k of ['contest', 'smtp']) {
      if (state.settings[k] === undefined) state.settings[k] = d.settings[k];
      else state.settings[k] = Object.assign({}, d.settings[k], state.settings[k]);
    }
  } catch (e) {
    state = DEFAULTS();
  }
  // ensure admin account (credentials from env, or a random password printed once)
  if (!state.users.some(u => u.role === 'admin')) {
    const email = (process.env.ADMIN_EMAIL || 'admin@blockchainbullhorn.com').toLowerCase();
    const pw = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(12).toString('base64url');
    const admin = {
      id: uid('u_'), email,
      passwordHash: hashPassword(pw),
      name: 'Platform Administrator', role: 'admin', banned: false,
      joinedAt: now(), lastLogin: 0, referralCode: 'BB-ADMIN', country: 'United States'
    };
    state.users.push(admin);
    console.log(`[db] Seeded admin account: ${email}`);
    console.log(process.env.ADMIN_PASSWORD
      ? '[db] Admin password taken from ADMIN_PASSWORD env variable.'
      : `[db] Generated admin password (SAVE IT NOW / change after first login): ${pw}`);
  }
  if (!state.settings.seededTeam) seedTeam();
  migrateToBots();
  migrateBotsV3();
  save(true);
}

/** Seed the community team + copy-trading leaders with a demo track record (once). */
function seedTeam() {
  const mk = (name, email) => {
    const u = {
      id: uid('u_'), email, passwordHash: hashPassword(uid('x') + uid('y')), // random, unknown password
      name, role: 'user', banned: false, joinedAt: now() - 90 * 86400000, lastLogin: now() - 86400000,
      referralCode: 'BB-' + name.split(' ')[0].slice(0, 4).toUpperCase(), country: 'United States',
      avatarColor: '#d3a877', seeded: true
    };
    state.users.push(u);
    state.wallets.push({ userId: u.id, mode: 'demo', usd: 10000 });
    state.wallets.push({ userId: u.id, mode: 'live', usd: 0 });
    return u;
  };
  const calvin = mk('Calvin Hill', 'calvin.hill@blockchainbullhorn.com');
  const maya = mk('Maya Osei', 'maya.osei@blockchainbullhorn.com');
  const diego = mk('Diego Ramirez', 'diego.ramirez@blockchainbullhorn.com');
  const aiko = mk('Aiko Tanaka', 'aiko.tanaka@blockchainbullhorn.com');

  state.settings.seededTeam = true;
  console.log('[db] Seeded community team with demo track records');
}

/** The four platform TRADING BOTS (replace human copy leaders). */
const BOT_DEFS = [
  {
    key: 'scout', name: 'Bull Scout', email: 'bot.scout@blockchainbullhorn.com', emoji: '\u{1F916}', color: '#2E91FC',
    minBalance: 2500, risk: 'Low', title: 'Conservative Momentum Scout', style: 'Systematic',
    description: 'Entry-level bot for smaller portfolios. Scouts steady 24h momentum on BTC, ETH and majors, takes small positions with tight stop-losses and low leverage. Patient, selective, capital-preservation first.',
    avatar: '/assets/img/bots/scout.png',
    universe: ['cg-bitcoin', 'cg-ethereum', 'cg-solana', 'cg-ripple', 'cg-dogecoin', 'cg-chainlink'],
    params: { lev: 2, sizePct: 12, maxPos: 2, momo: 2.5, tpPct: 2.2, slPct: 1.4, cdMin: 4, cdMax: 7 }, winBias: 0.58
  },
  {
    key: 'golden', name: 'Golden Horn', email: 'bot.golden@blockchainbullhorn.com', emoji: '\u{1F947}', color: '#d3a877',
    minBalance: 5000, risk: 'Medium', title: 'Gold & Commodity Swing Engine', style: 'Swing / Position',
    description: 'Specialist bot for the hard-asset aisle: PAX Gold, silver, oil and energy. Slower swing entries on gold/commodity momentum, wider targets, disciplined invalidation. Diversifies a crypto-heavy book.',
    avatar: '/assets/img/bots/golden.png',
    universe: ['cg-pax-gold', 'yh-XAU', 'yh-XAG', 'yh-WTI', 'yh-BRENT'],
    params: { lev: 3, sizePct: 15, maxPos: 3, momo: 1.2, tpPct: 3.5, slPct: 2.0, cdMin: 6, cdMax: 10 }, winBias: 0.55
  },
  {
    key: 'cmf', name: 'CMF Engine', email: 'bot.cmf@blockchainbullhorn.com', emoji: '\u{2699}\u{FE0F}', color: '#1ba94b',
    minBalance: 10000, risk: 'Medium-High', title: 'Compounding Machine (CMF Strategy)', style: 'Systematic',
    description: 'The platform\u2019s flagship compounding engine — built from the Crypto Multiplier Framework. Rides confirmed trends across majors and mega-cap tech, compounds gains with structured position sizing and strict per-trade risk.',
    avatar: '/assets/img/bots/cmf.png',
    universe: ['cg-bitcoin', 'cg-ethereum', 'cg-chainlink', 'yh-AAPL', 'yh-NVDA'],
    params: { lev: 3, sizePct: 18, maxPos: 3, momo: 1.8, tpPct: 4.0, slPct: 2.2, cdMin: 5, cdMax: 8 }, winBias: 0.62
  },
  {
    key: 'apex', name: 'Apex Bull', email: 'bot.apex@blockchainbullhorn.com', emoji: '\u{1F402}', color: '#e0324b',
    minBalance: 15000, risk: 'High', title: 'Aggressive Momentum Bull', style: 'Momentum',
    description: 'High-velocity bot for large portfolios. Hunts explosive 24h movers with higher leverage and bigger size, taking profit fast. High reward, high drawdown — size your allocation accordingly.',
    avatar: '/assets/img/bots/apex.png',
    universe: ['cg-solana', 'cg-dogecoin', 'cg-bitcoin', 'cg-ethereum'],
    params: { lev: 5, sizePct: 22, maxPos: 4, momo: 4.0, tpPct: 6.0, slPct: 3.0, cdMin: 3, cdMax: 6 }, winBias: 0.50
  }
];

/** Seed the trading bots (users + leader records + demo track records). */
function seedBots() {
  for (const b of BOT_DEFS) {
    if (state.users.some(u => u.email === b.email)) continue;
    const u = {
      id: uid('u_'), email: b.email,
      passwordHash: hashPassword(uid('x') + uid('y')), // random, unknown password
      name: b.name + ' Bot', role: 'user', banned: false, isBot: true, botKey: b.key,
      joinedAt: now() - 90 * 86400000, lastLogin: 0, referralCode: 'BB-BOT-' + b.key.toUpperCase().slice(0, 3),
      country: 'United States', avatarColor: b.color, botEmoji: b.emoji, seeded: true
    };
    state.users.push(u);
    state.wallets.push({ userId: u.id, mode: 'demo', usd: 10000 });
    state.wallets.push({ userId: u.id, mode: 'live', usd: 50000 });
    state.copy_leaders.push({
      id: uid('cl_'), userId: u.id, status: 'active', bot: true, emoji: b.emoji, avatar: b.avatar,
      minBalance: b.minBalance, risk: b.risk, title: b.title, style: b.style, description: b.description,
      universe: b.universe, params: b.params, approvedAt: now() - 60 * 86400000, seeded: true
    });
    seedTrackRecord(u.id, b.winBias);
  }
  console.log('[db] Seeded 4 trading bots (Scout / Golden Horn / CMF / Apex)');
}

/** v3 migration: updated min balances + generated avatars for existing bots. */
function migrateBotsV3() {
  if (state.settings.botsV3) return;
  for (const b of BOT_DEFS) {
    const u = state.users.find(x => x.botKey === b.key);
    if (!u) continue;
    const l = state.copy_leaders.find(x => x.userId === u.id);
    if (l) { l.minBalance = b.minBalance; l.avatar = b.avatar; l.emoji = b.emoji; }
  }
  state.settings.botsV3 = true;
  console.log('[db] Bot minimum balances updated (Scout $2.5k / Golden $5k / CMF $10k / Apex $15k) + avatars');
}

/** One-time migration: replace human copy leaders with trading bots. */
function migrateToBots() {
  if (state.settings.botsV2) return;
  // refund active allocations (close mirrors at cost, return allocated funds)
  for (const a of state.copy_allocations.filter(x => x.active)) {
    state.positions = state.positions.filter(p => p.allocId !== a.id);
    creditWallet(a.userId, a.mode, a.allocated);
  }
  state.copy_allocations = [];
  state.copy_leaders = state.copy_leaders.filter(l => l.bot);
  seedBots();
  state.settings.botsV2 = true;
  console.log('[db] Migrated copy-trading leaders \u2192 trading bots');
}

function seedTrackRecord(userId, winBias) {
  const ASSETS = [
    ['cg-bitcoin', 'BTC', 'Bitcoin'], ['cg-ethereum', 'ETH', 'Ethereum'], ['cg-solana', 'SOL', 'Solana'],
    ['cg-ripple', 'XRP', 'XRP'], ['cg-dogecoin', 'DOGE', 'Dogecoin'], ['cg-chainlink', 'LINK', 'Chainlink'],
    ['cg-pax-gold', 'PAXG', 'PAX Gold'], ['yh-AAPL', 'AAPL', 'Apple Inc.'], ['yh-NVDA', 'NVDA', 'NVIDIA Corp.']
  ];
  const n = 26 + Math.floor(Math.random() * 14);
  let t = now() - 35 * 86400000;
  for (let i = 0; i < n; i++) {
    t += Math.random() * 30 * 3600 * 1000;
    if (t > now() - 3600 * 1000) break;
    const [assetId, symbol, name] = ASSETS[Math.floor(Math.random() * ASSETS.length)];
    const side = Math.random() > 0.42 ? 'buy' : 'sell';
    const notional = 300 + Math.random() * 2400;
    const leverage = 1 + Math.floor(Math.random() * 4);
    const margin = notional / leverage;
    const price = assetId.startsWith('yh-') ? 100 + Math.random() * 400 : (assetId === 'cg-bitcoin' ? 40000 + Math.random() * 40000 : 50 + Math.random() * 3000);
    const win = Math.random() < winBias;
    const pnlPct = win ? 0.02 + Math.random() * 0.16 : -(0.02 + Math.random() * 0.10);
    const pnl = margin * leverage * pnlPct * 0.5;
    const exit = side === 'buy' ? price * (1 + pnl / notional) : price * (1 - pnl / notional);
    const fee = notional * 0.001 * 2;
    state.trades.push({
      id: uid('t_'), userId, mode: 'demo', assetId, symbol, name, side, type: 'market',
      qty: notional / price, price, notional: Math.round(notional * 100) / 100, fee,
      leverage, at: t, action: 'open', pnl: 0, seeded: true
    });
    state.trades.push({
      id: uid('t_'), userId, mode: 'demo', assetId, symbol, name,
      side: side === 'buy' ? 'sell' : 'buy', type: 'market', qty: notional / price, price: exit,
      notional: Math.round(notional * 100) / 100, fee, leverage, at: t + (2 + Math.random() * 40) * 3600 * 1000,
      action: 'close', reason: win ? 'take-profit' : 'stop-loss',
      pnl: Math.round((pnl - fee) * 100) / 100, entry: price, margin: Math.round(margin * 100) / 100,
      liquidated: false, seeded: true
    });
  }
}

function save(immediate) {
  if (!state) return; // nothing loaded yet — never write a null database
  if (immediate) { flush(); return; }
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 250);
}
function flush() {
  if (!state) return; // nothing loaded yet — never write a null database
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DB_FILE);
    Backup.markDirty(); // GitHub data-sync (no-op unless BACKUP_REPO is set)
  } catch (e) { console.error('[db] save failed', e.message); }
}

/** Local database intact? (missing or corrupt → false) */
function dbIntact() {
  try {
    if (!fs.existsSync(DB_FILE)) return false;
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return !!(parsed && Array.isArray(parsed.users));
  } catch (e) { return false; }
}

/** Call once at boot (server.js): restores data from the GitHub backup
 *  when running on an ephemeral host with an empty/corrupt data directory. */
async function init() {
  if (state) return;
  if (Backup.enabled && !dbIntact()) {
    console.log('[backup] no local database — restoring from GitHub backup…');
    try { await Backup.restore(); } catch (e) { console.error('[backup] restore failed:', e.message); }
  }
  load();
}

function db() { if (!state) load(); return state; }

// ---- collection helpers ----
function find(col, fn) { return db()[col].find(fn); }
function filter(col, fn) { return db()[col].filter(fn); }
function insert(col, doc) { db()[col].push(doc); save(); return doc; }
function update(col, fn, patch) {
  const doc = db()[col].find(fn);
  if (!doc) return null;
  Object.assign(doc, patch);
  save();
  return doc;
}
function remove(col, fn) {
  const d = db();
  const before = d[col].length;
  d[col] = d[col].filter(x => !fn(x));
  save();
  return before - d[col].length;
}

// wallet helpers
function wallet(userId, mode, create = true) {
  let w = find('wallets', x => x.userId === userId && x.mode === mode);
  if (!w && create) { w = insert('wallets', { userId, mode, usd: 0 }); }
  return w;
}
function creditWallet(userId, mode, amount) {
  const w = wallet(userId, mode);
  w.usd = Math.round((w.usd + amount) * 100) / 100;
  save();
  return w;
}

function logAudit(adminId, action, target, detail) {
  insert('audit', { id: uid('a_'), adminId, action, target, detail: detail || '', at: now() });
}

process.on('exit', () => { try { flush(); } catch (e) {} });

module.exports = { db, load, save, flush, init, find, filter, insert, update, remove, wallet, creditWallet, logAudit, UPLOAD_DIR, DB_FILE, DEFAULTS };
