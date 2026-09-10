'use strict';
/**
 * Web Push sender (VAPID). Wraps the `web-push` npm package — the platform's
 * only runtime dependency — and degrades gracefully when it is not installed
 * (e.g. a dev checkout without `npm install`): config simply reports null.
 */
const D = require('./db');

function webpush() {
  try { return require('web-push'); } catch (e) { /* fall through to the bundled copy */ }
  // single-file esbuild bundle (vendor/webpush.bundle.js) — immune to hosts
  // that filter node_modules directories out of the deployment
  try { return require('../vendor/webpush.bundle.js'); } catch (e) { return null; }
}

function keys() {
  const k = (D.db().settings || {}).pushKeys;
  return (k && k.publicKey && k.privateKey) ? k : null;
}

/** Generate and store a fresh VAPID keypair in settings. */
function generateKeys() {
  const w = webpush();
  if (!w) throw new Error('web-push is not installed (run: npm install)');
  const k = w.generateVAPIDKeys();
  D.db().settings = D.db().settings || {};
  D.db().settings.pushKeys = { publicKey: k.publicKey, privateKey: k.privateKey, createdAt: Date.now() };
  D.save();
  return D.db().settings.pushKeys;
}

/** Send one payload {title, body, url} to a stored subscription. Returns 'sent'|'gone'|'failed'. */
async function send(sub, payload) {
  const w = webpush();
  const k = keys();
  if (!w || !k) return 'unavailable';
  try {
    await w.sendNotification({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }
    }, JSON.stringify(payload), {
      vapidDetails: { subject: 'mailto:support@blockchainbullhorn.com', publicKey: k.publicKey, privateKey: k.privateKey },
      TTL: 24 * 3600
    });
    return 'sent';
  } catch (e) {
    const status = e && e.statusCode;
    if (status === 404 || status === 410) return 'gone';   // subscription expired/unsubscribed
    return 'failed';
  }
}

/** Broadcast to every subscriber. Returns { sent, failed, removed }. */
async function broadcast(payload) {
  const subs = D.db().push_subs || [];
  let sent = 0, failed = 0, removed = 0;
  for (const sub of subs) {
    const r = await send(sub, payload);
    if (r === 'sent') sent++;
    else if (r === 'gone') { removed++; D.db().push_subs = D.db().push_subs.filter(x => x.id !== sub.id); }
    else failed++;
  }
  if (removed) D.save();
  return { sent, failed, removed };
}

module.exports = { webpush, keys, generateKeys, send, broadcast };
