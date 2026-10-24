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
      mobileSel: '#mainNav.mobile-open a[href="/markets"]',
      needMenu: true,
      title: 'Markets',
      body: '160+ assets — crypto, stocks, commodities and indices — with live prices, 24h range, trends and market caps. Filter, search and star anything to watch it.'
    },
    {
      sel: '.main-nav a[href="/trade"]',
      mobileSel: '#mainNav.mobile-open a[href="/trade"]',
      needMenu: true,
      title: 'Trading terminal',
      body: 'Charts, buy/sell orders, leverage and your open positions. Start on the <b>$10,000 demo</b> — it uses the same live prices with zero risk.'
    },
    {
      sel: '.main-nav a[href="/trading-bots"]',
      mobileSel: '#mainNav.mobile-open a[href="/trading-bots"]',
      needMenu: true,
      title: 'Trading bots',
      body: 'Hands-off strategies that trade for you. Every bot is reviewed by hand and you request a private connection key to activate one.'
    },
    {
      sel: '#navDropBtn, .nav-toggle',
      mobileSel: '#navToggle',
      title: 'Everything else lives in “More”',
      body: 'Funding, the Academy, the free checklist, support and your account settings are all under this menu.'
    },
    {
      sel: '#headerActions .btn-primary, #headerActions .user-chip, #navToggle',
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
  let onScroll = null;
  let scrollRaf = 0;

  /* ---- geometry helpers ---------------------------------------------- */
  // The header is sticky, so anything scrolled to must clear its real height.
  function headerH() {
    const h = $('.site-header');
    if (!h) return 0;
    const r = h.getBoundingClientRect();
    // only count it while it is actually pinned to the top of the viewport
    return r.top <= 1 ? Math.round(r.height) : 0;
  }

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  }

  // first *visible* match from a comma-separated selector list. It has to scan
  // every match, not just the first one: the mobile panel holds a second copy of
  // each nav link, and the copy that comes first in the DOM is the hidden one.
  function pick(sel) {
    if (!sel) return null;
    for (const part of sel.split(',')) {
      for (const el of $$(part.trim())) if (visible(el)) return el;
    }
    return null;
  }

  function targetFor(step) {
    if (!step) return null;
    return pick(step.sel) || pick(step.mobileSel) || null;
  }

  // Mobile: the nav links live inside the collapsed panel, so open it for the
  // steps that point at them (and close it again for every other step).
  function syncMenu(step) {
    const panel = $('#mainNav');
    if (!panel) return false;
    const open = panel.classList.contains('mobile-open');
    const isMobile = getComputedStyle($('#navToggle') || panel).display !== 'none';
    if (!isMobile) return false;
    const want = !!(step && step.needMenu);
    if (want === open) return false;
    const btn = $('#navToggle');
    if (btn) btn.click();
    return true;
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
      if ($(s.sel)) return true;
      return !!(s.mobileSel && $(s.mobileSel.split(',')[0].trim() + ', #navToggle'));
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
      <i class="bbt-arrow" aria-hidden="true"></i>
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
    // NOTE: appended to <html>, not <body>. `html.js body` runs the page-in
    // transition with `animation-fill-mode: both`, so <body> always keeps a
    // transform — and a transformed ancestor turns position:fixed into
    // "relative to the whole document". That made the overlay 12,800px tall and
    // pushed every spotlight/card off by the scroll offset.
    document.documentElement.appendChild(root);

    $('#bbtClose', root).addEventListener('click', () => finish(true));
    $('#bbtSkip', root).addEventListener('click', () => finish(true));
    $('#bbtNext', root).addEventListener('click', () => go(idx + 1));
    $('#bbtPrev', root).addEventListener('click', () => go(idx - 1));
    root.addEventListener('click', e => { if (e.target === root) finish(true); });
    return root;
  }

  /* Scroll the target into a comfortable position under the sticky header.
     Resolves once the page has stopped moving so the spotlight lands exactly
     on the element instead of on wherever it was mid-scroll. */
  function ensureInView(el) {
    const top = el.getBoundingClientRect().top + window.scrollY;
    const hh = headerH() + 12;
    const h = el.getBoundingClientRect().height;
    const vh = window.innerHeight;
    const want = Math.max(0, top - hh - Math.max(0, (vh - hh - h) / 2 - 60));
    if (Math.abs(window.scrollY - want) < 6) return Promise.resolve();
    window.scrollTo({ top: want, behavior: reduceMotion ? 'auto' : 'smooth' });
    return new Promise(res => {
      let last = window.scrollY, still = 0, done = false;
      const stop = () => { if (!done) { done = true; res(); } };
      const tick = () => {
        if (done) return;
        if (Math.abs(window.scrollY - last) < 1) { still++; } else { still = 0; }
        last = window.scrollY;
        if (still >= 3) return stop();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      setTimeout(stop, 800); // safety net (reduced motion / no scroll needed)
    });
  }

  /* Place the spotlight over the target and dock the card in the roomiest gap
     around it. The spotlight is capped so a very tall section (a whole card,
     the portfolio block) can never swallow the whole screen — there is always
     room for the explanation next to it. */
  function placeFor(el) {
    const hole = $('.bbt-hole', root);
    const card = $('.bbt-card', root);
    const arrowEl = $('.bbt-arrow', root);
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 12;        // viewport margin
    const GAP = 16;      // distance between spotlight and card

    if (!el || !visible(el)) {
      hole.style.opacity = '0';
      root.classList.remove('has-hole');
      card.classList.add('centre');
      card.dataset.arrow = 'none';
      card.style.maxHeight = '';
      card.style.top = '';
      card.style.left = '';
      if (arrowEl) arrowEl.style.display = 'none';
      return;
    }

    card.classList.remove('centre');
    root.classList.add('has-hole');

    const r = el.getBoundingClientRect();
    const hh = headerH();
    const topLimit = hh + 6;

    // spotlight: hug the element, but never taller than ~60% of the viewport
    const maxHoleH = Math.min(vh - topLimit - M, Math.round(vh * 0.6));
    const holeH = Math.min(r.height + pad * 2, maxHoleH);
    const holeTop = clamp(r.top - pad, topLimit, Math.max(topLimit, vh - M - holeH));
    const holeLeft = Math.max(0, r.left - pad);
    const holeW = Math.min(vw - holeLeft, r.width + pad * 2);

    hole.style.opacity = '1';
    hole.style.top = Math.round(holeTop) + 'px';
    hole.style.left = Math.round(holeLeft) + 'px';
    hole.style.width = Math.round(holeW) + 'px';
    hole.style.height = Math.round(holeH) + 'px';
    hole.style.borderRadius = Math.max(8, Math.min(18, r.height / 2 + 6)) + 'px';

    // card: measure it, then choose the side with room
    const cw = Math.min(380, vw - M * 2);
    card.style.width = cw + 'px';
    card.style.maxHeight = '';
    const naturalH = card.offsetHeight;

    const below = vh - (holeTop + holeH) - GAP - M;
    const above = holeTop - GAP - M;

    let top, arrow;
    if (below >= naturalH || below >= above) {
      arrow = 'up';
      card.style.maxHeight = Math.max(150, below) + 'px';
      const ch = card.offsetHeight;                    // re-measure after the cap
      top = Math.min(holeTop + holeH + GAP, vh - M - ch);
    } else {
      arrow = 'down';
      card.style.maxHeight = Math.max(150, above) + 'px';
      const ch = card.offsetHeight;
      top = Math.max(M, holeTop - GAP - ch);
    }
    const ch = card.offsetHeight;

    // centre on the element, then keep the card inside the viewport
    const wanted = r.left + r.width / 2 - cw / 2;
    const left = clamp(wanted, M, Math.max(M, vw - cw - M));

    card.style.top = Math.round(top) + 'px';
    card.style.left = Math.round(left) + 'px';
    card.dataset.arrow = arrow;

    if (arrowEl) {
      const targetX = clamp(r.left + r.width / 2, left + 18, left + cw - 18);
      arrowEl.style.display = 'block';
      arrowEl.style.left = Math.round(targetX - 7) + 'px';
      arrowEl.style.top = Math.round(arrow === 'up' ? top - 7 : top + ch - 7) + 'px';
      arrowEl.style.transform = arrow === 'up' ? 'rotate(45deg)' : 'rotate(225deg)';
    }
  }

  let renderToken = 0;

  function render() {
    const step = active[idx];
    if (!step) return finish(true);
    const token = ++renderToken;
    ensureRoot().classList.add('show');

    const paint = () => {
      const el = targetFor(step);
      $('#bbtStep', root).textContent = `Step ${idx + 1} of ${active.length}`;
      $('#bbtTitle', root).innerHTML = step.title;
      $('#bbtBody', root).innerHTML = step.body;
      $('#bbtProg', root).style.width = ((idx + 1) / active.length * 100) + '%';
      $('#bbtPrev', root).disabled = idx === 0;
      $('#bbtNext', root).innerHTML = idx === active.length - 1
        ? 'Finish <i class="fas fa-check"></i>'
        : 'Next <i class="fas fa-arrow-right"></i>';
      placeFor(el);
      if (!el) return;
      ensureInView(el).then(() => {
        if (token !== renderToken || !root) return;
        placeFor(el);
      });
    };

    // The mobile menu needs a moment to finish opening before its links can be
    // measured, otherwise the spotlight would land on a zero-height element.
    if (syncMenu(step)) {
      setTimeout(() => { if (token === renderToken) paint(); }, reduceMotion ? 40 : 340);
    } else {
      paint();
    }
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
    if (onScroll) { window.removeEventListener('scroll', onScroll); onScroll = null; }
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    syncMenu(null);
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
    const reposition = () => { if (root) placeFor(targetFor(active[idx])); };
    onResize = reposition;
    onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; reposition(); });
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, { passive: true });
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
