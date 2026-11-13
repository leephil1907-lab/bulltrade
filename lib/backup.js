'use strict';
/**
 * GitHub-based data persistence for ephemeral hosts (Render free tier).
 *
 * Free-tier hosts wipe the filesystem on every deploy/restart. This module
 * keeps the app's data (data/db.json + data/uploads/) mirrored in a PRIVATE
 * GitHub repo and restores it automatically when the data directory is empty.
 *
 * Opt-in via environment variables:
 *   BACKUP_REPO   "owner/name" of a PRIVATE GitHub repository
 *   BACKUP_TOKEN  personal access token with repo read/write access
 *   BACKUP_BRANCH branch to sync to          (default: main)
 *   BACKUP_DIR    path prefix inside the repo (default: data)
 *
 * Behaviour:
 *   - db.json is re-pushed (debounced 12s) after every save, plus a final
 *     flush on SIGTERM/SIGINT and a 10-minute safety-net interval
 *   - uploaded files (KYC docs, deposit proofs) are pushed immediately
 *   - on boot, an empty data/ directory is repopulated from the repo
 *   - the local file always stays the source of truth while running;
 *     push failures are logged and retried on the next change
 *
 * Uses only Node 18+ global fetch — zero dependencies.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const REPO = (process.env.BACKUP_REPO || '').trim();
const TOKEN = (process.env.BACKUP_TOKEN || '').trim();
const BRANCH = (process.env.BACKUP_BRANCH || 'main').trim();
const DIR = (process.env.BACKUP_DIR || 'data').replace(/\/+$/, '');

const enabled = !!(REPO && TOKEN);
const MAX_FILE = 8 * 1024 * 1024; // never sync files above 8 MB uncompressed…
// …but a database that outgrows that used to stop being backed up SILENTLY: the
// mirror simply froze at the last size under the cap, and the only copy of the
// newer data was the running container. Gzipped JSON compresses 5-10x, so
// anything over the cap is now pushed compressed instead of skipped.

// ---------- GitHub API ----------
async function api(p, opts = {}) {
  try {
    const res = await fetch('https://api.github.com' + p, {
      method: opts.method || 'GET',
      headers: Object.assign({
        authorization: 'Bearer ' + TOKEN,
        accept: opts.accept || 'application/vnd.github+json',
        'user-agent': 'blockchain-bullhorn-backup'
      }, opts.headers || {}),
      body: opts.body
    });
    let data = null;
    if (opts.accept === 'application/vnd.github.raw') {
      data = Buffer.from(await res.arrayBuffer());
    } else {
      try { data = await res.json(); } catch (e) { /* raw/empty */ }
    }
    return { status: res.status, ok: res.ok, data };
  } catch (e) {
    return { status: 0, ok: false, data: null, error: e.message };
  }
}

// ---------- repo file tree (gives blob SHAs without size limits) ----------
let treeCache = null, treeAt = 0;
async function tree(force) {
  if (!force && treeCache && Date.now() - treeAt < 15000) return treeCache;
  const r = await api(`/repos/${REPO}/git/trees/${BRANCH}?recursive=1`);
  treeCache = {};
  treeAt = Date.now();
  if (r.ok && r.data && Array.isArray(r.data.tree)) {
    for (const e of r.data.tree) if (e.type === 'blob') treeCache[e.path] = e.sha;
  } else if (r.status !== 404 && r.status !== 0) {
    console.error(`[backup] tree listing failed (HTTP ${r.status}${r.data && r.data.message ? ': ' + r.data.message : ''})`);
  }
  return treeCache;
}

// ---------- serialized push queue (one request at a time) ----------
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn).catch(e => console.error('[backup] push error:', e.message));
  queue = run.then(() => {}, () => {});
  return run;
}

