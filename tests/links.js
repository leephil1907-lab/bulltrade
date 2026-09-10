/* ============================================================
   Production wiring check — crawls every page and verifies
   that all internal links and referenced assets resolve to 200.
   Usage: node tests/links.js   (server must be running)
   ============================================================ */
'use strict';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PAGES = ['/', '/markets', '/trade', '/trading-bots', '/community', '/dashboard',
  '/funding', '/login', '/signup', '/forgot-password', '/reset-password', '/kyc',
  '/store', '/mentorship', '/cmf-engine', '/faq', '/contact', '/avoid-scams',
  '/legal', '/admin', '/nonexistent-page-404-check'];

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 140) : ''}`); }
};

async function get(url) {
  try {
    const res = await fetch(url, { redirect: 'manual' });
    return res;
  } catch (e) { return { status: 0, error: String(e) }; }
}

(async () => {
  const seen = new Set();
  const queue = [];

  // 1) every page resolves
  for (const p of PAGES) {
    const url = BASE + p;
    const res = await get(url);
    const want = p.includes('404-check') ? 404 : 200;
    ok(`page ${p} → ${want}`, res.status === want, res.status);
    if (res.status === 200) queue.push(url);
  }

  // 2) crawl each page for internal links & assets
  const assetSeen = new Set();
  for (const url of queue) {
    if (seen.has(url)) continue;
    seen.add(url);
    const html = await (await fetch(url)).text();

    // internal hrefs (not api/, not mailto/tel, not external)
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1])
      .filter(h => h && !/^(https?:|mailto:|tel:|javascript:|#|data:)/.test(h) && !h.startsWith('/api/'));
    for (const h of hrefs) {
      const abs = new URL(h, url).toString();
      if (seen.has(abs) || queue.includes(abs)) continue;
      queue.push(abs); // crawl internal pages too
    }

    // assets: src + css url() references
    const srcs = [
      ...[...html.matchAll(/(?:src|data-src)="([^"]+)"/g)].map(m => m[1]),
      ...[...html.matchAll(/url\((['"]?)([^'")]+)\1\)/g)].map(m => m[2])
    ].filter(s => s && !/^(https?:|data:|#)/.test(s) && !s.includes('${'));
    for (const s of srcs) {
      const abs = new URL(s, url).pathname; // strip ?v= query
      if (assetSeen.has(abs)) continue;
      assetSeen.add(abs);
      const res = await get(BASE + abs);
      // 403 on /api/ endpoints = exists but correctly requires auth
      ok(`asset ${abs}`, res.status === 200 || (abs.startsWith('/api/') && res.status === 403), res.status);
    }

    // no stray localhost references in markup
    ok(`no localhost refs in ${new URL(url).pathname}`,
      !/src="http:\/\/localhost|href="http:\/\/localhost/.test(html));
  }

  // 3) manifest + robots + favicon
  for (const a of ['/manifest.webmanifest', '/robots.txt', '/favicon.ico']) {
    const res = await get(BASE + a);
    ok(`root file ${a}`, res.status === 200, res.status);
  }

  console.log('\n========== LINK CHECK: ' + pass + ' passed, ' + fail + ' failed ==========');
  if (fail) { console.log('PROBLEMS:'); problems.forEach(p => console.log('  ✗ ' + p)); process.exit(1); }
  console.log(`crawled ${seen.size} pages, verified ${assetSeen.size} unique assets — all wired up ✓`);
})().catch(e => { console.error('Link check crashed:', e); process.exit(1); });
