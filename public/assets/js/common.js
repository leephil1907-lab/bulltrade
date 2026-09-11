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
  settings: { smartsuppKey: '', chatOnline: true },
  lang: (localStorage.getItem('bbLang') || 'en'),
  cur: (localStorage.getItem('bbCur') || 'USD'),
  fx: { rate: 1, rates: null, ready: false },

  fmtPrice(p) {
    if (p == null) return '—';
    const v = BB.cur === 'USD' ? Number(p) : Number(p) * BB.fx.rate;
    if (v >= 1000) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
    if (v >= 0.01) return v.toFixed(4);
    return v.toPrecision(4);
  },
  fmtUSD(n, d = 2) {
    if (n == null || isNaN(n)) return '—';
    if (BB.cur === 'USD') return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    const dec = (CURS[BB.cur] && CURS[BB.cur].d) || 2;
    return BB.sym() + (Number(n) * BB.fx.rate).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  },
  sym() { return BB.cur === 'USD' ? '$' : ((CURS[BB.cur] && CURS[BB.cur].s) || '$'); },
  t(k) { return (I18N[BB.lang] && I18N[BB.lang][k]) || I18N.en[k] || k; },
  setLang(l) {
    BB.lang = l; localStorage.setItem('bbLang', l);
    document.documentElement.lang = l;
    // smart pairing: switch to the locale's default currency on first pick —
    // the user can always override it afterwards (the override then sticks)
    if (!localStorage.getItem('bbCurSet')) {
      const def = LANG_CUR[l] || 'USD';
      if (def !== BB.cur) {
        BB.setCur(def, false);
        BB.toast(`💰 Display currency set to ${CURS[def].f} ${def} — you can change it in the same menu`, 'success');
      }
    }
    renderHeader(); renderFooter(); renderAnnouncement();
    BB.applyLang(); PWA.refreshBannerText();
  },
  setCur(c, explicit = true) {
    BB.cur = c; localStorage.setItem('bbCur', c);
    if (explicit) localStorage.setItem('bbCurSet', '1'); // manual choice always wins from now on
    BB.fx.rate = (BB.fx.rates && BB.fx.rates[c]) || 1;
    BB.applyUsd();
    document.dispatchEvent(new CustomEvent('bb:fx'));
  },
  country() { return localStorage.getItem('bbCountry') || (BB.user && (CTRY.find(x => x.n === BB.user.country) || {}).c) || null; },
  setCountry(iso, opts = {}) {
    if (!CTRY.some(x => x.c === iso)) return;
    localStorage.setItem('bbCountry', iso);
    // the country determines the display currency — unless the user picked one manually
    if (!localStorage.getItem('bbCurSet')) {
      const cur = COUNTRY_CUR[iso] || 'USD';
      if (cur !== BB.cur) {
        BB.setCur(cur, false);
        if (opts.toast !== false) BB.toast(`💰 ${flagOf(iso)} Display currency set to ${CURS[cur].f} ${cur} — change it any time in this menu`, 'success');
      }
    }
    renderHeader(); renderFooter();
  },
  applyLang() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = BB.t(el.dataset.i18n); });
  },
  applyUsd() {
    document.querySelectorAll('[data-usd]').forEach(el => {
      const v = parseFloat(el.dataset.usd);
      if (!isNaN(v)) el.textContent = BB.fmtUSD(v);
    });
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

  // loading-skeleton builders
  skelRows(n = 6, cols = 5) {
    let h = '';
    for (let i = 0; i < n; i++) {
      h += '<tr>' + Array.from({ length: cols }, (_, c) =>
        `<td><span class="skeleton" style="width:${45 + ((i * 17 + c * 29) % 50)}%"></span></td>`).join('') + '</tr>';
    }
    return h;
  },
  skelQuotes(n = 4) {
    let h = '';
    for (let i = 0; i < n; i++) h += `<div style="display:flex;gap:10px;align-items:center;padding:9px 0">
      <span class="skeleton" style="width:26px;height:26px;border-radius:50%"></span>
      <span style="flex:1"><span class="skeleton" style="width:68%;height:12px"></span>
      <span class="skeleton" style="width:44%;height:10px;margin-top:6px"></span></span>
      <span class="skeleton" style="width:56px;height:14px"></span></div>`;
    return h;
  },
  skelCards(n = 3, h = 96) {
    return Array.from({ length: n }, () =>
      `<div class="card"><span class="skeleton" style="width:100%;height:${h}px"></span></div>`).join('');
  },
  // Open the site's live chat: official Smartsupp when configured, built-in branded widget otherwise.
  openChat() {
    if (BB.settings.smartsuppKey) {
      if (typeof window.smartsupp === 'function') { try { window.smartsupp('chat:open'); } catch (e) { } return; }
      // Smartsupp script still loading — retry briefly, then fall back to the built-in widget
      let tries = 0;
      const iv = setInterval(() => {
        if (typeof window.smartsupp === 'function') { clearInterval(iv); try { window.smartsupp('chat:open'); } catch (e) { } }
        else if (++tries > 20) { clearInterval(iv); Chat.ensureBuiltIn(); Chat.toggle(true); }
      }, 150);
      return;
    }
    Chat.ensureBuiltIn();
    Chat.toggle(true);
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

// ---------- page transitions & progress bar ----------
const Motion = {
  bar: null, reduced: false,
  init() {
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.reduced) return;
    this.bar = document.createElement('div');
    this.bar.id = 'bbBar';
    document.body.appendChild(this.bar);
    this.start();
    if (document.readyState === 'complete') this.end();
    else addEventListener('load', () => this.end());
    // smooth exit on internal navigation
    document.addEventListener('click', e => {
      const a = e.target.closest ? e.target.closest('a[href]') : null;
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if ((a.target && a.target !== '_self') || a.hasAttribute('download') || a.dataset.instant !== undefined) return;
      const href = a.getAttribute('href') || '';
      if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|javascript:|blob:|data:)/i.test(href)) return;
      let url; try { url = new URL(a.href, location.href); } catch (err) { return; }
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
      e.preventDefault();
      this.start();
      document.body.classList.add('page-exit');
      setTimeout(() => { location.href = a.href; }, 140);
    });
    // bfcache restore (browser Back button)
    addEventListener('pageshow', ev => {
      if (ev.persisted) {
        document.body.classList.remove('page-exit');
        this.end();
      }
    });
  },
  start() {
    if (!this.bar) return;
    this.bar.classList.remove('done');
    this.bar.classList.add('on');
    this.bar.style.width = '14%';
    requestAnimationFrame(() => { if (this.bar) this.bar.style.width = '72%'; });
  },
  end() {
    if (!this.bar) return;
    this.bar.style.width = '100%';
    this.bar.classList.add('done');
    setTimeout(() => { if (!this.bar) return; this.bar.classList.remove('on', 'done'); this.bar.style.width = '0'; }, 400);
  }
};

// ---------- header / footer ----------
// ---------- i18n: languages (flag-matched) & display currencies ----------
const LANGS = [
  { c: 'en', f: '🇬🇧', n: 'English' },
  { c: 'es', f: '🇪🇸', n: 'Español' },
  { c: 'fr', f: '🇫🇷', n: 'Français' },
  { c: 'pt', f: '🇵🇹', n: 'Português' },
  { c: 'de', f: '🇩🇪', n: 'Deutsch' },
  { c: 'zh', f: '🇨🇳', n: '中文' },
  { c: 'hi', f: '🇮🇳', n: 'हिन्दी' }
];
const CURS = {
  USD: { f: '🇺🇸', n: 'US Dollar', s: '$', d: 2 },
  EUR: { f: '🇪🇺', n: 'Euro', s: '€', d: 2 },
  GBP: { f: '🇬🇧', n: 'British Pound', s: '£', d: 2 },
  CAD: { f: '🇨🇦', n: 'Canadian Dollar', s: 'C$', d: 2 },
  AUD: { f: '🇦🇺', n: 'Australian Dollar', s: 'A$', d: 2 },
  JPY: { f: '🇯🇵', n: 'Japanese Yen', s: '¥', d: 0 },
  CNY: { f: '🇨🇳', n: 'Chinese Yuan', s: '¥', d: 2 },
  INR: { f: '🇮🇳', n: 'Indian Rupee', s: '₹', d: 0 },
  NGN: { f: '🇳🇬', n: 'Nigerian Naira', s: '₦', d: 0 },
  ZAR: { f: '🇿🇦', n: 'South African Rand', s: 'R', d: 2 },
  BRL: { f: '🇧🇷', n: 'Brazilian Real', s: 'R$', d: 2 },
  MXN: { f: '🇲🇽', n: 'Mexican Peso', s: 'Mex$', d: 2 },
  AED: { f: '🇦🇪', n: 'UAE Dirham', s: 'AED ', d: 2 },
  SAR: { f: '🇸🇦', n: 'Saudi Riyal', s: 'SAR ', d: 2 },
  TRY: { f: '🇹🇷', n: 'Turkish Lira', s: '₺', d: 2 },
  CHF: { f: '🇨🇭', n: 'Swiss Franc', s: 'Fr ', d: 2 },
  KES: { f: '🇰🇪', n: 'Kenyan Shilling', s: 'KSh ', d: 0 },
  GHS: { f: '🇬🇭', n: 'Ghanaian Cedi', s: 'GH₵ ', d: 2 },
  PHP: { f: '🇵🇭', n: 'Philippine Peso', s: '₱', d: 2 }
};