async function putFile(absPath, repoPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) { return; }
  if (buf.length === 0) return;

  // Over the cap → compress rather than skip. The .gz lands beside the plain
  // file and restore() prefers whichever is newer, so this is backwards
  // compatible with a mirror that already holds an uncompressed db.json.
  let target = repoPath;
  if (buf.length > MAX_FILE) {
    const gz = zlib.gzipSync(buf, { level: 9 });
    if (gz.length > MAX_FILE) {
      console.error(`[backup] skip ${repoPath} — ${(buf.length / 1048576).toFixed(1)} MB compresses to ` +
                    `${(gz.length / 1048576).toFixed(1)} MB, still over the ${MAX_FILE / 1048576} MB limit`);
      return;
    }
    console.log(`[backup] ${repoPath} is ${(buf.length / 1048576).toFixed(1)} MB — syncing compressed ` +
                `(${(gz.length / 1048576).toFixed(2)} MB)`);
    target = repoPath + '.gz';
    buf = gz;
  }
  repoPath = target;
  const t = await tree();
  const body = { message: `sync ${repoPath}`, branch: BRANCH, content: buf.toString('base64') };
  if (t[repoPath]) body.sha = t[repoPath];
  let r = await api(`/repos/${REPO}/contents/${encodeURI(repoPath)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (r.status === 409 || (r.data && /does not match/i.test(String(r.data.message || '')))) {
    // sha moved since our tree snapshot → refresh and retry once
    const t2 = await tree(true);
    if (t2[repoPath]) body.sha = t2[repoPath]; else delete body.sha;
    r = await api(`/repos/${REPO}/contents/${encodeURI(repoPath)}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
  }
  if (!r.ok) {
    console.error(`[backup] push ${repoPath} failed (HTTP ${r.status}${r.data && r.data.message ? ': ' + r.data.message : ''})`);
  }
  return r.ok;
}

// ---------- public API ----------
/** Push an uploaded file (KYC doc / deposit proof) immediately. */
function pushFile(absPath) {
  if (!enabled) return;
  const rel = path.relative(DATA_DIR, absPath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return;
  return enqueue(() => putFile(absPath, DIR + '/' + rel));
}

/** Mark db.json as changed — pushed debounced (12s) so bursts cost one request. */
let dbTimer = null, dbDirty = false;
function markDirty() {
  if (!enabled) return;
  dbDirty = true;
  if (dbTimer) return;
  dbTimer = setTimeout(() => { dbTimer = null; flushNow(); }, 12000);
}

/** Push db.json right now (if dirty). */
async function flushNow() {
  if (dbTimer) { clearTimeout(dbTimer); dbTimer = null; }
  if (!enabled || !dbDirty) return;
  dbDirty = false;
  await enqueue(() => putFile(DB_FILE, DIR + '/db.json'));
}

/** Restore db.json + uploads into an empty data/ directory. */
/**
 * Restore data/ from the backup repository.
 *
 * Returns a STRUCTURED result rather than a boolean, because the caller has to
 * tell two very different situations apart:
 *
 *   { status: 'empty' }  the repo genuinely has no data yet — a first-ever
 *                        deployment. Seeding a fresh database is correct.
 *   { status: 'failed' } the repo HAS data (or we could not even list it) and we
 *                        did not get db.json. Seeding here would start an empty
 *                        database that the 10-minute sync then PUTs over the
 *                        real backup — permanent, unrecoverable loss of every
 *                        user, wallet and ledger entry.
 *
 * A bare `false` for both is what made that failure silent.
 */
async function restore() {
  if (!enabled) return { status: 'disabled', restored: 0 };
  try { // persistent disk already has an intact database → nothing to do
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.users)) return { status: 'intact', restored: 0 };
    }
  } catch (e) { /* corrupt file → restore over it */ }

  // List the backup directly rather than via tree(), because tree() swallows
  // every failure and returns {} — which is indistinguishable from "the repo is
  // genuinely empty". Acting on that would seed a fresh database after a bad
  // token or a GitHub outage and then overwrite the real backup with it.
  const list = await api(`/repos/${REPO}/git/trees/${BRANCH}?recursive=1`);
  let files = [];

  if (list.ok && list.data && Array.isArray(list.data.tree)) {
    treeCache = {}; treeAt = Date.now();
    for (const e of list.data.tree) if (e.type === 'blob') treeCache[e.path] = e.sha;
    files = Object.keys(treeCache).filter(p => p.startsWith(DIR + '/'));
    if (!files.length) {
      console.log('[backup] backup branch exists but holds no data — starting fresh');
      return { status: 'empty', restored: 0, files: 0 };
    }
  } else if (list.status === 404) {
    // Repo or branch missing. Distinguish a brand-new repo (nothing to lose)
    // from a misconfigured BACKUP_REPO/BACKUP_TOKEN (everything to lose).
    const probe = await api(`/repos/${REPO}`);
    if (probe.ok) {
      console.log('[backup] repo is reachable but has no such branch yet — starting fresh');
      return { status: 'empty', restored: 0, files: 0 };
    }
    return { status: 'failed', restored: 0, files: null,
             error: `backup repo not reachable (HTTP ${probe.status}) — check BACKUP_REPO and BACKUP_TOKEN` };
  } else if (list.status === 401 || list.status === 403) {
    return { status: 'failed', restored: 0, files: null,
             error: `backup repo rejected our credentials (HTTP ${list.status}) — BACKUP_TOKEN is invalid, expired, or lacks repo scope` };
  } else if (list.status === 0) {
    return { status: 'failed', restored: 0, files: null,
             error: `could not reach api.github.com (${list.error || 'network error'})` };
  } else {
    return { status: 'failed', restored: 0, files: null,
             error: `could not list backup tree (HTTP ${list.status})` };
  }

  let restored = 0, gotDb = false;
  const failed = [];
  // Plain files first, .gz last: when both exist the compressed copy is the
  // newer one, so it must win the race to write data/db.json.
  files.sort((a, b) => (/[.]gz$/.test(a) ? 1 : 0) - (/[.]gz$/.test(b) ? 1 : 0));
  for (const repoPath of files) {
    let rel = repoPath.slice(DIR.length + 1);
    if (!rel || rel.includes('..')) continue;
    const compressed = rel.endsWith('.gz');
    if (compressed) rel = rel.slice(0, -3);
    const abs = path.join(DATA_DIR, rel);
    const r = await api(`/repos/${REPO}/contents/${encodeURI(repoPath)}?ref=${BRANCH}`,
      { accept: 'application/vnd.github.raw' });
    if (!r.ok || r.data == null) {
      console.error(`[backup] restore ${rel} failed (HTTP ${r.status})`);
      failed.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let payload = r.data; // Buffer when raw accept is used
    if (compressed) {
      try { payload = zlib.gunzipSync(payload); }
      catch (e) {
        console.error(`[backup] restore ${rel} failed — the .gz copy is corrupt (${e.message})`);
        failed.push(rel);
        continue;
      }
    }
    fs.writeFileSync(abs, payload);
    if (compressed) console.log(`[backup] restored ${rel} from ${rel}.gz`);
    restored++;
    if (rel === 'db.json') gotDb = true;
  }
  console.log(`[backup] restored ${restored} file(s) from ${REPO}`);
  // Restoring uploads but not db.json is the worst outcome: it looks like
  // success while the database itself is still missing.
  if (!gotDb) {
    return { status: 'failed', restored, files: files.length, failed,
             error: 'db.json was not restored (' + (failed.includes('db.json') ? 'fetch failed' : 'not present in backup') + ')' };
  }
  return { status: 'ok', restored, files: files.length, failed };
}

