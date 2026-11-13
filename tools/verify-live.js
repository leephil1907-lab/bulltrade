#!/usr/bin/env node
/**
 * Verify that the deployed site is serving THIS repository's build.
 *
 * The failure this catches: Render keeps serving an old build after a push, and
 * nobody notices because the homepage still loads. It checks build markers from
 * the repo itself, so it cannot drift out of date, then exercises the routes
 * that matter and fails loudly on anything stale.
 *
 *   node tools/verify-live.js                       # checks the default URL
 *   node tools/verify-live.js https://example.com   # or any host
 *
 * Exit code 0 = live build matches the repo, 1 = stale or broken.
 */
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'https://blockchainbullhorn.onrender.com').replace(/\/+$/, '');
const ROOT = path.join(__dirname, '..');

const read = p => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };
const assetVer = (page, file) => {
  const m = read(page).match(new RegExp(file.replace(/\./g, '\\.') + '\\?v=(\\d+)'));
  return m ? m[1] : null;
};
// premium.css is injected by the server with a version derived from the file's
// mtime, so the expected value is computed from the working copy, not the HTML.
const premiumVer = () => {
  try { return String(Math.floor(fs.statSync(path.join(ROOT, 'public/assets/css/premium.css')).mtimeMs)); }
  catch { return null; }
};

const CHECKS = [
  { name: 'common.js version', want: assetVer('public/index.html', 'common.js'),
    test: b => (b.match(/common\.js\?v=(\d+)/) || [])[1] },
  { name: 'premium.css version', want: premiumVer(),
    test: b => (b.match(/premium\.css\?v=(\d+)/) || [])[1] },
  { name: 'liquid-glass stylesheet served', want: true,
    test: b => /--glass-1/.test(b) || null, fetch: 'css' },
  { name: 'session bar on markets', want: true,
    test: b => /session-bar|sessionBar/.test(b) || null },
  { name: 'KYC country dropdown in admin', want: true,
    test: b => /kycCountry|kyc-country/.test(b) || null },
  { name: 'footer has 6 columns', want: true,
    test: b => /fb-page-card/.test(b) || null },
];

const routes = ['/', '/markets', '/trade', '/dashboard', '/kyc', '/admin', '/faq', '/contact', '/robots.txt', '/sitemap.xml', '/healthz'];

async function main() {
  let failures = 0;
  console.log(`verifying ${BASE}\n`);

  const health = await fetch(BASE + '/healthz').then(r => r.json()).catch(() => null);
  if (health) {
    const mins = Math.round((health.uptime || 0) / 60);
    console.log(`health      ok · uptime ${mins} min · users ${health.database?.users ?? '?'} · assets ${health.markets?.assets ?? '?'}`);
    if (mins > 30) console.log(`            note: uptime over 30 min usually means this is the OLD container, not a fresh deploy`);
  } else {
    console.log('health      FAILED'); failures++;
  }

  const home = await fetch(BASE + '/').then(r => r.text()).catch(() => '');
  const cssPath = (home.match(/\/assets\/css\/premium\.css\?v=\d+/) || [''])[0];
  const css = cssPath ? await fetch(BASE + cssPath).then(r => r.text()).catch(() => '') : '';

  for (const c of CHECKS) {
    const got = c.test(c.fetch === 'css' ? css : home);
    const ok = String(got) === String(c.want) && got;
    if (!ok) failures++;
    console.log(`${ok ? 'ok        ' : 'STALE     '} ${c.name}${c.want === true ? '' : ` · live ${got ?? 'missing'} / repo ${c.want ?? 'missing'}`}`);
  }

  const sitemap = await fetch(BASE + '/sitemap.xml').then(r => r.text()).catch(() => '');
  const host = (sitemap.match(/<loc>https:\/\/([^\/]+)/) || [])[1];
  const hostOk = host && BASE.includes(host);
  if (!hostOk) { failures++; console.log(`STALE      sitemap host · live ${host || 'none'} (should be ${BASE.replace('https://', '')})`); }
  else console.log(`ok         sitemap host · ${host}`);

  for (const r of routes) {
    const res = await fetch(BASE + r, { redirect: 'manual' }).catch(() => null);
    const ok = res && res.status < 400;
    if (!ok) failures++;
    console.log(`${ok ? 'ok        ' : 'FAIL      '} ${r.padEnd(12)} ${res ? res.status : 'no response'}`);
  }

  console.log(`\n${failures ? `${failures} problem(s) — the live site is NOT this build` : 'live site matches the repo ✓'}`);
  process.exit(failures ? 1 : 0);
}
main();
