'use strict';
/**
 * Minimal SMTP client (zero deps) + branded email templates.
 * Uses settings.smtp {host, port, user, pass, from}. Port 465 = implicit TLS,
 * anything else = plain/STARTTLS. Every attempt is journaled to the `emails`
 * collection so admins can see the outbox.
 */
const net = require('net');
const tls = require('tls');
const D = require('./db');

function journal(to, subject, status, error) {
  try {
    D.insert('emails', { id: require('./utils').uid('em_'), to, subject, status, error: error || '', at: Date.now() });
    if (D.db().emails.length > 500) D.db().emails.splice(0, D.db().emails.length - 500);
    D.save();
  } catch (e) { /* journaling must never break sending */ }
}

class SmtpConversation {
  constructor(socket) { this.socket = socket; this.queue = []; this.waiting = null; }
  start() {
    this.socket.on('data', d => {
      // multi-line responses: "250-..." until "250 ..."
      const lines = d.toString().split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (this.waiting) { const w = this.waiting; this.waiting = null; w(null, last); }
    });
    this.socket.on('error', e => { if (this.waiting) { const w = this.waiting; this.waiting = null; w(e); } });
  }
  read() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; this.waiting = null; reject(new Error('SMTP timeout')); } }, 12000);
      this.waiting = (err, line) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (err) reject(err); else resolve(line);
      };
    });
  }
  async cmd(line, expect) {
    this.socket.write(line + '\r\n');
    const resp = await this.read();
    const code = parseInt(resp, 10);
    if (expect && code >= expect) return resp;         // e.g. expect=200 → ok if 2xx
    if (!expect || (code >= 200 && code < 400)) return resp;
    throw new Error('SMTP error: ' + resp);
  }
  quit() { try { this.socket.end(); } catch (e) {} }
}

function connect(smtp) {
  return new Promise((resolve, reject) => {
    const isTls = Number(smtp.port) === 465;
    const socket = isTls
      ? tls.connect({ host: smtp.host, port: Number(smtp.port) || 465, rejectUnauthorized: false, servername: smtp.host, minVersion: 'TLSv1.2' }, () => resolve(socket))
      : net.connect({ host: smtp.host, port: Number(smtp.port) || 587 }, () => resolve(socket));
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('SMTP connect timeout')); });
    socket.on('error', e => reject(e));
  });
}

/* ---------- HTTP transports (work where SMTP ports are blocked, e.g. Render free tier) ---------- */
async function sendViaSendGrid({ to, subject, html }) {
  const s = D.db().settings || {};
  const e = s.email || {};
  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + e.sendgridKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: (s.smtp && (s.smtp.from || s.smtp.user)) || s.supportEmail || 'noreply@blockchainbullhorn.com', name: 'Blockchain Bullhorn' },
      subject,
      content: [{ type: 'text/html', value: html }]
    })
  });
  if (resp.ok) return { sent: true };
  const err = await resp.text().catch(() => '');
  return { sent: false, error: `SendGrid ${resp.status}: ${err.slice(0, 200)}` };
}

/** Gmail relay via a Google Apps Script web app (uses the owner Gmail's daily quota). */
async function sendViaRelay({ to, subject, html }) {
  const e = (D.db().settings || {}).email || {};
  const resp = await fetch(e.relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, // text/plain avoids any preflight/redirect quirks
    body: JSON.stringify({ secret: e.relaySecret, to, subject, html }),
    redirect: 'follow'
  });
  if (resp.ok) {
    const txt = await resp.text().catch(() => '');
    if (/sent|ok/i.test(txt.slice(0, 40))) return { sent: true };
    return { sent: false, error: 'Relay: ' + txt.slice(0, 200) };
  }
  const err = await resp.text().catch(() => '');
  return { sent: false, error: `Relay ${resp.status}: ${err.slice(0, 200)}` };
}

/**
 * Send an email. Returns {sent:true} or {skipped:true} when no transport is configured.
 * Transport order: settings.email.transport ('sendgrid' | 'relay') else SMTP.
 * Never throws — failures are journaled.
 */