// ---------- countries (name + ISO code; flag emoji derived from the code) ----------
const CTRY = [
  { n: 'Afghanistan', c: 'AF' }, { n: 'Albania', c: 'AL' }, { n: 'Algeria', c: 'DZ' }, { n: 'Andorra', c: 'AD' },
  { n: 'Angola', c: 'AO' }, { n: 'Antigua and Barbuda', c: 'AG' }, { n: 'Argentina', c: 'AR' }, { n: 'Armenia', c: 'AM' },
  { n: 'Australia', c: 'AU' }, { n: 'Austria', c: 'AT' }, { n: 'Azerbaijan', c: 'AZ' }, { n: 'Bahamas', c: 'BS' },
  { n: 'Bahrain', c: 'BH' }, { n: 'Bangladesh', c: 'BD' }, { n: 'Barbados', c: 'BB' }, { n: 'Belarus', c: 'BY' },
  { n: 'Belgium', c: 'BE' }, { n: 'Belize', c: 'BZ' }, { n: 'Benin', c: 'BJ' }, { n: 'Bhutan', c: 'BT' },
  { n: 'Bolivia', c: 'BO' }, { n: 'Bosnia and Herzegovina', c: 'BA' }, { n: 'Botswana', c: 'BW' }, { n: 'Brazil', c: 'BR' },
  { n: 'Brunei', c: 'BN' }, { n: 'Bulgaria', c: 'BG' }, { n: 'Burkina Faso', c: 'BF' }, { n: 'Burundi', c: 'BI' },
  { n: 'Cabo Verde', c: 'CV' }, { n: 'Cambodia', c: 'KH' }, { n: 'Cameroon', c: 'CM' }, { n: 'Canada', c: 'CA' },
  { n: 'Central African Republic', c: 'CF' }, { n: 'Chad', c: 'TD' }, { n: 'Chile', c: 'CL' }, { n: 'China', c: 'CN' },
  { n: 'Colombia', c: 'CO' }, { n: 'Comoros', c: 'KM' }, { n: 'Congo (Brazzaville)', c: 'CG' },
  { n: 'Congo (Democratic Republic of the)', c: 'CD' }, { n: 'Costa Rica', c: 'CR' }, { n: "Côte d'Ivoire", c: 'CI' },
  { n: 'Croatia', c: 'HR' }, { n: 'Cuba', c: 'CU' }, { n: 'Cyprus', c: 'CY' }, { n: 'Czech Republic (Czechia)', c: 'CZ' },
  { n: 'Denmark', c: 'DK' }, { n: 'Djibouti', c: 'DJ' }, { n: 'Dominica', c: 'DM' }, { n: 'Dominican Republic', c: 'DO' },
  { n: 'Ecuador', c: 'EC' }, { n: 'Egypt', c: 'EG' }, { n: 'El Salvador', c: 'SV' }, { n: 'Equatorial Guinea', c: 'GQ' },
  { n: 'Eritrea', c: 'ER' }, { n: 'Estonia', c: 'EE' }, { n: 'Eswatini', c: 'SZ' }, { n: 'Ethiopia', c: 'ET' },
  { n: 'Fiji', c: 'FJ' }, { n: 'Finland', c: 'FI' }, { n: 'France', c: 'FR' }, { n: 'Gabon', c: 'GA' },
  { n: 'Gambia', c: 'GM' }, { n: 'Georgia', c: 'GE' }, { n: 'Germany', c: 'DE' }, { n: 'Ghana', c: 'GH' },
  { n: 'Greece', c: 'GR' }, { n: 'Grenada', c: 'GD' }, { n: 'Guatemala', c: 'GT' }, { n: 'Guinea', c: 'GN' },
  { n: 'Guinea-Bissau', c: 'GW' }, { n: 'Guyana', c: 'GY' }, { n: 'Haiti', c: 'HT' }, { n: 'Honduras', c: 'HN' },
  { n: 'Hungary', c: 'HU' }, { n: 'Iceland', c: 'IS' }, { n: 'India', c: 'IN' }, { n: 'Indonesia', c: 'ID' },
  { n: 'Iran', c: 'IR' }, { n: 'Iraq', c: 'IQ' }, { n: 'Ireland', c: 'IE' }, { n: 'Israel', c: 'IL' },
  { n: 'Italy', c: 'IT' }, { n: 'Jamaica', c: 'JM' }, { n: 'Japan', c: 'JP' }, { n: 'Jordan', c: 'JO' },
  { n: 'Kazakhstan', c: 'KZ' }, { n: 'Kenya', c: 'KE' }, { n: 'Kiribati', c: 'KI' }, { n: 'Kuwait', c: 'KW' },
  { n: 'Kyrgyzstan', c: 'KG' }, { n: 'Laos', c: 'LA' }, { n: 'Latvia', c: 'LV' }, { n: 'Lebanon', c: 'LB' },
  { n: 'Lesotho', c: 'LS' }, { n: 'Liberia', c: 'LR' }, { n: 'Libya', c: 'LY' }, { n: 'Liechtenstein', c: 'LI' },
  { n: 'Lithuania', c: 'LT' }, { n: 'Luxembourg', c: 'LU' }, { n: 'Madagascar', c: 'MG' }, { n: 'Malawi', c: 'MW' },
  { n: 'Malaysia', c: 'MY' }, { n: 'Maldives', c: 'MV' }, { n: 'Mali', c: 'ML' }, { n: 'Malta', c: 'MT' },
  { n: 'Marshall Islands', c: 'MH' }, { n: 'Mauritania', c: 'MR' }, { n: 'Mauritius', c: 'MU' }, { n: 'Mexico', c: 'MX' },
  { n: 'Micronesia', c: 'FM' }, { n: 'Moldova', c: 'MD' }, { n: 'Monaco', c: 'MC' }, { n: 'Mongolia', c: 'MN' },
  { n: 'Montenegro', c: 'ME' }, { n: 'Morocco', c: 'MA' }, { n: 'Mozambique', c: 'MZ' }, { n: 'Myanmar (Burma)', c: 'MM' },
  { n: 'Namibia', c: 'NA' }, { n: 'Nauru', c: 'NR' }, { n: 'Nepal', c: 'NP' }, { n: 'Netherlands', c: 'NL' },
  { n: 'New Zealand', c: 'NZ' }, { n: 'Nicaragua', c: 'NI' }, { n: 'Niger', c: 'NE' }, { n: 'Nigeria', c: 'NG' },
  { n: 'North Korea', c: 'KP' }, { n: 'North Macedonia', c: 'MK' }, { n: 'Norway', c: 'NO' }, { n: 'Oman', c: 'OM' },
  { n: 'Pakistan', c: 'PK' }, { n: 'Palau', c: 'PW' }, { n: 'Palestine', c: 'PS' }, { n: 'Panama', c: 'PA' },
  { n: 'Papua New Guinea', c: 'PG' }, { n: 'Paraguay', c: 'PY' }, { n: 'Peru', c: 'PE' }, { n: 'Philippines', c: 'PH' },
  { n: 'Poland', c: 'PL' }, { n: 'Portugal', c: 'PT' }, { n: 'Qatar', c: 'QA' }, { n: 'Romania', c: 'RO' },
  { n: 'Russia', c: 'RU' }, { n: 'Rwanda', c: 'RW' }, { n: 'Saint Kitts and Nevis', c: 'KN' }, { n: 'Saint Lucia', c: 'LC' },
  { n: 'Saint Vincent and the Grenadines', c: 'VC' }, { n: 'Samoa', c: 'WS' }, { n: 'San Marino', c: 'SM' },
  { n: 'Sao Tome and Principe', c: 'ST' }, { n: 'Saudi Arabia', c: 'SA' }, { n: 'Senegal', c: 'SN' },
  { n: 'Serbia', c: 'RS' }, { n: 'Seychelles', c: 'SC' }, { n: 'Sierra Leone', c: 'SL' }, { n: 'Singapore', c: 'SG' },
  { n: 'Slovakia', c: 'SK' }, { n: 'Slovenia', c: 'SI' }, { n: 'Solomon Islands', c: 'SB' }, { n: 'Somalia', c: 'SO' },
  { n: 'South Africa', c: 'ZA' }, { n: 'South Korea', c: 'KR' }, { n: 'South Sudan', c: 'SS' }, { n: 'Spain', c: 'ES' },
  { n: 'Sri Lanka', c: 'LK' }, { n: 'Sudan', c: 'SD' }, { n: 'Suriname', c: 'SR' }, { n: 'Sweden', c: 'SE' },
  { n: 'Switzerland', c: 'CH' }, { n: 'Syria', c: 'SY' }, { n: 'Taiwan', c: 'TW' }, { n: 'Tajikistan', c: 'TJ' },
  { n: 'Tanzania', c: 'TZ' }, { n: 'Thailand', c: 'TH' }, { n: 'Timor-Leste', c: 'TL' }, { n: 'Togo', c: 'TG' },
  { n: 'Tonga', c: 'TO' }, { n: 'Trinidad and Tobago', c: 'TT' }, { n: 'Tunisia', c: 'TN' },
  { n: 'Turkey (Türkiye)', c: 'TR' }, { n: 'Turkmenistan', c: 'TM' }, { n: 'Tuvalu', c: 'TV' }, { n: 'Uganda', c: 'UG' },
  { n: 'Ukraine', c: 'UA' }, { n: 'United Arab Emirates', c: 'AE' }, { n: 'United Kingdom', c: 'GB' },
  { n: 'United States', c: 'US' }, { n: 'Uruguay', c: 'UY' }, { n: 'Uzbekistan', c: 'UZ' }, { n: 'Vanuatu', c: 'VU' },
  { n: 'Vatican City (Holy See)', c: 'VA' }, { n: 'Venezuela', c: 'VE' }, { n: 'Vietnam', c: 'VN' },
  { n: 'Yemen', c: 'YE' }, { n: 'Zambia', c: 'ZM' }, { n: 'Zimbabwe', c: 'ZW' }
];
const flagOf = c => c && /^[A-Z]{2}$/.test(c)
  ? String.fromCodePoint(...[...c].map(ch => 0x1F1E6 + ch.charCodeAt(0) - 65)) : '🏳️';
