'use strict';
/**
 * Parity verification: prove that what is in Postgres is identical to what was
 * in the JSON store.
 *
 * This is the safety instrument for the migration. Phase 2 (flipping the write
 * path so Postgres becomes authoritative) must not start until this reports
 * zero differences against a copy of real production data — because the failure
 * mode it guards against is silent, and it is money.
 *
 * Comparison is done against each table's `doc` jsonb column, which holds the
 * original object verbatim. That means the check is lossless-by-construction:
 * a field that was never modelled as a typed column still has to match, so this
 * catches "the migration quietly dropped a field nobody remembered".
 *
 * Numbers need care. Postgres jsonb stores JSON numbers as exact decimals, and
 * the pg driver returns `numeric` columns as strings but jsonb numbers as JS
 * numbers. So a double like 0.022517393297237343 has to survive
 *   JS double -> JSON text -> jsonb numeric -> JSON text -> JS double
 * unchanged. tests/pg.js asserts exactly that round-trip rather than assuming it.
 */

const Pg = require('./pg');

/** Structural equality with number normalisation and key order ignored. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  // numeric columns come back as strings; jsonb numbers come back as numbers.
  // Accept a string/number pair only when they denote the same value.
  if ((typeof a === 'number' && typeof b === 'string') || (typeof a === 'string' && typeof b === 'number')) {
    const na = Number(a), nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb && /^-?[\d.eE+-]+$/.test(String(a)) && /^-?[\d.eE+-]+$/.test(String(b));
  }
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/** First differing path, for a useful error message instead of "mismatch". */
function firstDiff(a, b, prefix) {
  prefix = prefix || '';
  if (deepEqual(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return { path: prefix || '(root)', json: a, pg: b };
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const la = Array.isArray(a) ? a.length : -1, lb = Array.isArray(b) ? b.length : -1;
    if (la !== lb) return { path: prefix + '.length', json: la, pg: lb };
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${prefix}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) return { path: `${prefix}.${k}`, json: '(absent)', pg: b[k] };
    if (!(k in b)) return { path: `${prefix}.${k}`, json: a[k], pg: '(absent)' };
    const d = firstDiff(a[k], b[k], `${prefix}.${k}`);
    if (d) return d;
  }
  return null;
}

/**
 * Compare one collection.
 * @param {Array|object} jsonValue  the array from db.json (or the settings object)
 * @param {string} collection
 * @returns {Promise<{collection, json, pg, missingInPg, extraInPg, mismatched, samples}>}
 */
async function compareCollection(collection, jsonValue) {
  const spec = Pg.TABLES[collection];
  if (!spec) throw new Error('unknown collection: ' + collection);

  const pgDocs = await Pg.readDocs(collection);
  const result = {
    collection, json: 0, pg: Object.keys(pgDocs).length,
    missingInPg: [], extraInPg: [], mismatched: [], samples: []
  };

  if (spec.singleton) {
    const j = jsonValue || null;
    const p = pgDocs.__singleton__ || null;
    result.json = j ? 1 : 0;
    if (j && !p) result.missingInPg.push('(singleton)');
    else if (!j && p) result.extraInPg.push('(singleton)');
    else if (j && p && !deepEqual(j, p)) {
      result.mismatched.push('(singleton)');
      result.samples.push({ key: '(singleton)', diff: firstDiff(j, p) });
    }
    return result;
  }

  const rows = Array.isArray(jsonValue) ? jsonValue : [];
  result.json = rows.length;
  const seen = new Set();

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const k = Pg.keyOf(collection, row);
    if (k === undefined || k === null) {
      // No usable primary key — this row cannot be represented in Postgres at
      // all. Surface it loudly rather than skipping it silently.
      result.missingInPg.push('(no primary key) ' + JSON.stringify(row).slice(0, 120));
      continue;
    }
    seen.add(k);
    const p = pgDocs[k];
    if (p === undefined) { result.missingInPg.push(String(k)); continue; }
    if (!deepEqual(row, p)) {
      result.mismatched.push(String(k));
      if (result.samples.length < 5) result.samples.push({ key: String(k), diff: firstDiff(row, p) });
    }
  }

  for (const k of Object.keys(pgDocs)) {
    if (!seen.has(k)) result.extraInPg.push(String(k));
  }
  return result;
}

/**
 * Compare every collection in a parsed db.json against Postgres.
 * Returns { ok, totals, results } where ok === true only if there is no drift.
 */
async function compareAll(dbObj) {
  const results = [];
  for (const c of Pg.INSERT_ORDER) {
    results.push(await compareCollection(c, dbObj[c]));
  }
  const sum = f => results.reduce((n, r) => n + (r[f] ? r[f].length : 0), 0);
  const totals = {
    collections: results.length,
    jsonRows: results.reduce((n, r) => n + r.json, 0),
    pgRows: results.reduce((n, r) => n + r.pg, 0),
    missingInPg: sum('missingInPg'),
    extraInPg: sum('extraInPg'),
    mismatched: sum('mismatched')
  };
  return {
    ok: totals.missingInPg === 0 && totals.extraInPg === 0 && totals.mismatched === 0,
    totals, results
  };
}

module.exports = { deepEqual, firstDiff, compareCollection, compareAll };
