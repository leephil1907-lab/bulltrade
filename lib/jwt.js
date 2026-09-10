'use strict';
/**
 * JWT (HS256) — zero-dependency implementation.
 * The secret is generated once, stored in data/.jwt-secret (mode 0600) and
 * NEVER sent to the client or exposed via any route. The data/ directory
 * lives outside public/ and is never served statically.
 * An environment variable (JWT_SECRET) or a .env file overrides it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');

function loadDotEnv() {
  // minimal .env loader (no deps)
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) {}
}

let _secret = null;
function getSecret() {
  if (_secret) return _secret;
  loadDotEnv();
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    _secret = process.env.JWT_SECRET;
    return _secret;
  }
  try {
    if (fs.existsSync(SECRET_FILE)) {
      _secret = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (_secret.length >= 32) return _secret;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(SECRET_FILE, _secret, { mode: 0o600 });
  } catch (e) {
    // fallback to ephemeral secret (sessions reset on restart)
    _secret = crypto.randomBytes(48).toString('hex');
    console.error('[jwt] Could not persist secret, using ephemeral:', e.message);
  }
  return _secret;
}

const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => Buffer.from(s, 'base64url');

function sign(payload, expiresInSeconds) {
  const secret = getSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({}, payload, { iat: now, exp: now + expiresInSeconds });
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function verify(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;
    const secret = getSecret();
    const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromB64u(p).toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

module.exports = { sign, verify, getSecret };
