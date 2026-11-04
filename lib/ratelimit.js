'use strict';
/**
 * Request throttling for the endpoints an anonymous visitor can abuse.
 *
 * Why this exists: `lib/auth.js` already limits failed *logins*, but signup,
 * password-reset, lead capture, support tickets and chat were wide open. On an
 * always-on paid instance that is a spam, credential-stuffing and
 * mail-quota-burn risk — the password-reset and signup paths both send email,
 * so an unthrottled loop can exhaust a provider's daily allowance and take
 * transactional mail down for real users.
 *
 * Design notes:
 *   - In-memory fixed-window counters. The service is pinned to a single
 *     instance (a Render persistent disk cannot be shared), so there is no
 *     cross-instance state to coordinate. If that ever changes, swap the store
 *     for Render Key Value — the call sites do not change.
 *   - Client identity comes from X-Forwarded-For, NOT socket.remoteAddress.
 *     Behind Render's edge proxy remoteAddress is an internal address shared by
 *     every visitor, so keying on it would lump the whole internet into one
 *     bucket and 429 legitimate users.
 *   - We take the LAST XFF hop, not the first. Our own trusted proxy appends
 *     the real client IP to the end of the header; anything a client sends is
 *     to the left of it. Taking the first entry would let an attacker rotate a
 *     spoofed `X-Forwarded-For` value and bypass the limit entirely.
 *
 * Configuration:
 *   RATE_LIMIT=on|off        force-enable / force-disable. Unset means "on when
 *                            NODE_ENV=production". tests/ratelimit.js turns it
 *                            on explicitly; the e2e suite leaves it off so it
 *                            can create many accounts from one IP.
 *   RATE_LIMIT_<NAME>=max/windowMs   per-rule override, e.g.
 *                            RATE_LIMIT_SIGNUP=20/3600000
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const FORCE = String(process.env.RATE_LIMIT || '').trim().toLowerCase();
const enabled = FORCE === 'off' ? false : (FORCE === 'on' ? true : process.env.NODE_ENV === 'production');

/**
 * Each route maps to one or more rules. A request must pass every rule.
 *   scope 'ip'         -> one shared bucket per client address
 *   scope 'ip+identity' -> additionally per address+email, so rotating the
 *                          email does not reset an account-specific attack,
 *                          and one abusive address cannot lock out a whole
 *                          household sharing an IP.
 */
const RULES = {
  'POST /api/auth/signup':    [{ name: 'signup',   max: 8,   windowMs: HOUR,       scope: 'ip' },
                               { name: 'signup',   max: 3,   windowMs: HOUR,       scope: 'ip+identity' }],
  'POST /api/auth/login-2fa': [{ name: 'twofa',    max: 20,  windowMs: 15 * MINUTE, scope: 'ip' }],
  'POST /api/auth/forgot':    [{ name: 'forgot',   max: 6,   windowMs: HOUR,       scope: 'ip' },
                               { name: 'forgot',   max: 3,   windowMs: HOUR,       scope: 'ip+identity' }],
  'POST /api/auth/reset':     [{ name: 'reset',    max: 10,  windowMs: HOUR,       scope: 'ip' }],
  'POST /api/leads':          [{ name: 'leads',    max: 15,  windowMs: HOUR,       scope: 'ip' },
                               { name: 'leads',    max: 5,   windowMs: HOUR,       scope: 'ip+identity' }],
  'POST /api/support/ticket': [{ name: 'ticket',   max: 12,  windowMs: HOUR,       scope: 'ip' }],
  'POST /api/chat/init':      [{ name: 'chatinit', max: 15,  windowMs: HOUR,       scope: 'ip' }],
  'POST /api/chat/send':      [{ name: 'chatsend', max: 60,  windowMs: 10 * MINUTE, scope: 'ip' }]
};

// Apply RATE_LIMIT_<NAME>=max/windowMs overrides.
for (const route of Object.keys(RULES)) {
  RULES[route] = RULES[route].map(rule => {
    const raw = String(process.env['RATE_LIMIT_' + rule.name.toUpperCase()] || '').trim();
    const m = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!m) return rule;
    const max = Number(m[1]), windowMs = Number(m[2]);
    if (!Number.isFinite(max) || !Number.isFinite(windowMs) || max < 1 || windowMs < 1000) return rule;
    return Object.assign({}, rule, { max, windowMs, overridden: true });
  });
}

const buckets = new Map(); // key -> { count, resetAt }

/** Drop expired buckets so the map cannot grow without bound. */
function prune() {
  const t = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= t) buckets.delete(k);
}
const pruner = setInterval(prune, 5 * MINUTE);
if (pruner.unref) pruner.unref(); // never hold the event loop open for this

/**
 * Best-effort client address. Last XFF hop first (appended by our own proxy),
 * then X-Real-IP, then the socket. Normalised so IPv6 casing cannot be varied
 * to get a fresh bucket.
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const hops = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1].toLowerCase();
  }
  const real = String(req.headers['x-real-ip'] || '').trim();
  if (real) return real.toLowerCase();
  return String((req.socket && req.socket.remoteAddress) || 'unknown').toLowerCase();
}

/** The identity half of an 'ip+identity' rule, when the payload carries one. */
function identityOf(body) {
  const email = String((body && (body.email || body.to)) || '').trim().toLowerCase();
  return email;
}

function hit(key, rule) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= t) {
    b = { count: 0, resetAt: t + rule.windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return b;
}

/**
 * Check (and consume) the quota for a route.
 * Returns null when allowed, or { retryAfterSec, limit } when throttled.
 */
function check(req, routeKey, body) {
  if (!enabled) return null;
  const rules = RULES[routeKey];
  if (!rules || !rules.length) return null;

  const ip = clientIp(req);
  const identity = identityOf(body);
  let blocked = null;

  for (const rule of rules) {
    const scopeKey = rule.scope === 'ip+identity'
      ? (identity ? `${routeKey}|${ip}|${identity}` : null) // no identity -> the ip rule already covers it
      : `${routeKey}|${ip}`;
    if (!scopeKey) continue;

    const b = buckets.get(scopeKey);
    if (b && b.resetAt > Date.now() && b.count >= rule.max) {
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000));
      if (!blocked || retryAfterSec > blocked.retryAfterSec) blocked = { retryAfterSec, limit: rule.max };
      continue; // do not consume from a bucket that is already exhausted
    }
    hit(scopeKey, rule);
  }

  return blocked;
}

/** Peek without consuming — used by /healthz to report limiter state. */
function stats() {
  return { enabled, routes: Object.keys(RULES).length, activeBuckets: buckets.size };
}

function reset() { buckets.clear(); }

module.exports = { check, clientIp, stats, reset, RULES, get enabled() { return enabled; } };
