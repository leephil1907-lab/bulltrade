#!/usr/bin/env node
'use strict';
/**
 * Rescue tool: push (or pull) the database to the GitHub backup repo even when
 * it has outgrown the sync limit.
 *
 * WHY THIS EXISTS
 *   lib/backup.js refuses to sync any file above 8 MB (`MAX_FILE`). A live
 *   database that grows past 8 MB therefore stops being backed up — silently,
 *   apart from one log line — and the off-site mirror freezes at the last size
 *   under the cap. That is exactly what happened here: the mirror's db.json is
 *   8,191 KB (right at the cap) while the running database is ~12 MB, so roughly
 *   a week of sign-ups, wallets and ledger entries exist only on the container.
 *
 *   Gzipped JSON compresses ~8-10x, so the same database fits comfortably. This
 *   script does that, and it deliberately does NOT need the app to be restarted,
 *   so it is safe to run against a live container from the Render shell — which
 *   matters, because restarting a container that holds the only copy of the data
 *   is exactly what must be avoided.
 *
 * USAGE
 *   # push the live database (run in the Render shell of the live service)
 *   cd /app && BACKUP_TOKEN=<pat> node tools/push-backup.js /app/data/db.json
 *
 *   # same, but from the repo root
 *   BACKUP_TOKEN=<pat> node tools/push-backup.js
 *
 *   # check what would happen, without touching GitHub
 *   BACKUP_TOKEN=<pat> node tools/push-backup.js --dry
 *
 *   # pull the backup back down (restores data/db.json locally)
 *   BACKUP_TOKEN=<pat> node tools/push-backup.js --pull
 *
 * ENV
 *   BACKUP_REPO    owner/name        (default: leephil1907-lab/bulltrade-data)
 *   BACKUP_TOKEN   PAT with repo scope  (required)
 *   BACKUP_BRANCH  branch            (default: main)
 *   BACKUP_DIR     path prefix       (default: data)
 *   DATA_DIR       where to read/write db.json (default: ./data)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = (process.env.BACKUP_REPO || 'leephil1907-lab/bulltrade-data').trim();
const TOKEN = (process.env.BACKUP_TOKEN || '').trim();
const BRANCH = (process.env.BACKUP_BRANCH || 'main').trim();
const DIR = (process.env.BACKUP_DIR || 'data').replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const PULL = args.includes('--pull');
const PLAIN = args.includes('--plain');
const fileArg = args.find(a => !a.startsWith('--'));
const DB_FILE = fileArg ? path.resolve(fileArg) : path.join(DATA_DIR, 'db.json');
const REPO_PATH = `${DIR}/db.json${PLAIN ? '' : '.gz'}`;

const kb = n => `${(n / 1024).toFixed(0)} KB`;
const die = m => { console.error(`✖ ${m}`); process.exit(1); };

async function api(p, opts = {}) {
  const res = await fetch('https://api.github.com' + p, {
    method: opts.method || 'GET',
    headers: Object.assign({
      authorization: 'Bearer ' + TOKEN,
      accept: 'application/vnd.github+json',
      'user-agent': 'blockchain-bullhorn-rescue',
      'content-type': 'application/json'
    }, opts.headers || {}),
    body: opts.body
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty */ }
  return { status: res.status, ok: res.ok, data, text: () => JSON.stringify(data) };
}

async function currentSha(repoPath) {
  const r = await api(`/repos/${REPO}/contents/${encodeURI(repoPath)}?ref=${BRANCH}`);
  return r.ok && r.data && r.data.sha ? r.data.sha : null;
}

async function push() {
  if (!fs.existsSync(DB_FILE)) die(`no database at ${DB_FILE}`);
  const raw = fs.readFileSync(DB_FILE);

  // Sanity check: never ship something that is not a database.
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch (e) { die(`${DB_FILE} is not valid JSON — refusing to push it (${e.message})`); }
  if (!parsed || !Array.isArray(parsed.users)) die(`${DB_FILE} has no users array — refusing to push it`);

  const gz = PLAIN ? raw : zlib.gzipSync(raw, { level: 9 });
  console.log(`database   ${DB_FILE}`);
  console.log(`  users    ${parsed.users.length}`);
  console.log(`  ledger   ${(parsed.ledger || []).length}`);
  console.log(`  size     ${kb(raw.length)}${PLAIN ? '' : ` → ${kb(gz.length)} gzipped (${(raw.length / gz.length).toFixed(1)}x)`}`);
  console.log(`target     ${REPO}@${BRANCH}:${REPO_PATH}`);

  if (DRY) { console.log('\n--dry: nothing was sent to GitHub.'); return; }

  const sha = await currentSha(REPO_PATH);
  if (sha) console.log(`replacing  existing file (sha ${sha.slice(0, 8)})`);

  const body = {
    message: `rescue backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${parsed.users.length} users, ${kb(raw.length)}`,
    content: gz.toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  const r = await api(`/repos/${REPO}/contents/${encodeURI(REPO_PATH)}`, {
    method: 'PUT', body: JSON.stringify(body)
  });
  if (!r.ok) die(`push failed (HTTP ${r.status}): ${r.text().slice(0, 200)}`);
  console.log(`\n✓ pushed — commit ${r.data.commit ? r.data.commit.sha.slice(0, 8) : 'ok'}`);

  const verify = await currentSha(REPO_PATH);
  if (!verify) die('pushed but the file is not readable back — check the repo/branch');
  console.log('✓ verified readable back from GitHub');
}

async function pull() {
  const r = await api(`/repos/${REPO}/contents/${encodeURI(REPO_PATH)}?ref=${BRANCH}`,
    { accept: 'application/vnd.github.raw', headers: { accept: 'application/vnd.github.raw' } });
  if (!r.ok) die(`could not read ${REPO_PATH} (HTTP ${r.status})`);
  console.log(`pulling ${REPO}@${BRANCH}:${REPO_PATH}`);
  // raw accept returns a Buffer via the fetch body; re-fetch as bytes
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${encodeURI(REPO_PATH)}?ref=${BRANCH}`,
    { headers: { authorization: 'Bearer ' + TOKEN, accept: 'application/vnd.github.raw' } });
  let buf = Buffer.from(await res.arrayBuffer());
  if (!PLAIN) buf = zlib.gunzipSync(buf);
  const parsed = JSON.parse(buf.toString('utf8'));
  const out = path.join(DATA_DIR, 'db.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  console.log(`✓ wrote ${out} — ${kb(buf.length)}, ${parsed.users.length} users, ${(parsed.ledger || []).length} ledger entries`);
}

(async () => {
  if (!TOKEN) die('BACKUP_TOKEN is not set');
  console.log(`repo       ${REPO}`);
  try {
    if (PULL) await pull(); else await push();
  } catch (e) {
    die(e.message);
  }
})();
