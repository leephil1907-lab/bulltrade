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
      ? tls.connect({ host: smtp.host, port: Number(smtp.port) || 465, rejectUnauthorized: false }, () => resolve(socket))
      : net.connect({ host: smtp.host, port: Number(smtp.port) || 587 }, () => resolve(socket));
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('SMTP connect timeout')); });
    socket.on('error', e => reject(e));
  });
}

/**
 * Send an email. Returns {sent:true} or {skipped:true} when SMTP is not configured.
 * Never throws — failures are journaled.
 */
async function sendMail({ to, subject, html }) {
  const smtp = (D.db().settings && D.db().settings.smtp) || {};
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
        const t = tls.connect({ socket, rejectUnauthorized: false }, () => resolve(t));
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
    journal(to, subject, 'failed', e.message);
    return { sent: false, error: e.message };
  }
}

/* ---------- branded templates ---------- */
function wrap(title, inner, ctaHref, ctaText) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f6f1e8;font-family:Georgia,serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e8;padding:28px 12px"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
      <tr><td style="padding:0 0 16px 6px">
        <span style="font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:19px;color:#3f140c">Blockchain <span style="color:#1ba94b">Bullhorn</span></span>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:1.6px;color:#97836f;text-transform:uppercase">Grab the Bull by the Horns</div>
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid rgba(63,20,12,.14);border-radius:10px;padding:30px">
        <h2 style="font-family:Arial,Helvetica,sans-serif;color:#3f140c;font-size:20px;margin:0 0 14px">${title}</h2>
        <div style="font-size:15px;line-height:1.65;color:#57231a">${inner}</div>
        ${ctaHref ? `<div style="margin-top:22px"><a href="${ctaHref}" style="background:#1ba94b;border:2px solid #1ba94b;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:15px;text-decoration:none;padding:11px 26px;border-radius:6px;display:inline-block">${ctaText}</a></div>` : ''}
      </td></tr>
      <tr><td style="padding:16px 6px;font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:#97836f;line-height:1.6">
        Blockchain Bullhorn · 650 Ponce De Leon Ave Ste. 300 #1282, Atlanta, GA 30308<br>
        Trading involves risk. Nothing in this email is financial advice.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

const templates = {
  kycApproved: (u) => wrap('✅ KYC Verified — You\'re Approved!',
    `Hi ${u.name ? u.name.split(' ')[0] : 'trader'}, your identity verification has been <b>approved</b>. Live trading, withdrawals and live copy trading are now unlocked on your account.`,
    'https://' + 'your-dashboard', 'Open Dashboard'),
  kycRejected: (u, reason) => wrap('KYC Verification Update',
    `Hi ${u.name ? u.name.split(' ')[0] : 'trader'}, unfortunately we could not verify your documents. <b>Reason:</b> ${reason || 'Documents unreadable or expired.'} You can re-submit clearer documents from the KYC page.`,
    'https://' + 'your-kyc', 'Re-submit KYC'),
  depositApproved: (u, amount, asset) => wrap('💰 Deposit Credited',
    `Your ${asset} deposit of <b>$${amount}</b> has been verified and credited to your live wallet. Happy trading — remember: risk management first.`),
  withdrawDone: (u, amount, asset, address) => wrap('📤 Withdrawal Processed',
    `Your withdrawal of <b>$${amount}</b> in ${asset} to <code style="background:#f6f1e8;padding:2px 6px;border-radius:4px">${String(address).slice(0, 18)}…${String(address).slice(-6)}</code> has been processed by our team.`),
  withdrawRejected: (u, amount, note) => wrap('Withdrawal Request Declined',
    `Your withdrawal request of <b>$${amount}</b> was declined. <b>Reason:</b> ${note || 'Please contact support.'} The funds have been returned to your live wallet.`),
  newDevice: (u, device, when) => wrap('🔐 New Device Sign-In',
    `A new sign-in to your Blockchain Bullhorn account was detected.<br><br><b>Device:</b> ${device}<br><b>When:</b> ${when}<br><br>If this wasn't you, change your password immediately and contact support.`),
  twofaEnabled: (u) => wrap('2FA Enabled',
    `Two-factor authentication is now <b>active</b> on your account. From now on you'll need your authenticator code to sign in. Keep your backup of the secret safe.`),
  twofaDisabled: (u) => wrap('⚠️ 2FA Disabled',
    `Two-factor authentication has been <b>turned off</b> on your account. If you did not do this, secure your account immediately.`)
};

module.exports = { sendMail, templates };
