'use strict';
const crypto = require('crypto');

const uid = (p = '') => p + crypto.randomBytes(9).toString('base64url');
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function now() { return Date.now(); }

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * f) / f;
}

function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '')); }

function pwStrength(pw) {
  let s = 0;
  if (typeof pw !== 'string') return 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s; // 0..5
}

// ---------- scrypt password hashing ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const test = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch (e) { return false; }
}

// ---------- cookies ----------
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookieStr(name, value, opts = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}; SameSite=Lax; HttpOnly`;
  if (opts.maxAge != null) s += `; Max-Age=${opts.maxAge}`;
  if (opts.clear) s = 'Thu, 01 Jan 1970 00:00:00 GMT';
  return s;
}

// ---------- JSON body ----------
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ---------- fetch with retry & timeout ----------
async function fetchJSON(url, opts = {}, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), opts.timeout || 12000);
      const res = await fetch(url, {
        headers: Object.assign({
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json'
        }, opts.headers || {}),
        signal: ctl.signal
      });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fetch failed');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { uid, token, now, clamp, round, isEmail, pwStrength, hashPassword, verifyPassword, parseCookies, cookieStr, readBody, fetchJSON, escapeHtml, crypto };
