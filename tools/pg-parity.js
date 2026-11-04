#!/usr/bin/env node
'use strict';
/**
 * Standalone Postgres <-> db.json parity report.
 *
 * Safe to run as often as you like: it only READS. Use it during Phase 2
 * shadow-writes to prove the database keeps up with the JSON store, and as a
 * pre-flight check before flipping the write path.
 *
 *   DATABASE_URL=postgres://... node tools/pg-parity.js
 *   node tools/pg-parity.js --data-dir=/path/to/data --json --quiet
 *
 * Exit codes: 0 = in sync, 1 = error, 2 = drift detected.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const Pg = require(path.join(ROOT, 'lib', 'pg'));
const Parity = require(path.join(ROOT, 'lib', 'pg-parity'));

const argv = process.argv.slice(2);
const arg = n => { const f = argv.find(a => a === '--' + n); return f !== undefined; };
const argVal = (n, d) => { const f = argv.find(a => a.startsWith('--' + n + '=')); return f ? f.split('=').slice(1).join('=') : d; };

function readDb(dataDir) {
  // Read the file directly. Going through lib/db.js would run its seeding and
  // migration hooks and write a fresh db.json into a production data directory.
  const f = path.join(dataDir, 'db.json');
  if (!fs.existsSync(f)) throw new Error('no db.json at ' + f);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

const MAX_SAMPLES = 5;

function table(results) {
  const head = ['collection', 'json', 'pg', 'missing', 'extra', 'mismatch'];
  // missingInPg / extraInPg / mismatched are ARRAYS of keys, not counts.
  const rows = results.map(r => [
    r.collection, r.json, r.pg,
    r.missingInPg.length, r.extraInPg.length, r.mismatched.length
  ]);
  const w = Math.max(...rows.map(r => r[0].length), head[0].length);
  const cell = v => String(v).padStart(8);
  const rule = '  ' + '-'.repeat(w) + '-+-' + head.slice(1).map(() => '-'.repeat(8)).join('-+-');
  console.log('  ' + head[0].padEnd(w) + ' | ' + head.slice(1).map(cell).join(' | '));
  console.log(rule);
  for (const r of rows) {
    const drift = r[3] || r[4] || r[5];
    console.log('  ' + r[0].padEnd(w) + ' | ' + r.slice(1).map(cell).join(' | ') + (drift ? '   << DRIFT' : ''));
  }
  console.log(rule);
}

(async () => {
  const dataDir = path.resolve(argVal('data-dir', process.env.DATA_DIR || path.join(ROOT, 'data')));
  const asJson = arg('json');
  const quiet = arg('quiet') || asJson;

  if (!Pg.enabled()) {
    if (!asJson) console.error('[pg-parity] DATABASE_URL is not set.');
    process.exit(1);
  }
  if (!quiet) console.log('[pg-parity] comparing', path.join(dataDir, 'db.json'), 'against Postgres');

  let db;
  try { db = readDb(dataDir); }
  catch (e) { if (!asJson) console.error('[pg-parity] FAILED:', e.message); process.exit(1); }

  let rep;
  try {
    // Fail with something actionable if the schema was never applied — otherwise
    // the first table read throws "relation \"users\" does not exist", which
    // reads like a bug in this tool rather than a missing migration.
    const have = await Pg.query(
      `SELECT count(*)::int n FROM information_schema.tables
        WHERE table_schema='public' AND table_name='users'`);
    if (!have.rows[0].n) {
      console.error('[pg-parity] the schema has not been applied to this database.');
      console.error('              Run:  node tools/pg-migrate.js --data-dir=' + dataDir);
      await Pg.close(); process.exit(1);
    }
    rep = await Parity.compareAll(db);
  }
  catch (e) {
    if (!asJson) { console.error('[pg-parity] FAILED:', e.message); if (e.detail) console.error('           detail:', e.detail); }
    await Pg.close().catch(() => {}); process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: rep.ok, totals: rep.totals, results: rep.results }, null, 2));
  } else {
    console.log('');
    table(rep.results);
    console.log('');
    console.log('  totals: json', rep.totals.jsonRows, '| pg', rep.totals.pgRows,
      '| missing', rep.totals.missingInPg, '| extra', rep.totals.extraInPg,
      '| mismatched', rep.totals.mismatched);
    console.log('');
    if (rep.ok) {
      console.log('[pg-parity] IN SYNC.');
    } else {
      console.log('[pg-parity] DRIFT DETECTED. First differences per collection:');
      // Composite keys (wallets: user_id + mode) are joined internally with a
      // NUL byte so no real id can collide with the separator. Render it readably.
      const disp = k => String(k).replace(/\u0000/g, ' | ');
      const show = (label, keys) => {
        if (!keys.length) return;
        const n = Math.min(keys.length, MAX_SAMPLES);
        console.log(`    ${label} ${keys.length}: ${keys.slice(0, n).map(disp).join(', ')}${keys.length > n ? ` ... and ${keys.length - n} more` : ''}`);
      };
      for (const r of rep.results) {
        const total = r.missingInPg.length + r.extraInPg.length + r.mismatched.length;
        if (!total) continue;
        console.log(`  ${r.collection}: ${total} differing row${total === 1 ? '' : 's'}`);
        show('missing in pg ', r.missingInPg);
        show('extra in pg   ', r.extraInPg);
        // Mismatches carry a field-level diff, which is the useful part.
        if (r.mismatched.length) {
          console.log(`    mismatched    ${r.mismatched.length}: ${r.mismatched.slice(0, MAX_SAMPLES).map(disp).join(', ')}${r.mismatched.length > MAX_SAMPLES ? ` ... and ${r.mismatched.length - MAX_SAMPLES} more` : ''}`);
          for (const s of r.samples.slice(0, MAX_SAMPLES)) {
            if (!s.diff) continue;
            // firstDiff() returns `path` as a dotted STRING, not an array.
            console.log(`      ${disp(s.key)} at "${s.diff.path}"  json=${JSON.stringify(s.diff.json)}  pg=${JSON.stringify(s.diff.pg)}`);
          }
        }
      }
      console.log('');
      console.log('  Re-run with --json for the complete machine-readable diff.');
    }
  }
  await Pg.close();
  process.exit(rep.ok ? 0 : 2);
})().catch(async e => {
  console.error('[pg-parity] FAILED:', e.message);
  try { await Pg.close(); } catch (_) {}
  process.exit(1);
});
