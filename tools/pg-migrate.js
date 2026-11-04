#!/usr/bin/env node
'use strict';
/**
 * Backfill db.json -> PostgreSQL.  PHASE 1 tooling; the JSON store stays
 * authoritative and the running app is unaffected.
 *
 *   DATABASE_URL=postgres://... node tools/pg-migrate.js
 *   DATABASE_URL=postgres://... node tools/pg-migrate.js --dry-run
 *   DATABASE_URL=postgres://... node tools/pg-migrate.js --data-dir=/var/data
 *   DATABASE_URL=postgres://... node tools/pg-migrate.js --skip-orphans
 *   DATABASE_URL=postgres://... node tools/pg-migrate.js --prune
 *
 * What it does:
 *   1. applies migrations/ (idempotent, checksummed)
 *   2. pre-flight scans for orphaned foreign keys and REFUSES to start if any
 *      are found, unless --skip-orphans
 *   3. upserts every collection inside ONE transaction, in FK-safe order
 *   4. re-reads every row's `doc` and proves parity against db.json
 *
 * Idempotent: every write is ON CONFLICT DO UPDATE, so re-running after a
 * partial attempt or after more app activity just refreshes the rows.
 *
 * --prune additionally DELETES rows that exist in Postgres but not in db.json.
 * Upserting alone can never remove a row, so a Postgres-only ghost makes parity
 * permanently unreachable; --prune is what lets a re-run converge. It destroys
 * data, so it is opt-in, and it runs inside the same transaction (children
 * before parents) so a failure rolls everything back.
 *
 * Reads the RAW db.json on purpose. Going through lib/db.js would run its
 * seeding and migration hooks and could write demo data into a production
 * database. This tool moves exactly the bytes that are on disk.
 *
 * Exit codes: 0 ok, 1 error, 2 parity drift, 3 orphans found.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Pg = require(path.join(ROOT, 'lib', 'pg'));
const Parity = require(path.join(ROOT, 'lib', 'pg-parity'));

const ARGV = process.argv.slice(2);
const has = f => ARGV.includes(f);
const get = (f, d) => {
  const a = ARGV.find(x => x.startsWith(f + '='));
  return a ? a.slice(f.length + 1) : d;
};

const DRY_RUN = has('--dry-run');
const SKIP_ORPHANS = has('--skip-orphans');
const NO_VERIFY = has('--no-verify');
const PRUNE = has('--prune');
const BATCH = Math.max(1, Number(get('--batch', 500)));

function dataDir() {
  const explicit = get('--data-dir', null);
  if (explicit) return path.resolve(explicit);
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  return path.join(ROOT, 'data');
}

// ---------------------------------------------------------------------------
// Orphan pre-flight. Every one of these columns is a NOT NULL foreign key (or a
// nullable one that still enforces integrity when populated), so a row pointing
// at a deleted user would abort the whole transaction. Better to know first.
// ---------------------------------------------------------------------------
const FK_CHECKS = [
  { coll: 'sessions',         field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'wallets',          field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'ledger',           field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'kyc',              field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'kyc',              field: 'reviewerId', ref: 'users',      refField: 'id', nullable: true },
  { coll: 'positions',        field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'orders',           field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'trades',           field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'transactions',     field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'transactions',     field: 'adminId',  ref: 'users',        refField: 'id', nullable: true },
  { coll: 'chats',            field: 'userId',   ref: 'users',        refField: 'id', nullable: true },
  { coll: 'messages',         field: 'convId',   ref: 'chats',        refField: 'id' },
  { coll: 'resets',           field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'community_apps',   field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'alerts',           field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'logins',           field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'bot_requests',     field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'bot_requests',     field: 'leaderId', ref: 'copy_leaders', refField: 'id', nullable: true },
  { coll: 'copy_allocations', field: 'userId',   ref: 'users',        refField: 'id' },
  { coll: 'copy_allocations', field: 'leaderId', ref: 'copy_leaders', refField: 'id', nullable: true },
  { coll: 'copy_leaders',     field: 'userId',   ref: 'users',        refField: 'id', nullable: true },
  { coll: 'push_subs',        field: 'userId',   ref: 'users',        refField: 'id', nullable: true },
  { coll: 'audit',            field: 'adminId',  ref: 'users',        refField: 'id', nullable: true }
];

function findOrphans(db) {
  const ids = coll => new Set((db[coll] || []).map(r => r && r.id).filter(Boolean));
  const cache = {};
  const idSet = coll => (cache[coll] = cache[coll] || ids(coll));
  const orphans = [];
  for (const chk of FK_CHECKS) {
    const rows = db[chk.coll] || [];
    if (!Array.isArray(rows)) continue;
    const valid = idSet(chk.ref);
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const v = row[chk.field];
      if (v === undefined || v === null || v === '') continue;   // nullable and unset: fine
      if (!valid.has(v)) orphans.push({ collection: chk.coll, field: chk.field, value: v, ref: chk.ref, rowId: row.id || row.token || '(no id)' });
    }
  }
  return orphans;
}

/** Rows that lack a usable primary key cannot be represented at all. */
function findKeyless(db) {
  const bad = [];
  for (const c of Pg.INSERT_ORDER) {
    const spec = Pg.TABLES[c];
    if (spec.singleton) continue;
    const rows = db[c] || [];
    if (!Array.isArray(rows)) continue;
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object') { bad.push({ collection: c, index: i, reason: 'not an object' }); return; }
      for (const k of spec.key) {
        if (row[k] === undefined || row[k] === null || row[k] === '') {
          bad.push({ collection: c, index: i, reason: `missing key field "${k}"` });
          return;
        }
      }
    });
  }
  return bad;
}