// country → display currency (the master mapping; unsupported currencies fall back to USD)
const COUNTRY_CUR = {
  NG: 'NGN', US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', JP: 'JPY', CN: 'CNY', IN: 'INR',
  ZA: 'ZAR', BR: 'BRL', MX: 'MXN', AE: 'AED', SA: 'SAR', TR: 'TRY', CH: 'CHF', KE: 'KES',
  GH: 'GHS', PH: 'PHP',
  FR: 'EUR', DE: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR',
  IE: 'EUR', GR: 'EUR', FI: 'EUR', SK: 'EUR', SI: 'EUR', LU: 'EUR', MT: 'EUR', CY: 'EUR',
  EE: 'EUR', LV: 'EUR', LT: 'EUR', HR: 'EUR',
  AD: 'EUR', MC: 'EUR', SM: 'EUR', VA: 'EUR', ME: 'EUR',
  BJ: 'EUR', BF: 'EUR', CV: 'EUR', CM: 'EUR', CF: 'EUR', TD: 'EUR', KM: 'EUR', CG: 'EUR',
  GA: 'EUR', GQ: 'EUR', GN: 'EUR', ML: 'EUR', NE: 'EUR', SN: 'EUR', TG: 'EUR',
  MA: 'EUR', DZ: 'EUR', TN: 'EUR',
  LS: 'ZAR', SZ: 'ZAR', NA: 'ZAR',
  BT: 'INR', NP: 'INR',
  KI: 'AUD', NR: 'AUD', TV: 'AUD', PG: 'AUD',
  SO: 'KES', SS: 'KES',
  EC: 'USD', SV: 'USD', PA: 'USD', ZW: 'USD', TL: 'USD', FM: 'USD', MH: 'USD', PW: 'USD',
  LI: 'CHF'
};

// sensible default currency per language (used only until the user picks one manually)
const LANG_CUR = { en: 'USD', es: 'EUR', fr: 'EUR', pt: 'EUR', de: 'EUR', zh: 'CNY', hi: 'INR' };

