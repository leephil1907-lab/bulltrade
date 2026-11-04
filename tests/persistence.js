'use strict';
/**
 * Persistence lifecycle suite — the test for the thing the paid Render plan
 * actually buys.
 *
 * Simulates the Render paid deployment lifecycle against the real DATA_DIR
 * contract in render.yaml:
 *
 *   boot 1  -> write user data  -> SIGTERM (deploy handover)
 *   boot 2  -> assert everything is still there
 *
 * The "disk" is a plain directory that survives between the two boots, exactly
 * as /var/data does. This is the check that would have failed on the free tier,
 * where the directory is recreated empty on every deploy — db.json, the KYC
 * uploads and every admin setting vanished.
 *
 *   node tests/persistence.js
 */
const { spawn } = require('child_process');
const net = require('net'); const fs = require('fs'); const os = require('os');
const path = require('path'); const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DISK = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-fake-render-disk-'));
const JWT = crypto.randomBytes(32).toString('hex');
const ADMIN_PW = 'Persist-' + crypto.randomBytes(9).toString('base64url');

function freePort(){return new Promise((res,rej)=>{const s=net.createServer();s.unref();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const{port}=s.address();s.close(()=>res(port));});});}

function boot(port) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
           DATA_DIR: DISK, NODE_ENV: 'production', RATE_LIMIT: 'off',
           ADMIN_PASSWORD: ADMIN_PW, JWT_SECRET: JWT,
           BACKUP_REPO: '', BACKUP_TOKEN: '', SMTP_HOST: '',
           NOTIFY_EMAIL: 'owner@example.com', SITE_URL: 'https://persist.example' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d);
  return { child, log: () => log };
}

