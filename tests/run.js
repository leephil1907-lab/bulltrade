'use strict';
/**
 * Self-contained test runner.
 *
 *   npm test
 *
 * Boots a throwaway server on a free port with a temporary DATA_DIR, runs the
 * e2e + link-check suites against it, then tears everything down. No manual
 * setup, no ADMIN_PASSWORD to remember, and the developer's data/ is untouched.
 *
 * To run against an already-running server instead:
 *   ADMIN_PASSWORD=... BASE_URL=http://localhost:3000 node tests/e2e.js
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

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

async function waitForServer(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/', { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function runSuite(script, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: 'inherit'
    });
    child.on('exit', code => resolve(code === 0 ? 0 : 1));
  });
}

(async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-test-data-'));
  const adminPassword = 'E2E-' + crypto.randomBytes(9).toString('base64url');
  const base = `http://127.0.0.1:${port}`;

  console.log(`[test] temp data dir: ${dataDir}`);
  console.log(`[test] booting server on ${base}\n`);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: adminPassword,
      JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      BACKUP_REPO: '',
      BACKUP_TOKEN: '',
      // Explicit, not inherited: if the ambient environment happens to set
      // NODE_ENV=production the throttle would switch on and start 429-ing this
      // suite's many signups from a single IP. hardening.js covers the limiter.
      RATE_LIMIT: 'off'
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

  const up = await waitForServer(base);
  if (!up) {
    console.error('[test] server failed to start. Log:\n' + serverLog);
    cleanup();
    process.exit(1);
  }

  // Pre-warm the live market feed. A freshly booted server has no market cache and
  // CoinGecko rate-limits shared IPs (429), so the first snapshot can arrive via the
  // Yahoo fallback with missing sparklines. Waiting here keeps the suites from
  // flaking on feed timing rather than on real regressions.
  const deadline = Date.now() + 90000;
  let warmed = false;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/api/markets', { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const assets = j.assets || [];
      const priced = assets.filter(a => a.price != null).length;
      const btc = assets.find(a => a.symbol === 'BTC');
      if (priced >= 55 && btc && btc.price != null && (btc.spark || []).length > 0) { warmed = true; break; }
    } catch (e) { /* keep waiting */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log(warmed ? '[test] market feed warm\n' : '[test] market feed still cold after 90s — running anyway\n');

  const env = { BASE_URL: base, ADMIN_PASSWORD: adminPassword };

  let failed = 0;
  console.log('### e2e suite ###');
  if (await runSuite('e2e.js', env)) failed++;
  console.log('\n### link check ###');
  if (await runSuite('links.js', env)) failed++;

  // Boots its own server with RATE_LIMIT=on (the e2e suite above must run with
  // throttling off, since it deliberately creates many accounts from one IP).
  console.log('\n### hardening suite ###');
  if (await runSuite('hardening.js', {})) failed++;

  // Boots TWO servers against one shared data dir to prove the persistent-disk
  // contract: data written before a SIGTERM must still be there after a cold
  // boot. This is the behaviour the paid Render plan buys and the free tier
  // could not offer.
  console.log('\n### persistence suite ###');
  if (await runSuite('persistence.js', {})) failed++;

  cleanup();

  console.log('\n' + (failed === 0
    ? '[test] ALL SUITES PASSED ✓'
    : `[test] ${failed} suite(s) FAILED ✗`));
  process.exit(failed === 0 ? 0 : 1);
})();