const I18N = {
  en: {
    'nav.markets': 'Markets', 'nav.trading': 'Trading', 'nav.bots': 'Trading Bots', 'nav.community': 'Community',
    'nav.products': 'Products', 'nav.mentorship': 'Mentorship', 'nav.faq': 'FAQ', 'nav.contact': 'Contact',
    'hdr.login': 'Log In', 'hdr.signup': 'Sign Up Free', 'hdr.logout': 'Log Out', 'hdr.dashboard': 'Dashboard',
    'hdr.funding': 'Funding', 'hdr.kyc': 'KYC Verification', 'hdr.tradenow': 'Trade Now', 'hdr.notify': 'Notifications',
    'hdr.tagline': 'Grab the Bull by the Horns',
    'ftr.platform': 'Platform', 'ftr.products': 'Products', 'ftr.liveMarkets': 'Live Markets', 'ftr.terminal': 'Trading Terminal',
    'ftr.bots': 'Trading Bots', 'ftr.dashboard': 'Dashboard', 'ftr.funding': 'Funding', 'ftr.community': 'Community',
    'ftr.createAccount': 'Create Account', 'ftr.login': 'Log In', 'ftr.install': 'Install App', 'ftr.notify': 'Notifications',
    'ftr.store': 'Store', 'ftr.mentorship': 'Elite Mentorship', 'ftr.cmf': 'CMF Engine', 'ftr.faq': 'FAQ',
    'ftr.contact': 'Contact', 'ftr.fraudAlert': 'Fraud Alert', 'ftr.fraudText': 'We NEVER DM first or ask for crypto. Verify official accounts on our',
    'ftr.fraudLink': 'Fraud Alert page', 'ftr.blurb': 'Premier crypto education & trading platform. Structure over hype — build disciplined investing skills for every market cycle.',
    'ftr.risk': 'Trading involves risk. Nothing here is financial advice.',
    'hero.h1': 'Grab the Bull by the <span class=\"gold\">HORNS</span> 🐂', 'hero.lead': 'Master crypto with a simple, proven system — then put it to work. Learn, trade crypto, stocks, indices and real-world assets from one account, with live prices and a free $10,000 demo.',
    'hero.ctaStart': 'Start Free — Get $10,000 Demo', 'hero.ctaExplore': 'Explore the Terminal',
    'hero.stat1': 'TikTok Community', 'hero.stat2': 'Power of Publish Family', 'hero.stat3': 'Live-Tracked Assets', 'hero.stat4': 'Markets & Support',
    'auth.welcomeBack': 'Welcome Back', 'auth.signupTitle': 'Join the Blockchain Bullhorn',
    'pwa.installTitle': 'Get the Blockchain Bullhorn app', 'pwa.installSub': 'Fast, full-screen, works offline', 'pwa.installGo': 'Install',
    'globe.note': 'Your country / region sets the display currency. Language and currency can still be changed independently — prices show in your chosen currency, while accounts and trading stay in USD.'
  },
  es: {
    'nav.markets': 'Mercados', 'nav.trading': 'Trading', 'nav.bots': 'Bots de Trading', 'nav.community': 'Comunidad',
    'nav.products': 'Productos', 'nav.mentorship': 'Mentoría', 'nav.faq': 'Preguntas frecuentes', 'nav.contact': 'Contacto',
    'hdr.login': 'Iniciar sesión', 'hdr.signup': 'Regístrate gratis', 'hdr.logout': 'Cerrar sesión', 'hdr.dashboard': 'Panel',
    'hdr.funding': 'Fondos', 'hdr.kyc': 'Verificación KYC', 'hdr.tradenow': 'Operar ahora', 'hdr.notify': 'Notificaciones',
    'hdr.tagline': 'Agarra al toro por los cuernos',
    'ftr.platform': 'Plataforma', 'ftr.products': 'Productos', 'ftr.liveMarkets': 'Mercados en vivo', 'ftr.terminal': 'Terminal de Trading',
    'ftr.bots': 'Bots de Trading', 'ftr.dashboard': 'Panel', 'ftr.funding': 'Fondos', 'ftr.community': 'Comunidad',
    'ftr.createAccount': 'Crear cuenta', 'ftr.login': 'Iniciar sesión', 'ftr.install': 'Instalar app', 'ftr.notify': 'Notificaciones',
    'ftr.store': 'Tienda', 'ftr.mentorship': 'Mentoría Elite', 'ftr.cmf': 'Motor CMF', 'ftr.faq': 'Preguntas frecuentes',
    'ftr.contact': 'Contacto', 'ftr.fraudAlert': 'Alerta de fraude', 'ftr.fraudText': 'NUNCA enviamos mensajes primero ni pedimos cripto. Verifica las cuentas oficiales en nuestra',
    'ftr.fraudLink': 'página de Alerta de Fraude', 'ftr.blurb': 'Plataforma premier de educación cripto y trading. Estructura sobre hype: desarrolla habilidades de inversión disciplinadas para cada ciclo del mercado.',
    'ftr.risk': 'Operar implica riesgos. Nada de lo que aparece aquí es asesoramiento financiero.',
    'hero.h1': 'Agarra al toro por los <span class=\"gold\">CUERNOS</span> 🐂', 'hero.lead': 'Domina el cripto con un sistema simple y probado — y ponlo a trabajar. Aprende y opera cripto, acciones, índices y activos reales desde una sola cuenta, con precios en vivo y un demo gratuito de $10,000.',
    'hero.ctaStart': 'Empieza gratis — Demo de $10,000', 'hero.ctaExplore': 'Explora la Terminal',
    'hero.stat1': 'Comunidad de TikTok', 'hero.stat2': 'Familia Power of Publish', 'hero.stat3': 'Activos en vivo', 'hero.stat4': 'Mercados y soporte 24/7',
    'auth.welcomeBack': 'Bienvenido de nuevo', 'auth.signupTitle': 'Únete al Blockchain Bullhorn',
    'pwa.installTitle': 'Consigue la app Blockchain Bullhorn', 'pwa.installSub': 'Rápida, a pantalla completa, funciona sin conexión', 'pwa.installGo': 'Instalar',
    'globe.note': 'Tu país / región determina la moneda de visualización. El idioma y la moneda pueden cambiarse de forma independiente — los precios se muestran en tu moneda elegida; las cuentas y el trading se mantienen en USD.'
  },
  fr: {
    'nav.markets': 'Marchés', 'nav.trading': 'Trading', 'nav.bots': 'Bots de Trading', 'nav.community': 'Communauté',
    'nav.products': 'Produits', 'nav.mentorship': 'Mentorat', 'nav.faq': 'FAQ', 'nav.contact': 'Contact',
    'hdr.login': 'Se connecter', 'hdr.signup': 'Créer un compte gratuit', 'hdr.logout': 'Se déconnecter', 'hdr.dashboard': 'Tableau de bord',
    'hdr.funding': 'Financement', 'hdr.kyc': 'Vérification KYC', 'hdr.tradenow': 'Trader maintenant', 'hdr.notify': 'Notifications',
    'hdr.tagline': 'Prends le taureau par les cornes',
    'ftr.platform': 'Plateforme', 'ftr.products': 'Produits', 'ftr.liveMarkets': 'Marchés en direct', 'ftr.terminal': 'Terminal de Trading',
    'ftr.bots': 'Bots de Trading', 'ftr.dashboard': 'Tableau de bord', 'ftr.funding': 'Financement', 'ftr.community': 'Communauté',
    'ftr.createAccount': 'Créer un compte', 'ftr.login': 'Se connecter', 'ftr.install': "Installer l'app", 'ftr.notify': 'Notifications',
    'ftr.store': 'Boutique', 'ftr.mentorship': 'Mentorat Elite', 'ftr.cmf': 'Moteur CMF', 'ftr.faq': 'FAQ',
    'ftr.contact': 'Contact', 'ftr.fraudAlert': 'Alerte fraude', 'ftr.fraudText': "Nous n'envoyons JAMAIS de message en premier et ne demandons pas de crypto. Vérifiez les comptes officiels sur notre",
    'ftr.fraudLink': "page Alerte Fraude", 'ftr.blurb': "Plateforme premium d'éducation crypto et de trading. La structure plutôt que le hype — développez des compétences d'investissement disciplinées pour chaque cycle de marché.",
    'ftr.risk': 'Le trading comporte des risques. Rien ici ne constitue un conseil financier.',
    'hero.h1': 'Prends le taureau par les <span class=\"gold\">CORNES</span> 🐂', 'hero.lead': 'Maîtrisez le crypto avec un système simple et éprouvé — puis mettez-le au travail. Apprenez et tradez crypto, actions, indices et actifs réels depuis un seul compte, avec des prix en direct et un démo gratuit de 10 000 $.',
    'hero.ctaStart': 'Commencer gratuitement — Démo de 10 000 $', 'hero.ctaExplore': 'Explorer le Terminal',
    'hero.stat1': 'Communauté TikTok', 'hero.stat2': 'Famille Power of Publish', 'hero.stat3': 'Actifs suivis en direct', 'hero.stat4': 'Marchés & support 24/7',
    'auth.welcomeBack': 'Bon retour', 'auth.signupTitle': 'Rejoignez le Blockchain Bullhorn',
    'pwa.installTitle': "Obtenez l'app Blockchain Bullhorn", 'pwa.installSub': 'Rapide, plein écran, fonctionne hors ligne', 'pwa.installGo': 'Installer',
    'globe.note': 'Votre pays / région détermine la devise d\'affichage. La langue et la devise restent modifiables indépendamment — les prix s\'affichent dans la devise choisie ; les comptes et le trading restent en USD.',
  },
  pt: {
    'nav.markets': 'Mercados', 'nav.trading': 'Trading', 'nav.bots': 'Bots de Trading', 'nav.community': 'Comunidade',
    'nav.products': 'Produtos', 'nav.mentorship': 'Mentoria', 'nav.faq': 'Perguntas frequentes', 'nav.contact': 'Contato',
    'hdr.login': 'Entrar', 'hdr.signup': 'Cadastre-se grátis', 'hdr.logout': 'Sair', 'hdr.dashboard': 'Painel',
    'hdr.funding': 'Fundos', 'hdr.kyc': 'Verificação KYC', 'hdr.tradenow': 'Operar agora', 'hdr.notify': 'Notificações',
    'hdr.tagline': 'Pegue o touro pelos chifres',
    'ftr.platform': 'Plataforma', 'ftr.products': 'Produtos', 'ftr.liveMarkets': 'Mercados ao vivo', 'ftr.terminal': 'Terminal de Trading',
    'ftr.bots': 'Bots de Trading', 'ftr.dashboard': 'Painel', 'ftr.funding': 'Fundos', 'ftr.community': 'Comunidade',
    'ftr.createAccount': 'Criar conta', 'ftr.login': 'Entrar', 'ftr.install': 'Instalar app', 'ftr.notify': 'Notificações',
    'ftr.store': 'Loja', 'ftr.mentorship': 'Mentoria Elite', 'ftr.cmf': 'Motor CMF', 'ftr.faq': 'Perguntas frequentes',
    'ftr.contact': 'Contato', 'ftr.fraudAlert': 'Alerta de fraude', 'ftr.fraudText': 'NUNCA enviamos mensagem primeiro nem pedimos cripto. Verifique as contas oficiais na nossa',
    'ftr.fraudLink': 'página de Alerta de Fraude', 'ftr.blurb': 'Plataforma premier de educação cripto e trading. Estrutura em vez de hype — desenvolva habilidades de investimento disciplinadas para cada ciclo de mercado.',
    'ftr.risk': 'Operar envolve riscos. Nada aqui é aconselhamento financeiro.',
    'hero.h1': 'Pegue o touro pelos <span class=\"gold\">CHIFRES</span> 🐂', 'hero.lead': 'Domine o cripto com um sistema simples e comprovado — e coloque-o para trabalhar. Aprenda e opere cripto, ações, índices e ativos reais em uma única conta, com preços ao vivo e um demo gratuito de $10.000.',
    'hero.ctaStart': 'Comece grátis — Demo de $10.000', 'hero.ctaExplore': 'Explore o Terminal',
    'hero.stat1': 'Comunidade TikTok', 'hero.stat2': 'Família Power of Publish', 'hero.stat3': 'Ativos ao vivo', 'hero.stat4': 'Mercados e suporte 24/7',
    'auth.welcomeBack': 'Bem-vindo de volta', 'auth.signupTitle': 'Junte-se ao Blockchain Bullhorn',
    'pwa.installTitle': 'Baixe o app Blockchain Bullhorn', 'pwa.installSub': 'Rápido, tela cheia, funciona offline', 'pwa.installGo': 'Instalar',
    'globe.note': 'Seu país / região determina a moeda de exibição. Idioma e moeda podem ser alterados independentemente — os preços são exibidos na moeda escolhida; as contas e o trading permanecem em USD.'
  },
  de: {
    'nav.markets': 'Märkte', 'nav.trading': 'Trading', 'nav.bots': 'Trading-Bots', 'nav.community': 'Community',
    'nav.products': 'Produkte', 'nav.mentorship': 'Mentoring', 'nav.faq': 'FAQ', 'nav.contact': 'Kontakt',
    'hdr.login': 'Anmelden', 'hdr.signup': 'Kostenlos registrieren', 'hdr.logout': 'Abmelden', 'hdr.dashboard': 'Dashboard',
    'hdr.funding': 'Finanzierung', 'hdr.kyc': 'KYC-Verifizierung', 'hdr.tradenow': 'Jetzt traden', 'hdr.notify': 'Benachrichtigungen',
    'hdr.tagline': 'Pack den Stier bei den Hörnern',
    'ftr.platform': 'Plattform', 'ftr.products': 'Produkte', 'ftr.liveMarkets': 'Live-Märkte', 'ftr.terminal': 'Trading-Terminal',
    'ftr.bots': 'Trading-Bots', 'ftr.dashboard': 'Dashboard', 'ftr.funding': 'Finanzierung', 'ftr.community': 'Community',
    'ftr.createAccount': 'Konto erstellen', 'ftr.login': 'Anmelden', 'ftr.install': 'App installieren', 'ftr.notify': 'Benachrichtigungen',
    'ftr.store': 'Shop', 'ftr.mentorship': 'Elite-Mentoring', 'ftr.cmf': 'CMF-Engine', 'ftr.faq': 'FAQ',
    'ftr.contact': 'Kontakt', 'ftr.fraudAlert': 'Betrugswarnung', 'ftr.fraudText': 'Wir schreiben NIEMALS zuerst und fragen nie nach Krypto. Prüfe offizielle Konten auf unserer',
    'ftr.fraudLink': 'Betrugswarnungs-Seite', 'ftr.blurb': 'Premier-Krypto-Bildungs- und Trading-Plattform. Struktur statt Hype — baue disziplinierte Anlagefähigkeiten für jeden Marktzyklus auf.',
    'ftr.risk': 'Trading birgt Risiken. Nichts hier ist Finanzberatung.',
    'hero.h1': 'Pack den Stier bei den <span class=\"gold\">HÖRNERN</span> 🐂', 'hero.lead': 'Meistere Krypto mit einem einfachen, bewährten System — und setze es ein. Lerne und handle Krypto, Aktien, Indizes und Real-Assets über ein Konto, mit Live-Preisen und einem kostenlosen 10.000-$-Demo.',
    'hero.ctaStart': 'Kostenlos starten — 10.000 $ Demo', 'hero.ctaExplore': 'Terminal entdecken',
    'hero.stat1': 'TikTok-Community', 'hero.stat2': 'Power of Publish Familie', 'hero.stat3': 'Live-verfolgte Assets', 'hero.stat4': 'Märkte & Support 24/7',
    'auth.welcomeBack': 'Willkommen zurück', 'auth.signupTitle': 'Werde Teil des Blockchain Bullhorn',
    'pwa.installTitle': 'Hol dir die Blockchain Bullhorn App', 'pwa.installSub': 'Schnell, im Vollbild, funktioniert offline', 'pwa.installGo': 'Installieren',
    'globe.note': 'Dein Land / deine Region legt die Anzeigewährung fest. Sprache und Währung lassen sich unabhängig ändern — Preise werden in der gewählten Währung angezeigt; Konten und Trading bleiben in USD.'
  },
  zh: {
    'nav.markets': '市场', 'nav.trading': '交易', 'nav.bots': '交易机器人', 'nav.community': '社区',
    'nav.products': '产品', 'nav.mentorship': '精英辅导', 'nav.faq': '常见问题', 'nav.contact': '联系我们',
    'hdr.login': '登录', 'hdr.signup': '免费注册', 'hdr.logout': '退出登录', 'hdr.dashboard': '仪表盘',
    'hdr.funding': '资金', 'hdr.kyc': 'KYC 认证', 'hdr.tradenow': '立即交易', 'hdr.notify': '通知',
    'hdr.tagline': '擒牛执角',
    'ftr.platform': '平台', 'ftr.products': '产品', 'ftr.liveMarkets': '实时行情', 'ftr.terminal': '交易终端',
    'ftr.bots': '交易机器人', 'ftr.dashboard': '仪表盘', 'ftr.funding': '资金', 'ftr.community': '社区',
    'ftr.createAccount': '创建账户', 'ftr.login': '登录', 'ftr.install': '安装应用', 'ftr.notify': '通知',
    'ftr.store': '商店', 'ftr.mentorship': '精英辅导', 'ftr.cmf': 'CMF 引擎', 'ftr.faq': '常见问题',
    'ftr.contact': '联系我们', 'ftr.fraudAlert': '防诈警报', 'ftr.fraudText': '我们绝不会主动私信或索要加密货币。请在我们的人工智能上核实官方账号',
    'ftr.fraudLink': '防诈警报页面', 'ftr.blurb': '顶级加密教育与交易平台。结构胜于炒作 — 培养纪律性投资技能，从容应对每个市场周期。',
    'ftr.risk': '交易有风险。本文内容不构成财务建议。',
    'hero.h1': '抓住牛角，<span class=\"gold\">掌控行情</span> 🐂', 'hero.lead': '用简单且经过验证的系统掌握加密交易 — 然后让它为你工作。一个账户学习并交易加密货币、股票、指数和实物资产，实时价格，另赠 $10,000 免费模拟金。',
    'hero.ctaStart': '免费开始 — 领取 $10,000 模拟金', 'hero.ctaExplore': '探索交易终端',
    'hero.stat1': 'TikTok 社区', 'hero.stat2': 'Power of Publish 家族', 'hero.stat3': '实时追踪资产', 'hero.stat4': '市场与支持 24/7',
    'auth.welcomeBack': '欢迎回来', 'auth.signupTitle': '加入 Blockchain Bullhorn',
    'pwa.installTitle': '获取 Blockchain Bullhorn 应用', 'pwa.installSub': '快速、全屏、离线可用', 'pwa.installGo': '安装',
    'globe.note': '您的国家/地区决定显示货币。语言与货币可独立更改 — 价格以所选货币显示；账户与交易以美元（USD）结算。'
  },
  hi: {
    'nav.markets': 'बाज़ार', 'nav.trading': 'ट्रेडिंग', 'nav.bots': 'ट्रेडिंग बॉट्स', 'nav.community': 'कम्युनिटी',
    'nav.products': 'उत्पाद', 'nav.mentorship': 'मेंटरशिप', 'nav.faq': 'सामान्य प्रश्न', 'nav.contact': 'संपर्क',
    'hdr.login': 'लॉग इन', 'hdr.signup': 'मुफ़्त रजिस्टर करें', 'hdr.logout': 'लॉग आउट', 'hdr.dashboard': 'डैशबोर्ड',
    'hdr.funding': 'फंडिंग', 'hdr.kyc': 'KYC सत्यापन', 'hdr.tradenow': 'अभी ट्रेड करें', 'hdr.notify': 'सूचनाएँ',
    'hdr.tagline': 'बैल के सींग पकड़ो',
    'ftr.platform': 'प्लेटफ़ॉर्म', 'ftr.products': 'उत्पाद', 'ftr.liveMarkets': 'लाइव मार्केट', 'ftr.terminal': 'ट्रेडिंग टर्मिनल',
    'ftr.bots': 'ट्रेडिंग बॉट्स', 'ftr.dashboard': 'डैशबोर्ड', 'ftr.funding': 'फंडिंग', 'ftr.community': 'कम्युनिटी',
    'ftr.createAccount': 'खाता बनाएं', 'ftr.login': 'लॉग इन', 'ftr.install': 'ऐप इंस्टॉल करें', 'ftr.notify': 'सूचनाएँ',
    'ftr.store': 'स्टोर', 'ftr.mentorship': 'एलीट मेंटरशिप', 'ftr.cmf': 'CMF इंजन', 'ftr.faq': 'सामान्य प्रश्न',
    'ftr.contact': 'संपर्क', 'ftr.fraudAlert': 'फ्रॉड अलर्ट', 'ftr.fraudText': 'हम कभी पहले DM नहीं करते और क्रिप्टो नहीं मांगते। हमारे',
    'ftr.fraudLink': 'फ्रॉड अलर्ट पेज', 'ftr.blurb': 'प्रीमियर क्रिप्टो शिक्षा और ट्रेडिंग प्लेटफ़ॉर्म। हाइप नहीं, अनुशासन — हर मार्केट चक्र के लिए अनुशासित निवेश कौशल बनाएं।',
    'ftr.risk': 'ट्रेडिंग में जोखिम है। यहाँ की सामग्री वित्तीय सलाह नहीं है।',
    'hero.h1': 'बैल के <span class=\"gold\">सींग पकड़ो</span> 🐂', 'hero.lead': 'एक सरल, सिद्ध प्रणाली से क्रिप्टो में महारत हासिल करें — फिर उसे काम पर लगाएं। एक ही खाते से क्रिप्टो, स्टॉक, इंडेक्स और रियल-वर्ल्ड एसेट सीखें और ट्रेड करें, लाइव कीमतों और मुफ़्त $10,000 डेमो के साथ।',
    'hero.ctaStart': 'मुफ़्त शुरू करें — $10,000 डेमो पाएं', 'hero.ctaExplore': 'टर्मिनल देखें',
    'hero.stat1': 'TikTok कम्युनिटी', 'hero.stat2': 'Power of Publish परिवार', 'hero.stat3': 'लाइव-ट्रैक किए एसेट', 'hero.stat4': 'मार्केट और सहायता 24/7',
    'auth.welcomeBack': 'वापसी पर स्वागत है', 'auth.signupTitle': 'Blockchain Bullhorn से जुड़ें',
    'pwa.installTitle': 'Blockchain Bullhorn ऐप पाएं', 'pwa.installSub': 'तेज़, फ़ुल-स्क्रीन, ऑफ़लाइन काम करता है', 'pwa.installGo': 'इंस्टॉल करें',
    'globe.note': 'आपका देश / क्षेत्र प्रदर्शन मुद्रा तय करता है। भाषा और मुद्रा स्वतंत्र रूप से बदली जा सकती हैं — कीमतें आपकी चुनी मुद्रा में दिखती हैं; खाते और ट्रेडिंग USD में रहते हैं।'
  }
};

