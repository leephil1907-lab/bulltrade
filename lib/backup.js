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

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const REPO = (process.env.BACKUP_REPO || '').trim();
const TOKEN = (process.env.BACKUP_TOKEN || '').trim();
const BRANCH = (process.env.BACKUP_BRANCH || 'main').trim();
const DIR = (process.env.BACKUP_DIR || 'data').replace(/\/+$/, '');

const enabled = !!(REPO && TOKEN);
const MAX_FILE = 8 * 1024 * 1024; // never sync files above 8 MB

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
  if (buf.length === 0 || buf.length > MAX_FILE) {
    if (buf.length > MAX_FILE) console.error(`[backup] skip ${repoPath} (${buf.length} bytes > limit)`);
    return;
  }
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
  enqueue(() => putFile(absPath, DIR + '/' + rel));
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
async function restore() {
  if (!enabled) return false;
  try { // persistent disk already has an intact database → nothing to do
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.users)) return false;
    }
  } catch (e) { /* corrupt file → restore over it */ }
  const t = await tree(true);
  const files = Object.keys(t).filter(p => p.startsWith(DIR + '/'));
  if (!files.length) { console.log('[backup] no backup data found — starting fresh'); return false; }
  let restored = 0;
  for (const repoPath of files) {
    const rel = repoPath.slice(DIR.length + 1);
    if (!rel || rel.includes('..')) continue;
    const abs = path.join(DATA_DIR, rel);
    const r = await api(`/repos/${REPO}/contents/${encodeURI(repoPath)}?ref=${BRANCH}`,
      { accept: 'application/vnd.github.raw' });
    if (!r.ok || r.data == null) { console.error(`[backup] restore ${rel} failed (HTTP ${r.status})`); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, r.data); // Buffer when raw accept is used
    restored++;
  }
  console.log(`[backup] restored ${restored} file(s) from ${REPO}`);
  return restored > 0;
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
  let exiting = false;
  const onSignal = sig => {
    if (exiting) return;
    exiting = true;
    console.log(`[backup] ${sig} received — flushing final data state…`);
    const hardExit = setTimeout(() => process.exit(0), 4000);
    hardExit.unref();
    flushNow().catch(() => {}).finally(() => { clearTimeout(hardExit); process.exit(0); });
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

module.exports = { enabled, start, restore, markDirty, flushNow, pushFile };
