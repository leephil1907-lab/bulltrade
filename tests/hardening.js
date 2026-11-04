'use strict';
/**
 * Hardening suite — HTTP caching / conditional requests and request throttling.
 *
 * Boots its OWN throwaway server with RATE_LIMIT=on and deliberately tight
 * limits, because the main e2e suite must run with throttling off (it creates
 * many accounts from one IP on purpose). Everything is torn down at the end and
 * the developer's data/ directory is never touched.
 *
 *   node tests/hardening.js
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘ FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** GET/POST helper that never follows redirects and exposes raw headers. */
async function hit(base, method, p, { body, headers } = {}) {
  const res = await fetch(base + p, {
    method,
    redirect: 'manual',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not JSON */ }
  return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8'), bytes: buf.length, json };
}

const IP_A = '203.0.113.7';
const IP_B = '198.51.100.9';
const xff = ip => ({ 'X-Forwarded-For': ip });

(async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-hardening-'));
  const base = `http://127.0.0.1:${port}`;

  // Tight, short windows so the suite finishes in seconds and never depends on
  // the production defaults. RATE_LIMIT_<NAME>=max/windowMs (see lib/ratelimit.js).
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
      ADMIN_PASSWORD: 'Hardening-' + crypto.randomBytes(9).toString('base64url'),
      JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      BACKUP_REPO: '',
      BACKUP_TOKEN: '',
      RATE_LIMIT: 'on',
      RATE_LIMIT_SIGNUP: '3/60000',
      RATE_LIMIT_LEADS: '2/60000',
      SITE_URL: 'https://hardening.example',
      // Belt and braces: the throttled routes below reach handlers that can
      // trigger mail. lib/mailer.js already suppresses @example.com recipients
      // and skips entirely when SMTP is unconfigured, but pin both explicitly so
      // a stray SMTP_* in the ambient environment can never make this suite
      // email a real inbox.
      NOTIFY_EMAIL: 'owner@example.com',
      SUPPORT_EMAIL: 'support@example.com',
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
      EMAIL_TRANSPORT: 'smtp', SENDGRID_API_KEY: '', MAIL_RELAY_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  const cleanup = () => {
    try { server.kill('SIGTERM'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  // Wait for the HTTP server only — this suite must not depend on the live
  // market feed, so there is no warm-up step and no network flakiness.
  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    try { if ((await hit(base, 'GET', '/healthz')).status === 200) { up = true; break; } } catch (e) {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!up) {
    console.error('[hardening] server failed to start:\n' + serverLog);
    cleanup();
    process.exit(1);
  }

  try {
    // ================= HTTP caching / conditional requests =================
    console.log('== static cache + ETag ==');

    const home1 = await hit(base, 'GET', '/');
    ok('GET / → 200', home1.status === 200, home1.status);
    const homeEtag = home1.headers.get('etag');
    ok('GET / sends an ETag', !!homeEtag && /^W\/"/.test(homeEtag), homeEtag);
    ok('GET / sends Last-Modified', !!home1.headers.get('last-modified'));
    ok('HTML revalidates (Cache-Control: no-cache)', (home1.headers.get('cache-control') || '') === 'no-cache', home1.headers.get('cache-control'));
    ok('Content-Length matches the body actually sent', Number(home1.headers.get('content-length')) === home1.bytes,
      { header: home1.headers.get('content-length'), actual: home1.bytes });
    ok('__SITE_URL__ substituted from env', !home1.text.includes('__SITE_URL__') && home1.text.includes('https://hardening.example'));
    ok('premium.css injected into HTML', /premium\.css\?v=/.test(home1.text));

    const home2 = await hit(base, 'GET', '/', { headers: { 'If-None-Match': homeEtag } });
    ok('If-None-Match → 304', home2.status === 304, home2.status);
    ok('304 carries no body', home2.bytes === 0, home2.bytes);
    ok('304 echoes the ETag', home2.headers.get('etag') === homeEtag);
    ok('304 is dramatically smaller than 200', home2.bytes < home1.bytes / 10, { revalidated: home2.bytes, full: home1.bytes });

    const home3 = await hit(base, 'GET', '/', { headers: { 'If-None-Match': 'W/"bogus-0"' } });
    ok('stale ETag → full 200 body', home3.status === 200 && home3.bytes === home1.bytes, home3.status);

    const home4 = await hit(base, 'GET', '/', { headers: { 'If-None-Match': '*' } });
    ok('If-None-Match: * → 304', home4.status === 304, home4.status);

    // A list header must match on one of its members, not the whole string.
    const home5 = await hit(base, 'GET', '/', { headers: { 'If-None-Match': `W/"other-1", ${homeEtag}` } });
    ok('ETag matched inside a comma-separated list → 304', home5.status === 304, home5.status);

    // If-Modified-Since is honoured only when no ETag is presented (RFC 9110
    // prefers the strong validator).
    const home6 = await hit(base, 'GET', '/', { headers: { 'If-Modified-Since': home1.headers.get('last-modified') } });
    ok('If-Modified-Since → 304', home6.status === 304, home6.status);

    // ---- long-lived assets ----
    const img1 = await hit(base, 'GET', '/assets/img/brand/logo.png');
    ok('image → 200', img1.status === 200, img1.status);
    ok('image is cacheable for 7 days (was 1 day)', (img1.headers.get('cache-control') || '') === 'public, max-age=604800', img1.headers.get('cache-control'));
    ok('image does NOT use immutable (URLs are not fingerprinted)', !/immutable/.test(img1.headers.get('cache-control') || ''));
    const imgEtag = img1.headers.get('etag');
    const img2 = await hit(base, 'GET', '/assets/img/brand/logo.png', { headers: { 'If-None-Match': imgEtag } });
    ok('image If-None-Match → 304', img2.status === 304 && img2.bytes === 0, { status: img2.status, bytes: img2.bytes });

    // ---- the memoised copy must be byte-identical to a fresh read from disk ----
    // (a cache that returned a truncated or shared/mutated buffer would be far
    // worse than no cache at all, so compare the real bytes, not just the size)
    const assetPath = path.join(ROOT, 'public', 'assets', 'img', 'brand', 'logo.png');
    const onDisk = fs.readFileSync(assetPath);
    ok('cached body is byte-identical to the file on disk', Buffer.compare(img1.buf, onDisk) === 0,
      { served: img1.bytes, onDisk: onDisk.length });

    // ---- cache invalidation: a changed mtime must produce a new ETag ----
    const orig = fs.statSync(assetPath);
    try {
      const future = new Date(orig.mtimeMs + 5000);
      fs.utimesSync(assetPath, future, future);
      const img3 = await hit(base, 'GET', '/assets/img/brand/logo.png');
      ok('mtime change invalidates the cache (new ETag)', img3.headers.get('etag') !== imgEtag, { before: imgEtag, after: img3.headers.get('etag') });
      ok('revalidation after invalidation returns 200, not 304', img3.status === 200, img3.status);
    } finally {
      fs.utimesSync(assetPath, orig.atime, orig.mtime); // leave the checkout as we found it
    }
    const img4 = await hit(base, 'GET', '/assets/img/brand/logo.png', { headers: { 'If-None-Match': imgEtag } });
    ok('restored mtime revalidates against the original ETag again', img4.status === 304, img4.status);

    // ---- repeated reads must stay stable (no buffer reuse corruption) ----
    const bodies = [];
    for (let i = 0; i < 4; i++) bodies.push((await hit(base, 'GET', '/markets')).text);
    ok('repeated GET /markets returns identical HTML every time', bodies.every(b => b === bodies[0]) && bodies[0].length > 1000);

    // ---- error responses must not be cacheable or revalidatable ----
    const nf = await hit(base, 'GET', '/definitely-not-a-real-page');
    ok('unknown page → 404', nf.status === 404, nf.status);
    ok('404 is not cached', (nf.headers.get('cache-control') || '') === 'no-cache', nf.headers.get('cache-control'));
    const nfEtag = nf.headers.get('etag');
    const nf2 = await hit(base, 'GET', '/definitely-not-a-real-page', { headers: { 'If-None-Match': nfEtag } });
    ok('404 never answers 304 (would imply the resource exists)', nf2.status === 404, nf2.status);

    // ---- private files under DATA_DIR are served, never memoised ----
    ok('data dir is not served over HTTP', (await hit(base, 'GET', '/data/db.json')).status === 404);

    // ================= security headers =================
    console.log('== security headers ==');
    const sec = await hit(base, 'GET', '/', { headers: { 'X-Forwarded-Proto': 'https' } });
    ok('HSTS sent when the edge terminates TLS', /^max-age=31536000/.test(sec.headers.get('strict-transport-security') || ''), sec.headers.get('strict-transport-security'));
    ok('HSTS omits includeSubDomains (would pin subdomains for a year)', !/includeSubDomains/.test(sec.headers.get('strict-transport-security') || ''));
    const plain = await hit(base, 'GET', '/');
    ok('HSTS NOT sent over plain HTTP (browsers ignore it anyway)', !plain.headers.get('strict-transport-security'));
    ok('X-Content-Type-Options still present', plain.headers.get('x-content-type-options') === 'nosniff');
    ok('X-Frame-Options still present', plain.headers.get('x-frame-options') === 'SAMEORIGIN');

    // ================= rate limiting =================
    console.log('== rate limiting ==');

    const health = await hit(base, 'GET', '/healthz');
    ok('/healthz reports the limiter is enabled', health.json && health.json.rateLimit && health.json.rateLimit.enabled === true, health.json && health.json.rateLimit);
    ok('/healthz reports the persistent data dir', health.json && health.json.persistence && health.json.persistence.dataDir === dataDir, health.json && health.json.persistence);
    ok('/healthz reports the db file size', health.json && health.json.persistence && typeof health.json.persistence.dbBytes === 'number');

    // Deliberately invalid payloads: the limiter consumes quota BEFORE the
    // handler runs, so these return 400 while still counting toward the bucket.
    // Nothing is created, so the assertions stay about throttling only.
    const badSignup = email => hit(base, 'POST', '/api/auth/signup', {
      body: { email, password: 'x' }, // fails validation: no `agree`, weak password
      headers: xff(IP_A)
    });

    const s1 = await badSignup('rl1@example.com');
    const s2 = await badSignup('rl2@example.com');
    const s3 = await badSignup('rl3@example.com');
    ok('signup 1-3 are throttled-in but pass through to validation (400)', [s1, s2, s3].every(r => r.status === 400), [s1.status, s2.status, s3.status]);

    const s4 = await badSignup('rl4@example.com');
    ok('signup 4 → 429 (limit 3/min from RATE_LIMIT_SIGNUP)', s4.status === 429, s4.status);
    ok('429 body is a normal error envelope', s4.json && s4.json.ok === false && /too many requests/i.test(s4.json.error || ''), s4.json);
    ok('429 sends Retry-After in seconds', /^\d+$/.test(s4.headers.get('retry-after') || ''), s4.headers.get('retry-after'));
    ok('429 Retry-After is within the configured window', Number(s4.headers.get('retry-after')) <= 60 && Number(s4.headers.get('retry-after')) >= 1, s4.headers.get('retry-after'));

    // A second address gets its own bucket — one abusive client must not lock
    // out everyone behind Render's shared internal source address.
    const b1 = await hit(base, 'POST', '/api/auth/signup', { body: { email: 'rlb@example.com', password: 'x' }, headers: xff(IP_B) });
    ok('a different client IP has an independent bucket (not 429)', b1.status === 400, b1.status);

    // The limiter keys on the LAST XFF hop, which is the one our own trusted
    // proxy appends. Keying on the first hop would let an attacker rotate a
    // spoofed value and get an unlimited number of fresh buckets.
    const spoof = [];
    for (let i = 0; i < 5; i++) {
      spoof.push(await hit(base, 'POST', '/api/auth/signup', {
        body: { email: `spoof${i}@example.com`, password: 'x' },
        headers: { 'X-Forwarded-For': `10.0.0.${i}, ${IP_A}` } // random first hop, real last hop
      }));
    }
    ok('spoofing the first XFF hop cannot bypass the limit (429 reached)', spoof.some(r => r.status === 429), spoof.map(r => r.status));

    // Per-identity rule: the same address+email is throttled independently of
    // the shared per-IP bucket, so a targeted account cannot be hammered.
    const ipC = '192.0.2.55';
    const same = [];
    for (let i = 0; i < 5; i++) {
      same.push(await hit(base, 'POST', '/api/leads', { body: { email: 'dupe@example.com' }, headers: xff(ipC) }));
    }
    ok('leads: repeated same-email POST is throttled (limit 2/min)', same.filter(r => r.status === 429).length >= 3, same.map(r => r.status));

    // Unthrottled routes must be untouched, or the limiter is doing more harm
    // than good on a busy market-data page.
    const free = [];
    for (let i = 0; i < 25; i++) free.push((await hit(base, 'GET', '/api/settings/public', { headers: xff(IP_A) })).status);
    ok('an unlisted route is never throttled (25 reads, all 200)', free.every(s => s === 200), free.slice(0, 8));

    const pages = [];
    for (let i = 0; i < 15; i++) pages.push((await hit(base, 'GET', '/', { headers: xff(IP_A) })).status);
    ok('static pages are never throttled', pages.every(s => s === 200 || s === 304), pages.slice(0, 8));
  } finally {
    cleanup();
  }

  console.log(`\n========== HARDENING: ${pass} passed, ${fail} failed ==========`);
  process.exit(fail === 0 ? 0 : 1);
})();