const NAV_LINKS = [
  ['/markets', 'markets'], ['/trade', 'trading'], ['/trading-bots', 'bots'],
  ['/community', 'community'], ['/store', 'products'], ['/mentorship', 'mentorship'],
  ['/faq', 'faq'], ['/contact', 'contact']
];

function renderHeader() {
  const el = $('#site-header'); if (!el) return;
  const here = location.pathname;
  const links = NAV_LINKS.map(([href, key]) =>
    `<a href="${href}" class="${here === href ? 'active' : ''}">${BB.t('nav.' + key)}</a>`).join('');
  el.innerHTML = `
  <div class="announce" id="announce"></div>
  <div class="container-wide header-inner">
    <a class="brand" href="/">
      <img src="/assets/img/brand/logo.png" alt="Blockchain Bullhorn logo">
      <div class="brand-name">Blockchain <span>Bullhorn</span><small data-i18n="hdr.tagline">Grab the Bull by the Horns</small></div>
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
  const bbC = BB.country();
  const GLOBE = `
    <div class="globe-wrap" id="globeWrap">
      <button class="globe-btn" id="globeBtn" aria-label="Country, language and currency" aria-haspopup="true">${bbC ? flagOf(bbC) : '🌐'} <b>${BB.lang.toUpperCase()}</b><i class="fas fa-chevron-down" style="font-size:8px;margin-left:4px"></i></button>
      <div class="globe-menu" id="globeMenu">
        <div class="gm-head">🌍 Country / Region <small style="letter-spacing:0;text-transform:none">— sets your currency</small></div>
        <input class="input gm-search" id="gmSearch" placeholder="Search country…" autocomplete="off">
        <div class="gm-countries" id="gmCountries">
          ${CTRY.map(x => `<button class="gm-item${x.c === bbC ? ' active' : ''}" data-country="${x.c}"><span class="gm-flag">${flagOf(x.c)}</span>${x.n}</button>`).join('')}
        </div>
        <div class="gm-head">🌐 Language</div>
        ${LANGS.map(l => `<button class="gm-item${l.c === BB.lang ? ' active' : ''}" data-lang="${l.c}"><span class="gm-flag">${l.f}</span>${l.n}</button>`).join('')}
        <div class="gm-head">💰 Currency</div>
        ${Object.entries(CURS).map(([c, m]) => `<button class="gm-item gm-cur${c === BB.cur ? ' active' : ''}" data-cur="${c}"><span class="gm-flag">${m.f}</span>${m.n} <small>${c}</small></button>`).join('')}
        <div class="gm-note">${BB.t('globe.note')}</div>
      </div>
    </div>`;
  if (BB.user) {
    const kyc = BB.user.kycStatus;
    const initials = (BB.user.name || BB.user.email).split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
    el.innerHTML = `
      ${GLOBE}
      <a href="/dashboard" class="btn btn-ghost btn-sm"><i class="fas fa-gauge-high"></i> ${BB.t('hdr.dashboard')}</a>
      <div class="user-chip">
        <div class="avatar" id="avatarBtn" style="background:${BB.user.avatarColor || '#d3a877'}">${BB.esc(initials)}</div>
        <div class="user-menu" id="userMenu">
          <div class="um-head"><b>${BB.esc(BB.user.name || BB.user.email)}</b>
            <small>${BB.esc(BB.user.email)}</small>
            <div class="mt-1"><span class="kyc-pill ${kyc}">${kyc === 'approved' ? '✔ Verified' : kyc === 'pending' ? '⏳ KYC Review' : kyc === 'rejected' ? '✖ KYC Rejected' : 'KYC Required'}</span></div>
          </div>
          <a href="/dashboard"><i class="fas fa-gauge-high"></i> ${BB.t('hdr.dashboard')}</a>
          <a href="/funding"><i class="fas fa-wallet"></i> ${BB.t('hdr.funding')}</a>
          <a href="/trading-bots"><i class="fas fa-robot"></i> ${BB.t('hdr.bots')}</a>
          <a href="/kyc"><i class="fas fa-id-card"></i> ${BB.t('hdr.kyc')}</a>
          <a href="/trade"><i class="fas fa-chart-line"></i> ${BB.t('hdr.tradenow')}</a>
          <a href="#" id="menuNotify"><i class="fas fa-bell"></i> ${BB.t('hdr.notify')}</a>
          <button id="logoutBtn"><i class="fas fa-arrow-right-from-bracket"></i> ${BB.t('hdr.logout')}</button>
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
      ${GLOBE}
      <a href="/login" class="btn btn-outline btn-sm" data-i18n="hdr.login">Log In</a>
      <a href="/signup" class="btn btn-primary btn-sm"><i class="fas fa-bolt"></i> <span data-i18n="hdr.signup">Sign Up Free</span></a>`;
  }
  bindGlobe();
}

function bindGlobe() {
  const btn = $('#globeBtn'); if (!btn) return;
  const menu = $('#globeMenu');
  btn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
  document.addEventListener('click', () => menu.classList.remove('open'));
  menu.addEventListener('click', e => {
    e.stopPropagation();
    const co = e.target.closest('[data-country]');
    if (co) { BB.setCountry(co.dataset.country); return; }  // sets currency too, re-renders
    const l = e.target.closest('[data-lang]');
    if (l) { BB.setLang(l.dataset.lang); return; }          // re-renders header incl. picker
    const c = e.target.closest('[data-cur]');
    if (c) { BB.setCur(c.dataset.cur); renderHeader(); renderFooter(); } // refresh active states
  });
  const search = $('#gmSearch');
  if (search) search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    $$('#gmCountries .gm-item').forEach(b => {
      b.style.display = !q || b.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

function renderFooter() {
  const el = $('#site-footer'); if (!el) return;
  el.innerHTML = `
  <div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <img src="/assets/img/brand/logo.png" alt="Blockchain Bullhorn">
        <p data-i18n="ftr.blurb">Premier crypto education &amp; trading platform. Structure over hype — build disciplined investing skills for every market cycle.</p>
        <div class="socials">
          <a href="https://www.tiktok.com/@blockchainbullhorn" target="_blank" rel="noopener" title="TikTok (Official)"><i class="fab fa-tiktok"></i></a>
          <a href="https://www.instagram.com/blockchainbullhorn" target="_blank" rel="noopener" title="Instagram"><i class="fab fa-instagram"></i></a>
          <a href="https://x.com/Blockchainbhorn" target="_blank" rel="noopener" title="X / Twitter"><i class="fab fa-x-twitter"></i></a>
          <a href="https://www.youtube.com/@blockchainbullhorn" target="_blank" rel="noopener" title="YouTube"><i class="fab fa-youtube"></i></a>
        </div>
        <div class="footer-fraud">⚠️ <b>${BB.t('ftr.fraudAlert')}:</b> ${BB.t('ftr.fraudText')} <a href="/avoid-scams" style="color:#ffd7de;text-decoration:underline">${BB.t('ftr.fraudLink')}</a>.</div>
      </div>
      <div>
        <h5 data-i18n="ftr.platform">Platform</h5>
        <div class="footer-links">
          <a href="/markets" data-i18n="ftr.liveMarkets">Live Markets</a><a href="/trade" data-i18n="ftr.terminal">Trading Terminal</a>
          <a href="/trading-bots" data-i18n="ftr.bots">Trading Bots</a>
          <a href="/dashboard" data-i18n="ftr.dashboard">Dashboard</a><a href="/funding" data-i18n="ftr.funding">Funding</a>
          <a href="/community"><span data-i18n="ftr.community">Community</span> <i class="fas fa-lock" style="font-size:9px;color:var(--gold)"></i></a>
          <a href="/signup" data-i18n="ftr.createAccount">Create Account</a>
          <a href="/login" data-i18n="ftr.login">Log In</a>
          <a href="#" id="footInstall"><i class="fas fa-mobile-screen-button"></i> <span data-i18n="ftr.install">Install App</span></a>
          <a href="#" id="footNotify"><i class="fas fa-bell"></i> <span data-i18n="ftr.notify">Notifications</span></a>
        </div>
      </div>
      <div>
        <h5 data-i18n="ftr.products">Products</h5>
        <div class="footer-links">
          <a href="/store" data-i18n="ftr.store">Store</a><a href="/mentorship" data-i18n="ftr.mentorship">Elite Mentorship</a>
          <a href="/cmf-engine" data-i18n="ftr.cmf">CMF Engine</a><a href="/faq" data-i18n="ftr.faq">FAQ</a>
          <a href="/contact" data-i18n="ftr.contact">Contact</a><a href="/avoid-scams" data-i18n="ftr.fraudAlert">Fraud Alert</a>
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
        <span class="price">${BB.sym()}${BB.fmtPrice(a.price)}</span>
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
  convId: null, lastAt: 0, open: false, unread: 0, pollTimer: null, initialized: false, builtIn: false,

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
      // Watchdog: if the Smartsupp widget never appears (bad key, account
      // issue, or script blocked), show the built-in launcher instead so
      // the site always has a chat icon. If Smartsupp shows up later, the
      // built-in launcher steps aside.
      const seen = () => document.querySelector('iframe[src*="smartsupp"], iframe[id^="smartsupp"], div[id^="smartsupp"]');
      let waited = 0;
      const iv = setInterval(() => {
        if (seen()) {
          clearInterval(iv);
          const b = $('.chat-launcher'); if (b) b.style.display = 'none';
          const w = $('.chat-window'); if (w && w.classList.contains('open')) Chat.toggle(false);
        } else {
          waited += 2;
          if (waited === 10 && !Chat.builtIn) Chat.ensureBuiltIn();
          if (waited >= 60) clearInterval(iv);
        }
      }, 2000);
      return;
    }
    Chat.ensureBuiltIn();
  },

  // Built-in widget (Branded "Blockchain Bullhorn Support", logo avatar) — idempotent
  ensureBuiltIn() {
    if (Chat.builtIn) return; Chat.builtIn = true;
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

// ---------- announcement live-feed bar ----------
function renderAnnouncement() {
  const bar = $('#announce'); if (!bar) return;
  const items = (BB.settings.announcements || []).map(x => String(x || '').trim()).filter(Boolean);
  if (!items.length) { bar.classList.remove('show'); bar.innerHTML = ''; return; }
  bar.classList.add('show');
  bar.innerHTML = `<span class="announce-label"><i class="fas fa-bullhorn"></i><span>ANNOUNCEMENT${items.length > 1 ? 'S' : ''}</span></span>` +
    `<div class="announce-stage" id="announceStage"><div class="announce-item" id="announceItem"></div></div>` +
    (items.length > 1 ? `<span class="announce-count" id="announceCount">1/${items.length}</span>` : '');
  const stage = $('#announceStage'), item = $('#announceItem'), count = $('#announceCount');
  const FX = ['fx-roll', 'fx-fade', 'fx-wipe', 'fx-slide'];
  let idx = 0, fx = 0, paused = false, timer = null;
  const holdMs = t => Math.min(14000, Math.max(4200, 3200 + t.length * 55));
  const run = (fn, ms) => { // pause-aware scheduler (hover pauses the feed)
    const t0 = Date.now();
    const tick = () => {
      if (paused) { timer = setTimeout(tick, 250); return; }
      const left = ms - (Date.now() - t0);
      if (left > 0) timer = setTimeout(tick, Math.min(left + 1, 250)); else fn();
    };
    timer = setTimeout(tick, Math.min(ms + 1, 250));
  };
  const display = () => {
    const text = items[idx];
    item.className = 'announce-item';
    item.textContent = text;
    if (count) count.textContent = `${idx + 1}/${items.length}`;
    requestAnimationFrame(() => {
      const overflow = item.scrollWidth - stage.clientWidth;
      if (overflow > 24) {
        // long announcement → scrolls across in full, like a live feed
        const dur = Math.max(6, (stage.clientWidth + item.scrollWidth) / 55);
        item.style.setProperty('--fromX', (stage.clientWidth + 12) + 'px');
        item.style.setProperty('--toX', (-item.scrollWidth - 12) + 'px');
        item.style.animationDuration = dur + 's';
        item.classList.add('marquee');
        run(exit, (dur + 1.2) * 1000);
      } else {
        const effect = FX[fx++ % FX.length]; // rotate: roll → fade → wipe → slide
        item.classList.add(effect, 'in');
        run(exit, holdMs(text));
      }
    });
  };
  const exit = () => {
    const wasMarquee = item.classList.contains('marquee');
    item.classList.remove('in');
    if (wasMarquee) { item.classList.remove('marquee'); item.style.animationDuration = ''; item.classList.add('fx-fade'); }
    item.classList.add('out');
    run(() => { idx = (idx + 1) % items.length; display(); }, 800);
  };
  bar.addEventListener('mouseenter', () => { paused = true; item.style.animationPlayState = 'paused'; });
  bar.addEventListener('mouseleave', () => { paused = false; item.style.animationPlayState = ''; });
  display();
}

// ---------- PWA: install + web push ----------
const PWA = {
  deferredPrompt: null,

  urlBase64ToUint8Array(b64) {
    const padding = '='.repeat((4 - b64.length % 4) % 4);
    const base64 = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64), arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  },

  isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); },

  refreshBannerText() {
    const b = $('#bbInstallBanner'); if (!b) return;
    const t1 = b.querySelector('.ib-txt b'); if (t1) t1.textContent = BB.t('pwa.installTitle');
    const ts = b.querySelector('.ib-txt small span'); if (ts) ts.textContent = BB.t('pwa.installSub');
    const g = b.querySelector('.ib-go'); if (g) g.textContent = BB.t('pwa.installGo');
  },
  isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; },

  async registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try { await navigator.serviceWorker.register('/sw.js'); } catch (e) { /* offline support best-effort */ }
  },

  maybeInstallBanner() {
    if (this.isStandalone() || localStorage.getItem('bbInstallDismissed')) return;
    const show = (mode) => {
      if ($('#bbInstallBanner')) return;
      const b = document.createElement('div');
      b.id = 'bbInstallBanner';
      b.innerHTML = `
        <img src="/assets/img/brand/logo.png" alt="">
        <div class="ib-txt"><b data-i18n="pwa.installTitle">Get the Blockchain Bullhorn app</b>
          <small>${mode === 'ios' ? 'Tap <b>Share</b> ⬆️ then <b>Add to Home Screen</b>' : '<span data-i18n="pwa.installSub">Fast, full-screen, works offline</span>'}</small></div>
        ${mode === 'ios' ? '' : '<button class="ib-go" id="bbInstallGo" data-i18n="pwa.installGo">Install</button>'}
        <button class="ib-x" aria-label="Dismiss">✕</button>`;
      document.body.appendChild(b);
      const dismiss = () => { localStorage.setItem('bbInstallDismissed', '1'); b.remove(); };
      b.querySelector('.ib-x').addEventListener('click', dismiss);
      const go = $('#bbInstallGo');
      if (go) go.addEventListener('click', async () => {
        if (!PWA.deferredPrompt) return;
        PWA.deferredPrompt.prompt();
        const c = await PWA.deferredPrompt.userChoice;
        if (c && c.outcome === 'accepted') { localStorage.setItem('bbInstallDismissed', '1'); b.remove(); }
        PWA.deferredPrompt = null;
      });
      setTimeout(() => b.classList.add('show'), 600);
    };
    if (this.isIOS()) setTimeout(() => show('ios'), 2500);
  },

  async notificationsModal() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) return BB.toast('Notifications are not supported by this browser.', 'error');
    const cfg = await BB.api('/api/push/config', { silent: true });
    if (!cfg.ready) return BB.toast('Notifications are not set up on the server yet — try again soon.', 'error');
    const perm = Notification.permission;
    let sub = null;
    try { const reg = await navigator.serviceWorker.ready; sub = await reg.pushManager.getSubscription(); } catch (e) { /* noop */ }
    const body = `
      <div style="text-align:center;padding:6px 0 2px">
        <i class="fas fa-bell" style="font-size:34px;color:var(--gold-deep)"></i>
        <p class="muted" style="font-size:13.5px;line-height:1.6;margin:10px 0 4px">Get pop-up notifications for deposits, withdrawals, KYC results, bot activity and platform announcements — even when the app is closed.</p>
        <p class="small" style="font-size:12px">Status: <b>${perm === 'granted' && sub ? '🔔 Enabled' : perm === 'denied' ? '⛔ Blocked in browser settings' : '🔕 Not enabled'}</b></p>
        ${PWA.isIOS() && !PWA.isStandalone() ? '<p class="small" style="font-size:11.5px;color:#b3541e">On iPhone/iPad, notifications require the installed app: tap Share ⬆️ → Add to Home Screen first.</p>' : ''}
        <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
          ${perm === 'denied' ? '' : (sub
            ? '<button class="btn btn-outline" id="nwOff">Turn Off</button>'
            : '<button class="btn btn-primary" id="nwOn">Enable Notifications</button>')}
          <button class="btn btn-ghost" data-close-modal>Close</button>
        </div>
      </div>`;
    const bd = BB.modal('Notifications', body);
    const cb = bd.querySelector('[data-close-modal]');
    if (cb) cb.addEventListener('click', () => bd.remove());
    const on = $('#nwOn', bd), off = $('#nwOff', bd);
    if (on) on.addEventListener('click', async () => {
      on.disabled = true; on.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
      try {
        const p = await Notification.requestPermission();
        if (p !== 'granted') throw new Error('Permission was not granted. Check your browser notification settings.');
        const reg = await navigator.serviceWorker.ready;
        const s2 = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: PWA.urlBase64ToUint8Array(cfg.publicKey) });
        const j = s2.toJSON();
        const r = await BB.api('/api/push/subscribe', { method: 'POST', body: { endpoint: j.endpoint, keys: j.keys } });
        if (!r.ok) throw new Error(r.error || 'Could not save the subscription.');
        bd.remove(); BB.toast('🔔 Notifications enabled!', 'success');
      } catch (e) { BB.toast(e.message, 'error'); on.disabled = false; on.innerHTML = 'Enable Notifications'; }
    });
    if (off) off.addEventListener('click', async () => {
      try {
        if (sub) { await sub.unsubscribe(); await BB.api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); }
        bd.remove(); BB.toast('Notifications turned off.', 'success');
      } catch (e) { BB.toast(e.message, 'error'); }
    });
  },

  init() {
    this.registerSW();
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.maybeInstallBanner();
    });
    window.addEventListener('appinstalled', () => { const b = $('#bbInstallBanner'); if (b) b.remove(); localStorage.setItem('bbInstallDismissed', '1'); });
    if (this.isIOS()) this.maybeInstallBanner();
    const openNotify = e => { e.preventDefault(); PWA.notificationsModal(); };
    const mn = $('#menuNotify'); if (mn) mn.addEventListener('click', openNotify);
    const fn = $('#footNotify'); if (fn) fn.addEventListener('click', openNotify);
    const fi = $('#footInstall'); if (fi) fi.addEventListener('click', e => {
      e.preventDefault();
      if (PWA.deferredPrompt) { PWA.deferredPrompt.prompt(); PWA.deferredPrompt = null; }
      else if (PWA.isIOS()) BB.toast('On iPhone/iPad: tap the Share button ⬆️ then "Add to Home Screen".', 'info');
      else if (PWA.isStandalone()) BB.toast('You already have the app installed 🎉', 'success');
      else BB.toast('Use your browser menu: "Install app" / "Add to Home screen".', 'info');
    });
  }
};