/** Wire up: privacy check + safety-net interval + graceful-shutdown flush. */
function start() {
  if (!enabled) return;
  console.log(`[backup] GitHub data-sync enabled → ${REPO}@${BRANCH} (${DIR}/)`);
  api(`/repos/${REPO}`).then(r => {
    if (!r.ok) console.error(`[backup] repo ${REPO} not accessible (HTTP ${r.status}) — check BACKUP_REPO/BACKUP_TOKEN`);
    else if (r.data && r.data.private === false) {
      console.error('[backup] ⚠️  WARNING: BACKUP REPO IS PUBLIC! db.json contains user data and');
      console.error('[backup] ⚠️  password hashes — make the repository PRIVATE on GitHub right now.');
    }
  });
  setInterval(() => { flushNow(); }, 10 * 60 * 1000);
  // NOTE: this module deliberately does NOT register its own SIGTERM/SIGINT
  // handlers. It used to, and that raced with server.js's shutdown: both
  // handlers fired, and whichever finished first called process.exit(0) — so
  // server.close() could kill the process while the final GitHub push was still
  // in flight, leaving the off-site mirror stale by up to a whole sync interval.
  // The host process owns shutdown and must await flushNow() before exiting;
  // server.js does exactly that in shutdown().
}

module.exports = { enabled, start, restore, markDirty, flushNow, pushFile };
