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
      BACKUP_TOKEN: ''
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

  const env = { BASE_URL: base, ADMIN_PASSWORD: adminPassword };

  let failed = 0;
  console.log('### e2e suite ###');
  if (await runSuite('e2e.js', env)) failed++;
  console.log('\n### link check ###');
  if (await runSuite('links.js', env)) failed++;

  cleanup();

  console.log('\n' + (failed === 0
    ? '[test] ALL SUITES PASSED ✓'
    : `[test] ${failed} suite(s) FAILED ✗`));
  process.exit(failed === 0 ? 0 : 1);
})();