async function sendMail({ to, subject, html }) {
  const settings = D.db().settings || {};
  const emailCfg = settings.email || {};
  const transport = emailCfg.transport || 'smtp';
  if (transport !== 'smtp') {
    const usable = transport === 'sendgrid' ? !!emailCfg.sendgridKey : !!emailCfg.relayUrl;
    if (!usable) { journal(to, subject, 'skipped', `Transport '${transport}' selected but not configured`); return { skipped: true }; }
    if (!to || !/.+@.+\..+/.test(to)) { journal(to, subject, 'failed', 'Invalid recipient'); return { sent: false }; }
    try {
      const r = transport === 'sendgrid'
        ? await sendViaSendGrid({ to, subject, html })
        : await sendViaRelay({ to, subject, html });
      if (r.sent) { journal(to, subject, 'sent', ''); return { sent: true }; }
      journal(to, subject, 'failed', r.error || 'unknown');
      return r;
    } catch (e2) {
      journal(to, subject, 'failed', e2.message);
      return { sent: false, error: e2.message };
    }
  }
  const smtp = settings.smtp || {};
  if (!smtp.host || !smtp.user || !smtp.pass) { journal(to, subject, 'skipped', 'SMTP not configured'); return { skipped: true }; }
  if (!to || !/.+@.+\..+/.test(to)) { journal(to, subject, 'failed', 'Invalid recipient'); return { sent: false }; }
  let conv = null;
  try {
    const socket = await connect(smtp);
    conv = new SmtpConversation(socket);
    conv.start();
    await conv.read();                                        // greeting
    await conv.cmd('EHLO blockchainbullhorn.local');
    if (Number(smtp.port) !== 465) {
      const r = await conv.cmd('STARTTLS', 220);
      const secured = await new Promise((resolve, reject) => {
        // servername (SNI) is required by Gmail/modern SMTP servers — without it the
        // handshake fails with a TLS protocol-version alert
        const t = tls.connect({ socket, rejectUnauthorized: false, servername: smtp.host, minVersion: 'TLSv1.2' }, () => resolve(t));
        t.on('error', reject);
      });
      conv = new SmtpConversation(secured);
      conv.start();
      await conv.cmd('EHLO blockchainbullhorn.local');
    }
    await conv.cmd('AUTH LOGIN', 334);
    await conv.cmd(Buffer.from(smtp.user).toString('base64'), 334);
    await conv.cmd(Buffer.from(smtp.pass).toString('base64'), 235);
    const from = (smtp.from || smtp.user).replace(/[\r\n]/g, '');
    await conv.cmd('MAIL FROM:<' + from + '>', 200);
    await conv.cmd('RCPT TO:<' + String(to).replace(/[\r\n]/g, '') + '>', 200);
    await conv.cmd('DATA', 354);
    const body = [
      'From: Blockchain Bullhorn <' + from + '>',
      'To: ' + to,
      'Subject: ' + String(subject).replace(/[\r\n]/g, ' '),
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      '',
      html, '.'
    ].join('\r\n');
    socket.write(body + '\r\n');
    await conv.cmd('.', 200);
    conv.quit();
    journal(to, subject, 'sent', '');
    return { sent: true };
  } catch (e) {
    if (conv) conv.quit();
    let msg = e.message || 'SMTP unreachable';
    if (process.env.RENDER && (!e.message || /timeout|econn|unreachable|protocol version/i.test(msg))) {
      msg += ' — note: the Render FREE tier blocks SMTP ports (25/465/587). Switch Admin → Settings → Email Delivery to the SendGrid API or Gmail Relay transport.';
    }
    journal(to, subject, 'failed', msg);
    return { sent: false, error: msg };
  }
}

/* ---------- branded templates ---------- */
const SITE_URL = 'https://blockchainbullhorn.onrender.com';

/** Branded email wrapper — mirrors the website design: white header + logo,
 *  gold announcement-style divider, cream page, green CTA buttons, and the
 *  gold footer with blue social pills exactly like blockchainbullhorn.com. */