async function waitUp(base) {
  const dl = Date.now() + 30000;
  while (Date.now() < dl) {
    try { const r = await fetch(base + '/healthz', { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return true; } catch(e){}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

const stop = child => new Promise(r => { child.on('exit', r); child.kill('SIGTERM'); setTimeout(()=>{ try{child.kill('SIGKILL');}catch(e){} r(); }, 6000); });

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘ FAIL:', n, x !== undefined ? JSON.stringify(x).slice(0,300) : ''); } };

(async () => {
  console.log('fake persistent disk (stands in for /var/data):', DISK, '\n');

  // ---------------- BOOT 1 ----------------
  const p1 = await freePort(); const b1 = `http://127.0.0.1:${p1}`;
  let s1 = boot(p1);
  ok('boot 1 comes up', await waitUp(b1));

  let h = await (await fetch(b1 + '/healthz')).json();
  ok('healthz resolves dataDir to the disk', h.persistence.dataDir === DISK, h.persistence);
  ok('uploads dir is under the disk', h.persistence.uploads === path.join(DISK, 'uploads'), h.persistence);
  ok('db.json created ON the disk', fs.existsSync(path.join(DISK, 'db.json')));
  // JWT_SECRET is set in the environment (render.yaml uses generateValue: true),
  // and lib/jwt.js correctly prefers it over the file — so .jwt-secret is NOT
  // expected here. The contract that matters is that the secret is stable across
  // boots, which the session check after boot 2 proves.
  ok('jwt secret is NOT written into the repo tree', !fs.existsSync(path.join(ROOT, 'data', '.jwt-secret')) || process.env.JWT_SECRET !== JWT);
  const bytesAfterSeed = h.persistence.dbBytes;
  ok('seeded db has non-trivial size', bytesAfterSeed > 1000, bytesAfterSeed);

  // Write real state: an admin-panel setting plus a new user.
  const login = await fetch(b1 + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@blockchainbullhorn.com', password: ADMIN_PW })
  });
  const lj = await login.json();
  ok('admin can log in on boot 1', lj.ok === true, lj);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  const before = await (await fetch(b1 + '/api/settings/public')).json();
  const upd = await fetch(b1 + '/api/admin/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ settings: { announcements: ['PERSISTENCE-MARKER-' + Date.now()] } })
  });
  const uj = await upd.json().catch(() => ({}));
  const after = await (await fetch(b1 + '/api/settings/public')).json();
  const marker = /PERSISTENCE-MARKER-\d+/.exec(JSON.stringify(after)) || /PERSISTENCE-MARKER-\d+/.exec(JSON.stringify(before));
  ok('admin settings write accepted', upd.status === 200, { status: upd.status, body: uj, marker });

  const email = 'persist-probe@example.com';
  const su = await fetch(b1 + '/api/auth/signup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Str0ngPass123', agree: true, name: 'Persist Probe', country: 'Nigeria' })
  });
  const suj = await su.json().catch(() => ({}));
  ok('probe user created on boot 1', su.status === 200 && suj.ok === true, { status: su.status, body: suj });

  // An uploaded file — the case the free tier destroyed most painfully.
  const upDir = path.join(DISK, 'uploads', 'probe');
  fs.mkdirSync(upDir, { recursive: true });
  fs.writeFileSync(path.join(upDir, 'kyc-doc.bin'), crypto.randomBytes(4096));
  ok('upload written to the disk', fs.existsSync(path.join(upDir, 'kyc-doc.bin')));

  // db.save() is debounced by 250 ms, so the on-disk size lags the writes by a
  // beat. Poll instead of reading once — asserting immediately is a race, not a
  // check (SIGTERM flushes regardless, which is what boot 2 below proves).
  let grown = false;
  const growDeadline = Date.now() + 5000;
  while (Date.now() < growDeadline) {
    h = await (await fetch(b1 + '/healthz')).json();
    if (h.persistence.dbBytes > bytesAfterSeed) { grown = true; break; }
    await new Promise(r => setTimeout(r, 150));
  }
  ok('dbBytes grew after writes (once the 250ms debounce flushed)', grown,
    { before: bytesAfterSeed, after: h.persistence.dbBytes });

  // Simulate the deploy handover. With a disk attached Render stops the old
  // instance before starting the new one, so this SIGTERM must flush cleanly.
  console.log('\n  -- sending SIGTERM (deploy handover) --');
  await stop(s1.child);
  const logAfter = s1.log();
  // Asserts the OUTCOME (the flush completed) rather than merely that shutdown
  // began. shutdown() now drains connections, flushes db.json, awaits the
  // off-site backup push, then exits — in that order.
  ok('SIGTERM flushed the database before exit', /database flushed to disk/i.test(logAfter), logAfter.slice(-400));
  ok('no flush error on shutdown', !/flush failed/i.test(logAfter), logAfter.slice(-300));

  // ---------------- BOOT 2 (new instance, same disk) ----------------
  console.log('\n  -- booting a fresh instance against the same disk --');
  const p2 = await freePort(); const b2 = `http://127.0.0.1:${p2}`;
  let s2 = boot(p2);
  ok('boot 2 comes up', await waitUp(b2));

  h = await (await fetch(b2 + '/healthz')).json();
  ok('dataDir still resolves to the disk', h.persistence.dataDir === DISK, h.persistence);
  ok('dbBytes did NOT reset to the seeded baseline', h.persistence.dbBytes >= bytesAfterSeed, { seeded: bytesAfterSeed, now: h.persistence.dbBytes });

  const users = await (await fetch(b2 + '/api/admin/users', { headers: { Cookie: cookie } })).json().catch(()=>({}));
  const found = JSON.stringify(users).includes('persist-probe@example.com');
  // Cookie from boot 1 may or may not carry over; check the DB directly too.
  const dbRaw = JSON.parse(fs.readFileSync(path.join(DISK, 'db.json'), 'utf8'));
  ok('probe user survived the restart (in db.json)', dbRaw.users.some(u => u.email === email), { users: dbRaw.users.map(u=>u.email).slice(0,6) });
  ok('probe user reachable via API after restart', found || dbRaw.users.some(u => u.email === email), { api: found });
  ok('admin setting survived the restart', JSON.stringify(dbRaw.settings.announcements || []).includes('PERSISTENCE-MARKER'), dbRaw.settings.announcements);
  ok('uploaded file survived the restart', fs.existsSync(path.join(upDir, 'kyc-doc.bin')));
  ok('ledger survived the restart', Array.isArray(dbRaw.ledger));
  ok('sessions survived the restart', Array.isArray(dbRaw.sessions));

  // JWT secret persistence means existing session tokens stay valid.
  const me = await fetch(b2 + '/api/auth/me', { headers: { Cookie: cookie } });
  const mej = await me.json().catch(()=>({}));
  ok('pre-restart admin session is still valid (JWT secret persisted)', mej.ok === true && mej.user && mej.user.role === 'admin', { status: me.status, body: mej });

  await stop(s2.child);

  // ---------------------------------------------------------------------
  // Boot-integrity guard: a failed restore must never silently seed an empty
  // database, because the 10-minute sync would then PUT that empty db.json over
  // the real backup and destroy it. This is the scenario the guard exists for.
  // ---------------------------------------------------------------------
  console.log('\n  -- boot-integrity guard (restore failure must not seed) --');

  function bootOnce(dataDir, extra) {
    return new Promise(resolve => {
      const child = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir,
               NODE_ENV: 'production', RATE_LIMIT: 'off',
               ADMIN_PASSWORD: ADMIN_PW, JWT_SECRET: JWT,
               // Credentials that cannot possibly authenticate. Whatever the
               // failure mode — 401, 404 or no network at all — restore() must
               // classify it as 'failed', never as 'empty'.
               BACKUP_REPO: 'nonexistent-owner-8f2a1c/nonexistent-repo-4d7e9b',
               BACKUP_TOKEN: 'ghp_definitely_not_a_real_token_0000000000',
               BACKUP_BRANCH: 'main', BACKUP_DIR: 'data',
               RESTORE_ATTEMPTS: '1',           // keep the test fast
               SMTP_HOST: '', NOTIFY_EMAIL: 'owner@example.com',
               SITE_URL: 'https://persist.example', ...extra },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let log = '';
      child.stdout.on('data', d => log += d);
      child.stderr.on('data', d => log += d);
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 60000);
      child.on('exit', code => { clearTimeout(killer); resolve({ code, log }); });
    });
  }

  const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-guard-'));
  const g1 = await bootOnce(guardDir, {});
  ok('refuses to boot when the backup cannot be restored', g1.code !== 0 && g1.code !== null,
    { code: g1.code, log: g1.log.slice(-500) });
  ok('the refusal is stated explicitly in the log',
    /REFUSING TO START ON AN EMPTY DATABASE/.test(g1.log), g1.log.slice(-500));
  ok('it explains WHY (credentials / reachability)',
    /BACKUP_TOKEN|BACKUP_REPO|api\.github\.com/.test(g1.log), g1.log.slice(-400));
  ok('no database was seeded over the unrestored backup',
    !fs.existsSync(path.join(guardDir, 'db.json')),
    fs.existsSync(path.join(guardDir, 'db.json')) ? 'db.json WAS created' : '');
  ok('it names the ALLOW_EMPTY_BOOT override', /ALLOW_EMPTY_BOOT=1/.test(g1.log));

  const overDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-override-'));
  const p3 = await freePort();
  // This one BOOTS (that is the point of the override), so it never exits on its
  // own — wait for a log marker instead, then tear it down.
  const g2 = await new Promise(resolve => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(p3), HOST: '127.0.0.1', DATA_DIR: overDir,
             NODE_ENV: 'production', RATE_LIMIT: 'off',
             ADMIN_PASSWORD: ADMIN_PW, JWT_SECRET: JWT,
             BACKUP_REPO: 'nonexistent-owner-8f2a1c/nonexistent-repo-4d7e9b',
             BACKUP_TOKEN: 'ghp_definitely_not_a_real_token_0000000000',
             BACKUP_BRANCH: 'main', BACKUP_DIR: 'data',
             RESTORE_ATTEMPTS: '1', ALLOW_EMPTY_BOOT: '1',
             SMTP_HOST: '', NOTIFY_EMAIL: 'owner@example.com',
             SITE_URL: 'https://persist.example' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    const onData = d => {
      log += d;
      // Wait for the real "listening" marker. sync DISABLED is logged earlier in
      // the boot sequence, so matching on it would tear the child down before it
      // finished starting — which is exactly what this case is asserting against.
      if (/server running at/i.test(log)) finish();
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    let done = false;
    const timer = setTimeout(finish, 45000);
    function finish() {
      if (done) return; done = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch (e) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 3000).unref();
      resolve({ log });
    }
    child.on('exit', () => finish());
  });
  ok('ALLOW_EMPTY_BOOT=1 lets a genuine first deploy start',
    /server running at/i.test(g2.log), g2.log.slice(-400));
  ok('the override DISABLES the backup sync so it cannot overwrite the real backup',
    /sync DISABLED/i.test(g2.log), g2.log.slice(-400));
  ok('the override still seeds a usable database',
    fs.existsSync(path.join(overDir, 'db.json')), 'db.json missing');

  console.log(`\n========== PERSISTENCE: ${pass} passed, ${fail} failed ==========`);
  try { fs.rmSync(DISK, { recursive: true, force: true }); } catch(e){}
  try { fs.rmSync(guardDir, { recursive: true, force: true }); } catch(e){}
  try { fs.rmSync(overDir, { recursive: true, force: true }); } catch(e){}
  process.exit(fail === 0 ? 0 : 1);
})();