/**
 * Delete Postgres rows that have no counterpart in db.json.
 *
 * Needed for convergence: upserting alone can add and update rows but never
 * removes one, so a row that exists only in Postgres (a ghost left by an
 * interrupted run, or a write the app made after the snapshot was taken) makes
 * parity permanently unachievable. Opt-in because it DESTROYS DATA.
 *
 * Runs in FK-safe reverse order — children before parents — inside the caller's
 * transaction, so a failure rolls the whole thing back.
 */
async function pruneExtras(client, coll, expected) {
  const spec = Pg.TABLES[coll];
  if (spec.singleton) return 0;              // one row by definition
  const actual = Object.keys(await Pg.readDocs(coll));
  const extra = actual.filter(k => !expected.has(k));
  if (!extra.length) return 0;

  const meta = await Pg.columnMeta(spec.table, client);
  const keyCols = spec.key.map(Pg.snake);
  const types = keyCols.map(c => (meta.get(c) || {}).type || 'text');
  // Row-constructor match: WHERE (a, b) IN (VALUES ($1::t,$2::t), ($3::t,$4::t))
  for (let i = 0; i < extra.length; i += BATCH) {
    const chunk = extra.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach(k => {
      const parts = String(k).split('\u0000');
      const ph = keyCols.map((_, c) => {
        params.push(parts.length > 1 ? parts[c] : k);
        return `$${params.length}::${types[c]}`;
      });
      vals.push(`(${ph.join(', ')})`);
    });
    await client.query(
      `DELETE FROM ${spec.table} WHERE (${keyCols.join(', ')}) IN (VALUES ${vals.join(', ')})`,
      params);
  }
  return extra.length;
}

