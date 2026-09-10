/* ============================================================
   Blockchain Bullhorn — shared frontend runtime
   (header/footer, live ticker, chat widget, auth state, utils)
   ============================================================ */
'use strict';

// ---------- tiny helpers ----------
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

window.BB = {
  user: null,
  settings: { smartsuppKey: '', announcement: { enabled: false, text: '' }, chatOnline: true },

  fmtPrice(p) {
    if (p == null) return '—';
    if (p >= 1000) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (p >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    if (p >= 0.01) return p.toFixed(4);
    return p.toPrecision(4);
  },
  fmtUSD(n, d = 2) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  fmtPct(p) {
    if (p == null || isNaN(p)) return '—';
    return (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
  },
  fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  },
  timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  },
  chgClass(p) { return p >= 0 ? 'up' : 'down'; },
  chgIcon(p) { return p >= 0 ? '▲' : '▼'; },

  async api(path, opts = {}) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    }, opts, { body: opts.body ? JSON.stringify(opts.body) : undefined }));
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (res.status === 401 && !opts.silent) {
      const here = location.pathname + location.search;
      if (!/\/(login|signup|forgot-password|reset-password)/.test(here)) {
        location.href = '/login?next=' + encodeURIComponent(here);
      }
    }
    data._status = res.status;
    return data;
  },

  toast(msg, type = '') {
    let wrap = $('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 320); }, 4200);
  },

  modal(title, bodyHTML, footHTML) {
    const bd = document.createElement('div');
    bd.className = 'modal-backdrop open';
    bd.innerHTML = `<div class="modal"><div class="modal-head"><h3>${title}</h3>
      <button class="modal-close" aria-label="Close">&times;</button></div>
      <div class="modal-body">${bodyHTML}${footHTML || ''}</div></div>`;
    document.body.appendChild(bd);
    bd.addEventListener('click', e => { if (e.target === bd || e.target.classList.contains('modal-close')) bd.remove(); });
    return bd;
  },

  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  sparkline(points, w = 108, h = 34) {
    if (!points || points.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
    const min = Math.min(...points), max = Math.max(...points), span = (max - min) || 1;
    const up = points[points.length - 1] >= points[0];
    const color = up ? '#1ba94b' : '#e0324b';
    const stepX = w / (points.length - 1);
    const pts = points.map((p, i) => `${(i * stepX).toFixed(1)},${(h - 3 - ((p - min) / span) * (h - 6)).toFixed(1)}`).join(' ');
    const area = `0,${h} ${pts} ${w},${h}`;
    const gid = 'g' + Math.random().toString(36).slice(2, 8);
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".32"/><stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${area}" fill="url(#${gid})"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round"/>
    </svg>`;
  },

  assetIcon(a, size = 30) {
    if (a.logo) return `<img class="a-logo" src="${a.logo}" alt="${BB.esc(a.symbol)}" loading="lazy" style="width:${size}px;height:${size}px">`;
    const icons = {
      'rwa-xau': '🥇', 'rwa-xag': '🥈', 'rwa-xpt': '⚪', 'rwa-xpd': '🔘', 'rwa-hg': '🔶',
      'rwa-wti': '🛢️', 'rwa-brent': '⛽', 'rwa-ng': '🔥',
      'idx-spx': '📊', 'idx-ndx': '📈', 'idx-dji': '🏛️', 'idx-rut': '📉'
    };
    return `<div class="a-icon" style="width:${size}px;height:${size}px">${icons[a.icon] || '💠'}</div>`;
  }
};

// ---------- header / footer ----------
const NAV_LINKS = [
  ['/markets', 'Markets'], ['/trade', 'Trading'], ['/copy-trading', 'Copy Trading'],
  ['/community', 'Community'], ['/store', 'Products'], ['/mentorship', 'Mentorship'],
  ['/faq', 'FAQ'], ['/contact', 'Contact']
];

function renderHeader() {
  const el = $('#site-header'); if (!el) return;
  const here = location.pathname;
  const links = NAV_LINKS.map(([href, label]) =>
    `<a href="${href}" class="${here === href ? 'active' : ''}">${label}</a>`).join('');
  el.innerHTML = `
  <div class="announce" id="announce"></div>
  <div class="container-wide header-inner">
    <a class="brand" href="/">
      <img src="/assets/img/brand/logo.png" alt="Blockchain Bullhorn logo">
      <div class="brand-name">Blockchain <span>Bullhorn</span><small>Grab the Bull by the Horns</small></div>
    </a>
    <button class="nav-toggle" id="navToggle" aria-label="Menu"><i class="fas fa-bars"></i></button>
    <nav class="main-nav" id="mainNav">${links}</nav>
    <div class="header-actions" id="headerActions"></div>
  </div>`;

  $('#navToggle').addEventListener('click', () => $('#mainNav').classList.toggle('mobile-open'));
  renderHeaderActions();
}

function renderHeaderActions() {
  const el = $('#headerActions'); if (!el) return;
  if (BB.user) {
    const kyc = BB.user.kycStatus;
    const initials = (BB.user.name || BB.user.email).split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    el.innerHTML = `
      <a href="/dashboard" class="btn btn-ghost btn-sm"><i class="fas fa-gauge-high"></i> Dashboard</a>
      <div class="user-chip">
        <div class="avatar" id="avatarBtn" style="background:${BB.user.avatarColor || '#d3a877'}">${BB.esc(initials)}</div>
        <div class="user-menu" id="userMenu">
          <div class="um-head"><b>${BB.esc(BB.user.name || BB.user.email)}</b>
            <small>${BB.esc(BB.user.email)}</small>
            <div class="mt-1"><span class="kyc-pill ${kyc}">${kyc === 'approved' ? '✔ Verified' : kyc === 'pending' ? '⏳ KYC Review' : kyc === 'rejected' ? '✖ KYC Rejected' : 'KYC Required'}</span></div>
          </div>
          <a href="/dashboard"><i class="fas fa-gauge-high"></i> Dashboard</a>
          <a href="/funding"><i class="fas fa-wallet"></i> Funding</a>
          <a href="/copy-trading"><i class="fas fa-users-rectangle"></i> Copy Trading</a>
          <a href="/kyc"><i class="fas fa-id-card"></i> KYC Verification</a>
          <a href="/trade"><i class="fas fa-chart-line"></i> Trade Now</a>
          <button id="logoutBtn"><i class="fas fa-arrow-right-from-bracket"></i> Log Out</button>
        </div>
      </div>`;
    const av = $('#avatarBtn'), um = $('#userMenu');
    av.addEventListener('click', e => { e.stopPropagation(); um.classList.toggle('open'); });
    document.addEventListener('click', () => um.classList.remove('open'));
    $('#logoutBtn').addEventListener('click', async () => {
      await BB.api('/api/auth/logout', { method: 'POST', body: {} });
      location.href = '/';
    });
  } else {
    el.innerHTML = `
      <a href="/login" class="btn btn-outline btn-sm">Log In</a>
      <a href="/signup" class="btn btn-primary btn-sm"><i class="fas fa-bolt"></i> Sign Up Free</a>`;
  }
}

function renderFooter() {
  const el = $('#site-footer'); if (!el) return;
  el.innerHTML = `
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <img src="/assets/img/brand/logo.png" alt="Blockchain Bullhorn">
        <p>Premier crypto education &amp; trading platform. Structure over hype — build disciplined investing skills for every market cycle.</p>
        <div class="socials">
          <a href="https://www.tiktok.com/@blockchainbullhorn" target="_blank" rel="noopener" title="TikTok (Official)"><i class="fab fa-tiktok"></i></a>
          <a href="https://www.instagram.com/blockchainbullhorn" target="_blank" rel="noopener" title="Instagram"><i class="fab fa-instagram"></i></a>
          <a href="https://x.com/Blockchainbhorn" target="_blank" rel="noopener" title="X / Twitter"><i class="fab fa-x-twitter"></i></a>
          <a href="https://www.youtube.com/@blockchainbullhorn" target="_blank" rel="noopener" title="YouTube"><i class="fab fa-youtube"></i></a>
        </div>
        <div class="footer-fraud">⚠️ <b>Fraud Alert:</b> We NEVER DM first or ask for crypto. Verify official accounts on our <a href="/avoid-scams" style="color:#ffd7de;text-decoration:underline">Fraud Alert page</a>.</div>
      </div>
      <div>
        <h5>Platform</h5>
        <div class="footer-links">
          <a href="/markets">Live Markets</a><a href="/trade">Trading Terminal</a>
          <a href="/copy-trading">Copy Trading</a>
          <a href="/dashboard">Dashboard</a><a href="/funding">Funding</a>
          <a href="/community">Community <i class="fas fa-lock" style="font-size:9px;color:var(--gold)"></i></a>
          <a href="/signup">Create Account</a>
          <a href="/login">Log In</a>
        </div>
      </div>
      <div>
        <h5>Products</h5>
        <div class="footer-links">
          <a href="/store">Store</a><a href="/mentorship">Elite Mentorship</a>
          <a href="/cmf-engine">CMF Engine</a><a href="/faq">FAQ</a>
          <a href="/contact">Contact</a><a href="/avoid-scams">Fraud Alert</a>
        </div>
      </div>
      <div>
        <h5>Legal</h5>
        <div class="footer-links">
          <a href="/legal?p=terms">Terms &amp; Conditions</a>
          <a href="/legal?p=purchase">Fulfillment, Refund &amp; Purchase Policy</a>
          <a href="/legal?p=disclaimer">Disclaimer</a>
          <a href="/legal?p=affiliate">Affiliate Disclaimer</a>
          <a href="/legal?p=gdpr">GDPR Privacy Policy</a>
          <a href="/legal?p=coaching">Coaching Terms of Service</a>
        </div>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© ${new Date().getFullYear()} Blockchain Bullhorn — A Power of Publish Company</span>
      <span>Grab the Bull by the HORNS 🐂</span>
    </div>
  </div>`;
}

// ---------- live ticker ----------
let tickerAssets = [];
async function loadTicker() {
  const el = $('#tickerTrack'); if (!el) return;
  document.body.classList.add('has-ticker');
  const render = () => {
    if (!tickerAssets.length) return;
    const items = tickerAssets.map(a => `
      <span class="tick-item" data-asset="${a.id}" title="Trade ${BB.esc(a.name)}">
        ${a.logo ? `<img src="${a.logo}" alt="">` : ''}
        <span class="sym">${a.symbol}</span>
        <span class="price">$${BB.fmtPrice(a.price)}</span>
        <span class="chg ${BB.chgClass(a.changePct)}">${BB.chgIcon(a.changePct)} ${Math.abs(a.changePct || 0).toFixed(2)}%</span>
      </span>`).join('');
    el.innerHTML = items + items; // duplicate for seamless loop
    $$('.tick-item', el).forEach(t => t.addEventListener('click', () => location.href = '/trade?asset=' + t.dataset.asset));
  };
  if (!tickerAssets.length) {
    const r = await BB.api('/api/markets');
    if (r.assets) {
      tickerAssets = r.assets.filter(a => a.price != null)
        .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)).slice(0, 26);
      render();
    }
  } else render();
  setInterval(async () => {
    const r = await BB.api('/api/markets', { silent: true });
    if (r.assets) {
      const map = {}; r.assets.forEach(a => map[a.id] = a);
      tickerAssets.forEach(a => { if (map[a.id]) Object.assign(a, map[a.id]); });
      render();
    }
  }, 20000);
}

// ---------- announcement ----------
function renderAnnouncement() {
  const el = $('#announce'); if (!el) return;
  const a = BB.settings.announcement;
  if (a && a.enabled && a.text) { el.innerHTML = a.text; el.classList.add('show'); }
}

// ---------- reveal on scroll ----------
function initReveal() {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); } });
  }, { threshold: 0.12 });
  $$('.reveal').forEach(el => io.observe(el));
}

// ---------- animated counters ----------
function initCounters() {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target, target = parseFloat(el.dataset.count), dur = 1400, t0 = performance.now();
      const suffix = el.dataset.suffix || '', prefix = el.dataset.prefix || '';
      const isFloat = el.dataset.float === '1';
      const tick = t => {
        const p = Math.min(1, (t - t0) / dur), ease = 1 - Math.pow(1 - p, 3);
        const v = target * ease;
        el.textContent = prefix + (isFloat ? v.toFixed(1) : Math.round(v).toLocaleString()) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      io.unobserve(el);
    });
  }, { threshold: 0.4 });
  $$('[data-count]').forEach(el => io.observe(el));
}

/* ============================================================
   LIVE CHAT — Smartsupp integration + built-in branded widget
   If a Smartsupp key is configured (Admin → Settings), the real
   Smartsupp script loads. Otherwise the built-in Blockchain
   Bullhorn support widget (same UX, logo avatar, admin-backed)
   handles conversations.
   ============================================================ */
const Chat = {
  convId: null, lastAt: 0, open: false, unread: 0, pollTimer: null, initialized: false,

  injectSmartsupp(key) {
    window._smartsupp = window._smartsupp || {};
    window.smartsupp = function () { window._smartsupp.push(arguments); };
    window.smartsupp._key = key;
    // identify the visitor to chat agents when signed in
    try {
      if (BB.user) {
        window.smartsupp('name', BB.user.name || BB.user.email);
        window.smartsupp('email', BB.user.email);
      }
    } catch (e) { /* non-fatal */ }
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.smartsuppchat.com/loader.js';
    document.head.appendChild(s);
  },

  init() {
    if (Chat.initialized) return; Chat.initialized = true;
    if (BB.settings.smartsuppKey) {
      // Real Smartsupp is configured — activate it.
      Chat.injectSmartsupp(BB.settings.smartsuppKey);
      return;
    }
    // Built-in widget (Branded "Blockchain Bullhorn Support", logo avatar)
    const btn = document.createElement('button');
    btn.className = 'chat-launcher';
    btn.innerHTML = '<i class="fas fa-comment-dots"></i><span class="chat-unread" id="chatUnread">0</span>';
    btn.title = 'Chat with us';
    const win = document.createElement('div');
    win.className = 'chat-window';
    win.innerHTML = `
      <div class="chat-head">
        <img src="/assets/img/chat-avatar.png" alt="Blockchain Bullhorn Support">
        <div><b>Blockchain Bullhorn</b>
          <small><span class="live-dot" style="background:#7CFC9A"></span>${BB.settings.chatOnline ? 'Support online — replies in minutes' : 'We reply as soon as possible'}</small>
        </div>
        <button class="chat-close" aria-label="Close chat">&times;</button>
      </div>
      <div class="chat-msgs" id="chatMsgs"></div>
      <div class="chat-typing" id="chatTyping"><span></span><span></span><span></span></div>
      <div class="chat-input-bar">
        <input id="chatInput" type="text" placeholder="Type your message…" maxlength="800">
        <button id="chatSend" aria-label="Send"><i class="fas fa-paper-plane"></i></button>
      </div>
      <div class="chat-notice">Powered by Blockchain Bullhorn Support · replies also arrive by email</div>`;
    document.body.appendChild(btn);
    document.body.appendChild(win);

    btn.addEventListener('click', () => Chat.toggle());
    $('.chat-close', win).addEventListener('click', () => Chat.toggle(false));
    const send = () => Chat.send();
    $('#chatSend').addEventListener('click', send);
    $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

    // preload history quietly
    Chat.sync(true);
    // poll for new messages (also while closed, for unread badge)
    Chat.pollTimer = setInterval(() => Chat.sync(), 5000);
  },

  toggle(force) {
    const win = $('.chat-window');
    Chat.open = force !== undefined ? force : !Chat.open;
    if (Chat.open) {
      win.classList.add('open');
      Chat.unread = 0; Chat.renderUnread();
      Chat.sync(true);
      setTimeout(() => { const i = $('#chatInput'); if (i) i.focus(); }, 150);
    } else win.classList.remove('open');
  },

  renderUnread() {
    const b = $('#chatUnread'); if (!b) return;
    b.textContent = Chat.unread;
    b.classList.toggle('show', Chat.unread > 0);
  },

  async sync(scroll) {
    const r = await BB.api(`/api/chat/messages?after=${Chat.lastAt}`, { silent: true });
    if (!r.messages || !r.messages.length) return;
    const fresh = r.messages;
    Chat.lastAt = fresh[fresh.length - 1].at;
    const box = $('#chatMsgs'); if (!box) return;
    fresh.forEach(m => Chat.renderMsg(m));
    if (!Chat.open) {
      const userInvis = fresh.filter(m => m.from !== 'user').length;
      if (userInvis) { Chat.unread += userInvis; Chat.renderUnread(); }
    }
    Chat.scrollBottom();
    if (fresh.some(m => m.from === 'user')) {
      const t = $('#chatTyping'); if (t) { t.classList.add('show'); setTimeout(() => t && t.classList.remove('show'), 1600); }
    }
  },

  renderMsg(m) {
    const box = $('#chatMsgs'); if (!box) return;
    if ($(`[data-mid="${m.id}"]`, box)) return;
    const div = document.createElement('div');
    div.className = 'chat-msg from-' + (m.from === 'user' ? 'user' : m.from);
    div.dataset.mid = m.id;
    const who = m.from === 'admin' ? (m.adminName || 'Support') : m.from === 'bot' ? 'Bullhorn Assistant' : 'You';
    div.innerHTML = `${BB.esc(m.text)}<span class="msg-meta">${who} · ${new Date(m.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>`;
    box.appendChild(div);
  },

  scrollBottom() {
    const box = $('#chatMsgs'); if (box) box.scrollTop = box.scrollHeight;
  },

  async send() {
    const inp = $('#chatInput'); if (!inp) return;
    const text = inp.value.trim(); if (!text) return;
    inp.value = '';
    // optimistic render
    Chat.renderMsg({ id: 'tmp' + Date.now(), from: 'user', text, at: Date.now() });
    Chat.scrollBottom();
    await BB.api('/api/chat/send', { method: 'POST', body: { text } });
    setTimeout(() => Chat.sync(), 1100);
  }
};

// ---------- boot ----------
async function bootCommon() {
  const settingsR = await BB.api('/api/settings/public', { silent: true });
  if (settingsR.ok) BB.settings = Object.assign(BB.settings, settingsR);
  const meR = await BB.api('/api/auth/me', { silent: true });
  if (meR.ok && meR.user) BB.user = meR.user;
  renderHeader();
  renderFooter();
  renderAnnouncement();
  initReveal();
  initCounters();
  loadTicker();
  Chat.init();
  document.dispatchEvent(new CustomEvent('bb:ready'));
}

document.addEventListener('DOMContentLoaded', bootCommon);