function wrap(title, inner, ctaHref, ctaText) {
  const abs = h => /^https?:/.test(h || '') ? h : SITE_URL + (h || '');
  const cta = ctaHref ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px auto 4px"><tr>
        <td style="border-radius:8px;background:#1ba94b;text-align:center">
          <a href="${abs(ctaHref)}" style="display:inline-block;padding:13px 32px;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px;color:#ffffff;text-decoration:none;border-radius:8px">${ctaText}</a>
        </td>
      </tr></table>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#97836f;text-align:center;margin-top:10px">Or open it directly: <a href="${abs(ctaHref)}" style="color:#0047c2">${abs(ctaHref)}</a></div>` : '';
  return `<!DOCTYPE html><html lang="en"><body style="margin:0;padding:0;background:#f7efdd;-webkit-text-size-adjust:100%">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">Blockchain Bullhorn — ${title}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7efdd"><tr><td align="center" style="padding:28px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

      <!-- header: white, like the site header -->
      <tr><td style="background:#ffffff;border:1px solid rgba(63,20,12,.14);border-bottom:none;border-radius:14px 14px 0 0;padding:22px 30px 16px">
        <img src="${SITE_URL}/assets/img/brand/logo.png" width="44" height="44" alt="" style="border-radius:10px;vertical-align:middle">
        <span style="font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:20px;color:#3f140c;vertical-align:middle;margin-left:10px">Blockchain <span style="color:#1ba94b">Bullhorn</span></span><br>
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:2px;color:#97836f;text-transform:uppercase">Grab the Bull by the Horns</span>
      </td></tr>

      <!-- gold announcement-style divider -->
      <tr><td style="height:5px;background:#d3a877;border-left:1px solid rgba(63,20,12,.14);border-right:1px solid rgba(63,20,12,.14);font-size:0;line-height:0">&nbsp;</td></tr>

      <!-- body card -->
      <tr><td style="background:#ffffff;border:1px solid rgba(63,20,12,.14);border-top:none;border-radius:0 0 14px 14px;padding:32px 34px">
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:10.5px;font-weight:700;letter-spacing:2.2px;color:#d3a877;text-transform:uppercase;margin-bottom:8px">Blockchain Bullhorn</div>
        <h2 style="font-family:Arial,Helvetica,sans-serif;color:#3f140c;font-size:21px;line-height:1.3;margin:0 0 14px">${title}</h2>
        <div style="font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#57231a">${inner}</div>
        ${cta}
      </td></tr>

      <!-- footer: gold, like the site footer -->
      <tr><td style="height:16px;font-size:0;line-height:0">&nbsp;</td></tr>
      <tr><td style="background:#d3a877;border-radius:14px;padding:26px 32px;text-align:center">
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;margin-bottom:14px">
          <a href="${SITE_URL}/markets" style="color:#3f140c;text-decoration:underline;margin:0 7px">Markets</a>·
          <a href="${SITE_URL}/trade" style="color:#3f140c;text-decoration:underline;margin:0 7px">Trading</a>·
          <a href="${SITE_URL}/trading-bots" style="color:#3f140c;text-decoration:underline;margin:0 7px">Trading Bots</a>·
          <a href="${SITE_URL}/store" style="color:#3f140c;text-decoration:underline;margin:0 7px">Store</a>
        </div>
        <div style="font-family:Arial,Helvetica,sans-serif;margin-bottom:16px">
          <a href="https://www.tiktok.com/@blockchainbullhorn" style="display:inline-block;background:#0047c2;color:#ffffff;font-size:12px;font-weight:700;text-decoration:none;border-radius:999px;padding:7px 14px;margin:0 3px">TikTok</a>
          <a href="https://www.instagram.com/blockchainbullhorn" style="display:inline-block;background:#0047c2;color:#ffffff;font-size:12px;font-weight:700;text-decoration:none;border-radius:999px;padding:7px 14px;margin:0 3px">Instagram</a>
          <a href="https://x.com/Blockchainbhorn" style="display:inline-block;background:#0047c2;color:#ffffff;font-size:12px;font-weight:700;text-decoration:none;border-radius:999px;padding:7px 14px;margin:0 3px">X</a>
          <a href="https://www.youtube.com/@blockchainbullhorn" style="display:inline-block;background:#0047c2;color:#ffffff;font-size:12px;font-weight:700;text-decoration:none;border-radius:999px;padding:7px 14px;margin:0 3px">YouTube</a>
        </div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#3f140c;line-height:1.7">
          <a href="${SITE_URL}/contact" style="color:#3f140c;font-weight:700;text-decoration:underline">Email Support</a> ·
          <a href="${SITE_URL}/faq" style="color:#3f140c;font-weight:700;text-decoration:underline">FAQs</a><br>
          &#9888;&#65039; <b>Fraud Alert:</b> We NEVER DM first or ask for crypto. Verify accounts on our <a href="${SITE_URL}/avoid-scams" style="color:#3f140c;text-decoration:underline">Fraud Alert page</a>.<br>
          <span style="color:#57231a">Trading involves risk. Nothing here is financial advice.</span>
        </div>
        <div style="border-top:1px solid rgba(63,20,12,.28);margin:16px 0 12px;font-size:0;line-height:0">&nbsp;</div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:10.5px;color:#57231a;line-height:1.6">
          Blockchain Bullhorn &middot; 650 Ponce De Leon Ave Ste. 300 #1282, Atlanta, GA 30308<br>
          &copy; ${new Date().getFullYear()} Blockchain Bullhorn. All rights reserved.
        </div>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

const templates = {
  kycApproved: (u) => wrap('✅ KYC Verified — You\'re Approved!',
    `Hi ${u.name ? u.name.split(' ')[0] : 'trader'}, your identity verification has been <b>approved</b>. Live trading, withdrawals and live copy trading are now unlocked on your account.`,
    '/dashboard', 'Open Dashboard'),
  kycRejected: (u, reason) => wrap('KYC Verification Update',
    `Hi ${u.name ? u.name.split(' ')[0] : 'trader'}, unfortunately we could not verify your documents. <b>Reason:</b> ${reason || 'Documents unreadable or expired.'} You can re-submit clearer documents from the KYC page.`,
    '/kyc', 'Re-submit KYC'),
  depositApproved: (u, amount, asset) => wrap('💰 Deposit Credited',
    `Your ${asset} deposit of <b>$${amount}</b> has been verified and credited to your live wallet. Happy trading — remember: risk management first.`),
  withdrawDone: (u, amount, asset, address) => wrap('📤 Withdrawal Processed',
    `Your withdrawal of <b>$${amount}</b> in ${asset} to <code style="background:#f6f1e8;padding:2px 6px;border-radius:4px">${String(address).slice(0, 18)}…${String(address).slice(-6)}</code> has been processed by our team.`),
  botKeyApproved: (u, botTitle, key) => wrap('🔑 Trading Bot Connection Key Approved',
    `Your connection key request for <b>${botTitle}</b> has been approved! Activate the bot from the Trading Bots page using this key:<br><br><code style="background:#f6f1e8;padding:8px 14px;border-radius:6px;font-size:16px;letter-spacing:1px"><b>${key}</b></code><br><br>The bot will then place and manage trades on your account automatically — you stay in control and can stop anytime.`,
    '/trading-bots', 'Open Trading Bots'),
  botKeyRejected: (u, botTitle) => wrap('Connection Key Request Declined',
    `Your connection key request for <b>${botTitle}</b> was declined. This is usually a portfolio-balance requirement issue. You can request again once your live portfolio meets the bot's minimum balance.`,
    '/trading-bots', 'View Bots'),
  purchaseApproved: (u, product) => wrap('📦 Purchase Confirmed',
    `Your payment for <b>${product}</b> has been verified and your purchase is confirmed. The product is now unlocked on your account — enjoy, and remember: risk management first!`,
    '/store', 'Open Products'),
  purchaseRejected: (u, product, note) => wrap('Purchase Payment Not Verified',
    `We could not verify the payment for <b>${product}</b>. <b>Reason:</b> ${note || 'The transaction could not be found on-chain.'} If you believe this is a mistake, contact support with your TXID and payment proof.`,
    '/contact', 'Contact Support'),
  withdrawRejected: (u, amount, note) => wrap('Withdrawal Request Declined',
    `Your withdrawal request of <b>$${amount}</b> was declined. <b>Reason:</b> ${note || 'Please contact support.'} The funds have been returned to your live wallet.`),
  newDevice: (u, device, when) => wrap('🔐 New Device Sign-In',
    `A new sign-in to your Blockchain Bullhorn account was detected.<br><br><b>Device:</b> ${device}<br><b>When:</b> ${when}<br><br>If this wasn't you, change your password immediately and contact support.`),
  twofaEnabled: (u) => wrap('2FA Enabled',
    `Two-factor authentication is now <b>active</b> on your account. From now on you'll need your authenticator code to sign in. Keep your backup of the secret safe.`),
  twofaDisabled: (u) => wrap('⚠️ 2FA Disabled',
    `Two-factor authentication has been <b>turned off</b> on your account. If you did not do this, secure your account immediately.`)
};

templates.wrap = wrap; // expose the branded wrapper for ad-hoc emails (admin test send etc.)
module.exports = { sendMail, templates, wrap };
