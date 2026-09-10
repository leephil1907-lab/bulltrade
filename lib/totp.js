'use strict';
/**
 * TOTP two-factor authentication (RFC 6238) — Google Authenticator compatible.
 * Zero dependencies: node crypto only.
 */
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  s = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0, out = Buffer.alloc(Math.floor(s.length * 5 / 8));
  let idx = 0;
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[idx++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

/** Current 6-digit code for a base32 secret. */
function totp(secret, step) {
  const t = Math.floor(Date.now() / 30000);
  return hotp(base32Decode(secret), t);
}

/** Verify a code with ±1 time-window tolerance. */
function verify(secret, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const buf = base32Decode(secret);
  const t = Math.floor(Date.now() / 30000);
  for (let w = -1; w <= 1; w++) {
    if (hotp(buf, t + w) === code) return true;
  }
  return false;
}

/** New random 20-byte secret (base32). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** otpauth:// URL for authenticator apps + QR codes. */
function otpauthUrl(secret, email) {
  return 'otpauth://totp/' + encodeURIComponent('Blockchain Bullhorn:' + email) +
    '?secret=' + secret + '&issuer=' + encodeURIComponent('Blockchain Bullhorn') + '&algorithm=SHA1&digits=6&period=30';
}

module.exports = { generateSecret, verify, totp, otpauthUrl };