// ---------- boot ----------
async function bootCommon() {
  Motion.init();
  document.documentElement.lang = BB.lang;
  const [settingsR, meR, fxR] = await Promise.all([
    BB.api('/api/settings/public', { silent: true }),
    BB.api('/api/auth/me', { silent: true }),
    BB.api('/api/fx', { silent: true })
  ]);
  if (settingsR.ok) BB.settings = Object.assign(BB.settings, settingsR);
  if (meR.ok && meR.user) {
    BB.user = meR.user;
    // the country on the user's account determines the display currency
    if (!localStorage.getItem('bbCurSet')) {
      const iso = (CTRY.find(x => x.n === BB.user.country) || {}).c;
      if (iso && !localStorage.getItem('bbCountry')) BB.setCountry(iso, { toast: false });
    }
  }
  if (fxR.ok && fxR.rates) {
    BB.fx.rates = fxR.rates; BB.fx.ready = true;
    BB.fx.rate = fxR.rates[BB.cur] || 1;
  }
  renderHeader();
  renderFooter();
  renderAnnouncement();
  BB.applyLang();
  BB.applyUsd();
  initReveal();
  initCounters();
  loadTicker();
  Chat.init();
  PWA.init();
  // any element with data-open-chat opens the support live chat (Smartsupp or built-in)
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-open-chat]');
    if (t) { e.preventDefault(); BB.openChat(); }
  });
  document.dispatchEvent(new CustomEvent('bb:ready'));
}

document.addEventListener('DOMContentLoaded', bootCommon);
