'use strict';
/* ============================================================
   Blockchain Bullhorn — guided walkthrough
   A step-by-step tour that shows people around the site: what each
   area is for, what to do first, and where their money lives.
   - spotlights the real element on the page with a cut-out overlay
   - auto-starts once per browser (skippable), restartable any time
     from the header "Guide" item or the dashboard checklist
   - keyboard: ← → to move, Esc to exit; fully reduced-motion aware
   ============================================================ */
(function () {
  if (window.BBTour) return;

  const SEEN_KEY = 'bbTourSeen_v1';
  const STEP_KEY = 'bbTourStep_v1';

  /* Each step: a target selector (or null for a centred card), a title, a body
     and optionally the route it lives on. Steps whose target isn't on the
     current page are skipped, so one guide works everywhere. */
  const STEPS = [
    {
      sel: '.brand',
      title: 'Welcome to Blockchain Bullhorn 🐂',
      body: 'This 60-second tour shows you around. You can leave at any time with <b>Skip tour</b>, and restart it later from <b>More → Guide</b>.'
    },
    {
      sel: '#langWrap',
      title: 'Language & currency',
      body: 'Pick your language and the currency prices are displayed in. Your choice is remembered on this device — accounts are always held in USD.'
    },
    {
      sel: '.ticker-bar',
      title: 'Live market ticker',
      body: 'Real prices from CoinGecko and Yahoo Finance, streaming across the top of every page. Tap a coin to open its full chart.'
    },
    {
      sel: '.main-nav a[href="/markets"]',
      title: 'Markets',
      body: '160+ assets — crypto, stocks, commodities and indices — with live prices, 24h range, trends and market caps. Filter, search and star anything to watch it.'
    },
    {
      sel: '.main-nav a[href="/trade"]',
      title: 'Trading terminal',
      body: 'Charts, buy/sell orders, leverage and your open positions. Start on the <b>$10,000 demo</b> — it uses the same live prices with zero risk.'
    },
    {
      sel: '.main-nav a[href="/trading-bots"]',
      title: 'Trading bots',
      body: 'Hands-off strategies that trade for you. Every bot is reviewed by hand and you request a private connection key to activate one.'
    },
    {
      sel: '#navDropBtn, .nav-toggle',
      title: 'Everything else lives in “More”',
      body: 'Funding, the Academy, the free checklist, support and your account settings are all under this menu.'
    },
    {
      sel: '#headerActions .btn-primary, #headerActions .user-chip, .nav-toggle',
      title: 'Create your account',
      body: 'Signing up takes a minute and unlocks the demo account. Already registered? Your dashboard is one click away.',
      route: '/'
    },
    {
      sel: '#kycCard',
      title: 'Step 1 — verify your identity',
      body: 'Live money, deposits and bots need a quick ID check. Our team reviews every document by hand — nothing is approved automatically.',
      route: '/dashboard'
    },
    {
      sel: '#gettingStarted',
      title: 'Step 2 — follow the checklist',
      body: 'This card tracks your setup from verified account to first trade. It ticks itself off as you go, so you always know the next step.',
      route: '/dashboard'
    },
    {
      sel: '#balCards',
      title: 'Step 3 — know your balances',
      body: 'Demo balance, live balance, open positions and pending items at a glance. Demo credit is free; live funds come from your own deposits.'
    },
    {
      sel: '#portfolioCard',
      title: 'Your portfolio',
      body: 'Allocation, exposure and performance for demo and live accounts, side by side.'
    },
    {
      sel: '#positionsBox',
      title: 'Positions & orders',
      body: 'Everything you have open, with live P/L. Close a position here or from the terminal — the cash lands back in your wallet instantly.'
    },
    {
      sel: '#historyBox',
      title: 'Trade history',
      body: 'Every closed trade, with entry, exit and realised P/L. Useful for reviewing what actually worked.'
    },
    {
      sel: '#twofaBox',
      title: 'Protect your account',
      body: 'Turn on two-factor authentication here. We recommend it before you ever move live funds onto the platform.'
    }
  ];

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let idx = 0;
  let active = [];
  let root = null;
  let onResize = null;

  function currentPath() {
    return location.pathname.replace(/\/+$/, '') || '/';
  }

  /* Steps that can actually run on this page: a step is usable when it has no
     route (global) or its route matches, AND its target exists right now. */
  function buildQueue() {
    const path = currentPath();
    return STEPS.filter(s => {
      if (s.route && s.route !== path) return false;
      if (!s.sel) return true;
      return !!$(s.sel);
    });
  }

  function markSeen(v) {
    try { localStorage.setItem(SEEN_KEY, v ? '1' : '0'); } catch (e) {}
  }
  function hasSeen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return true; }
  }

  function ensureRoot() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'bb-tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Site guide');
    root.innerHTML = `
      <div class="bbt-hole" aria-hidden="true"></div>
      <div class="bbt-card" role="document">
        <div class="bbt-top">
          <span class="bbt-step" id="bbtStep">Step 1 of 8</span>
          <button class="bbt-close" id="bbtClose" aria-label="Close guide"><i class="fas fa-times"></i></button>
        </div>
        <h3 id="bbtTitle">Welcome</h3>
        <p id="bbtBody"></p>
        <div class="bbt-bar"><i id="bbtProg"></i></div>
        <div class="bbt-actions">
          <button class="btn btn-outline btn-sm" id="bbtPrev"><i class="fas fa-arrow-left"></i> Back</button>
          <button class="btn btn-green btn-sm" id="bbtNext">Next <i class="fas fa-arrow-right"></i></button>
        </div>
        <button class="bbt-skip" id="bbtSkip">Skip tour</button>
      </div>`;
    document.body.appendChild(root);

    $('#bbtClose', root).addEventListener('click', () => finish(true));
    $('#bbtSkip', root).addEventListener('click', () => finish(true));
    $('#bbtNext', root).addEventListener('click', () => go(idx + 1));
    $('#bbtPrev', root).addEventListener('click', () => go(idx - 1));
    root.addEventListener('click', e => { if (e.target === root) finish(true); });
    return root;
  }

  function placeFor(el) {
    const hole = $('.bbt-hole', root);
    const card = $('.bbt-card', root);
    const pad = 8;
    if (!el) {
      hole.style.opacity = '0';
      root.classList.remove('has-hole');
      card.classList.add('centre');
      card.style.top = '';
      card.style.left = '';
      card.style.right = '';
      card.style.bottom = '';
      return;
    }
    card.classList.remove('centre');
    root.classList.add('has-hole');
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    hole.style.opacity = '1';
    hole.style.top = Math.max(0, r.top - pad) + 'px';
    hole.style.left = Math.max(0, r.left - pad) + 'px';
    hole.style.width = Math.min(vw, r.width + pad * 2) + 'px';
    hole.style.height = Math.min(vh, r.height + pad * 2) + 'px';
    hole.style.borderRadius = Math.max(8, Math.min(18, r.height / 2 + 6)) + 'px';

    // put the card below the spotlight when there is room, otherwise above it
    const cw = Math.min(380, vw - 24);
    card.style.width = cw + 'px';
    let left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), vw - cw - 12);
    const below = r.bottom + 16;
    const cardH = card.offsetHeight || 220;
    let top = below + cardH < vh - 12 ? below : Math.max(12, r.top - cardH - 16);
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }

  function render() {
    const step = active[idx];
    if (!step) return finish(true);
    ensureRoot().classList.add('show');
    const el = step.sel ? $(step.sel) : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    setTimeout(() => {
      $('#bbtStep', root).textContent = `Step ${idx + 1} of ${active.length}`;
      $('#bbtTitle', root).innerHTML = step.title;
      $('#bbtBody', root).innerHTML = step.body;
      $('#bbtProg', root).style.width = ((idx + 1) / active.length * 100) + '%';
      $('#bbtPrev', root).disabled = idx === 0;
      $('#bbtNext', root).innerHTML = idx === active.length - 1
        ? 'Finish <i class="fas fa-check"></i>'
        : 'Next <i class="fas fa-arrow-right"></i>';
      placeFor(el);
    }, reduceMotion ? 0 : 320);
  }

  function go(n) {
    if (n < 0) return;
    if (n >= active.length) return finish(false);
    idx = n;
    try { sessionStorage.setItem(STEP_KEY, String(idx)); } catch (e) {}
    render();
  }

  function finish(skipped) {
    markSeen(true);
    try { sessionStorage.removeItem(STEP_KEY); } catch (e) {}
    if (root) {
      root.classList.remove('show');
      setTimeout(() => { if (root && root.parentNode) { root.parentNode.removeChild(root); root = null; } }, reduceMotion ? 0 : 220);
    }
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('bb-tour-open');
    if (!skipped && window.BB && BB.toast) BB.toast('Tour complete — you can replay it any time from More → Guide', 'success');
  }

  function onKey(e) {
    if (!root) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(true); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(idx + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
  }

  function start(opts) {
    opts = opts || {};
    active = buildQueue();
    if (!active.length) active = [{ title: 'Welcome', body: 'Nothing to show on this page yet.' }];
    idx = 0;
    document.body.classList.add('bb-tour-open');
    render();
    onResize = () => { if (root) placeFor(active[idx] && active[idx].sel ? $(active[idx].sel) : null); };
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);
    if (!opts.manual) markSeen(true);
  }

  /* Auto-start once, on the page the visitor lands on first. */
  let autoScheduled = false;
  function maybeAutoStart() {
    if (autoScheduled || root || hasSeen()) return;
    autoScheduled = true;
    if (location.pathname === '/login' || location.pathname === '/signup' ||
        location.pathname === '/admin' || location.pathname === '/offline') return;
    setTimeout(() => start({}), 1400);
  }

  window.BBTour = {
    start,
    restart: () => start({ manual: true }),
    reset: () => { markSeen(false); },
    steps: STEPS
  };

  document.addEventListener('bb:ready', maybeAutoStart);
  if (document.readyState !== 'loading') setTimeout(() => { if (window.BB) maybeAutoStart(); }, 0);
})();