async function main() {
  const t0 = Date.now();
  if (!Pg.enabled()) {
    console.error('DATABASE_URL is not set. Nothing to do.\n' +
      '  e.g. DATABASE_URL=postgres://user:pass@host:5432/db node tools/pg-migrate.js');
    process.exit(1);
  }
  if (!Pg.driver()) { console.error('The "pg" package is not installed. Run: npm install'); process.exit(1); }

  const dir = dataDir();
  const file = path.join(dir, 'db.json');
  console.log(`[pg-migrate] data dir : ${dir}`);
  console.log(`[pg-migrate] db.json  : ${file}`);
  console.log(`[pg-migrate] target   : ${String(process.env.DATABASE_URL).replace(/\/\/[^@]*@/, '//***:***@')}`);
  console.log(`[pg-migrate] mode     : ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}`);

  if (!fs.existsSync(file)) {
    console.error(`[pg-migrate] ${file} does not exist. Start the app once, or pass --data-dir=/var/data`);
    process.exit(1);
  }
  let db;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.error('[pg-migrate] db.json is not valid JSON:', e.message); process.exit(1); }

  // ---- schema ----
  const mig = await Pg.migrate();
  console.log(`[pg-migrate] migrations: ${mig.total} found, applied [${mig.applied.join(', ') || 'none'}], ` +
              `skipped [${mig.skipped.join(', ') || 'none'}]`);
  if (mig.drifted.length) {
    console.error(`[pg-migrate] DRIFT: already-applied migration file(s) changed on disk: ${mig.drifted.join(', ')}`);
    console.error('               Never edit an applied migration; add a new numbered file instead.');
    await Pg.close(); process.exit(1);
  }

  // ---- pre-flight ----
  const orphans = findOrphans(db);
  const keyless = findKeyless(db);
  if (orphans.length || keyless.length) {
    console.log(`\n[pg-migrate] pre-flight found ${orphans.length} orphaned FK reference(s) and ${keyless.length} keyless row(s):`);
    for (const o of orphans.slice(0, 20)) console.log(`  orphan  ${o.collection}.${o.field} = ${o.value} (no such ${o.ref}.id), row ${o.rowId}`);
    if (orphans.length > 20) console.log(`  ... and ${orphans.length - 20} more`);
    for (const k of keyless.slice(0, 20)) console.log(`  keyless ${k.collection}[${k.index}]: ${k.reason}`);
    if (keyless.length > 20) console.log(`  ... and ${keyless.length - 20} more`);
    console.log('\n  These rows cannot be inserted: the schema enforces referential integrity.');
    console.log('  Fix the source data, or re-run with --skip-orphans to migrate everything else');
    console.log('  and leave these rows behind (they stay safe in db.json).');
    if (!SKIP_ORPHANS) { await Pg.close(); process.exit(3); }
    console.log('  --skip-orphans given: continuing, these rows will be SKIPPED.\n');
  }

  const skipKeys = new Set(orphans.map(o => `${o.collection}\u0000${o.rowId}`));
  const skipIdx = new Set(keyless.map(k => `${k.collection}\u0000${k.index}`));

  if (DRY_RUN) {
    const before = await Pg.counts();
    console.log('[pg-migrate] DRY RUN — current row counts:');
    for (const c of Pg.INSERT_ORDER) console.log(`    ${c.padEnd(18)} ${String(before[c]).padStart(6)} in PG   ${String((db[c] || []).length || (c === 'settings' ? 1 : 0)).padStart(6)} in JSON`);
    await Pg.close();
    console.log(`\n[pg-migrate] dry run complete in ${Date.now() - t0} ms — nothing was written.`);
    process.exit(0);
  }

  // ---- migrate, one transaction so a failure cannot leave a half-filled DB ----
  const written = {}, skipped = {}, pruned = {};
  await Pg.tx(async client => {
    for (const coll of Pg.INSERT_ORDER) {
      const spec = Pg.TABLES[coll];
      // Async variant: wraps NOT NULL columns in COALESCE with the schema's own
      // default, so sparse documents (a user with no `suspended` field) fall
      // back to the default instead of inserting an explicit NULL.
      const u = await Pg.upserter(coll, client);
      let n = 0, s = 0;

      if (spec.singleton) {
        if (db[coll] && typeof db[coll] === 'object') {
          await client.query(u.sql, u.params(db[coll])); n = 1;
        }
      } else {
        const rows = Array.isArray(db[coll]) ? db[coll] : [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!row || typeof row !== 'object') { s++; continue; }
          const rid = row.id || row.token || '';
          if (skipIdx.has(`${coll}\u0000${i}`) || skipKeys.has(`${coll}\u0000${rid}`)) { s++; continue; }
          await client.query(u.sql, u.params(row));
          n++;
          // Periodic progress on the big tables (trades can be large).
          if (n % 5000 === 0) process.stdout.write(`    ${coll}: ${n}\r`);
        }
        if (n >= 5000) console.log(`    ${coll}: ${n}   `);
      }
      written[coll] = n; skipped[coll] = s;
    }

    // Reverse INSERT_ORDER: delete children before their parents so the foreign
    // keys are satisfied on the way out.
    if (PRUNE) {
      for (const coll of [...Pg.INSERT_ORDER].reverse()) {
        const expected = new Set();
        if (Pg.TABLES[coll].singleton) continue;
        for (const row of (Array.isArray(db[coll]) ? db[coll] : [])) {
          if (!row || typeof row !== 'object') continue;
          const k = Pg.keyOf(coll, row);
          if (k !== undefined && k !== null) expected.add(String(k));
        }
        const d = await pruneExtras(client, coll, expected);
        if (d) pruned[coll] = d;
      }
    }
  });

  const totalWritten = Object.values(written).reduce((a, b) => a + b, 0);
  const totalSkipped = Object.values(skipped).reduce((a, b) => a + b, 0);
  const totalPruned = Object.values(pruned).reduce((a, b) => a + b, 0);
  console.log(`\n[pg-migrate] wrote ${totalWritten} row(s), skipped ${totalSkipped} ` +
              `(orphaned/keyless)${totalPruned ? `, pruned ${totalPruned} Postgres-only row(s)` : ''} ` +
              `in ${Date.now() - t0} ms`);
  if (totalPruned) {
    for (const c of Pg.INSERT_ORDER) if (pruned[c]) console.log(`    ${c.padEnd(18)} ${String(pruned[c]).padStart(6)} pruned`);
  }
  for (const c of Pg.INSERT_ORDER) {
    if (written[c] || skipped[c]) console.log(`    ${c.padEnd(18)} ${String(written[c]).padStart(6)} written` + (skipped[c] ? `   ${skipped[c]} skipped` : ''));
  }

  // ---- verify ----
  if (NO_VERIFY) {
    await Pg.close();
    console.log('\n[pg-migrate] --no-verify given; skipping the parity check.');
    process.exit(0);
  }

  console.log('\n[pg-migrate] verifying parity (reading every doc back out of Postgres)...');
  const rep = await Parity.compareAll(db);
  const t = rep.totals;
  console.log(`    collections checked : ${t.collections}`);
  console.log(`    json rows           : ${t.jsonRows}`);
  console.log(`    pg rows             : ${t.pgRows}`);
  console.log(`    missing in pg       : ${t.missingInPg}`);
  console.log(`    extra in pg         : ${t.extraInPg}`);
  console.log(`    mismatched          : ${t.mismatched}`);

  if (!rep.ok) {
    console.log('\n[pg-migrate] DRIFT DETECTED:');
    for (const r of rep.results) {
      if (!r.missingInPg.length && !r.extraInPg.length && !r.mismatched.length) continue;
      console.log(`  ${r.collection}: missing=${r.missingInPg.length} extra=${r.extraInPg.length} mismatched=${r.mismatched.length}`);
      for (const s of r.samples) {
        console.log(`    key ${s.key}`);
        if (s.diff) console.log(`      at ${s.diff.path}: json=${JSON.stringify(s.diff.json)} pg=${JSON.stringify(s.diff.pg)}`);
      }
      for (const m of r.missingInPg.slice(0, 5)) console.log(`    missing: ${m}`);
      for (const e of r.extraInPg.slice(0, 5)) console.log(`    extra: ${e}`);
    }
    if (totalSkipped > 0) {
      console.log(`\n  Note: ${totalSkipped} row(s) were deliberately skipped (--skip-orphans),`);
      console.log('  which accounts for some "missing in pg" entries above.');
    }
    await Pg.close();
    process.exit(2);
  }

  await Pg.close();
  console.log('\n[pg-migrate] PARITY OK — Postgres matches db.json exactly.');
  console.log('             The JSON store is still authoritative. Do not flip the write path');
  console.log('             until this has been run against a copy of real production data.');
  process.exit(0);
}

main().catch(async e => {
  console.error('[pg-migrate] FAILED:', e.message);
  if (e.detail) console.error('               detail:', e.detail);
  try { await Pg.close(); } catch (_) {}
  process.exit(1);
});
