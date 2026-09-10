'use strict';
const { uid, token, now, hashPassword, verifyPassword } = require('./utils');
const JWT = require('./jwt');
const D = require('./db');

const SESSION_TTL = 7 * 24 * 3600; // 7 days (seconds, JWT exp)
const SESSION_COOKIE = 'bb_session';
const CHAT_COOKIE = 'bb_chat';

// ---- login rate limiting (per email+IP) ----
const attempts = new Map(); // key -> {count, until}
function checkRate(key) {
  const rec = attempts.get(key);
  if (rec && rec.until > now() && rec.count >= 10) return false;
  return true;
}
function failRate(key) {
  let rec = attempts.get(key);
  if (!rec || rec.until < now()) rec = { count: 0, until: now() + 15 * 60 * 1000 };
  rec.count++;
  attempts.set(key, rec);
}
function okRate(key) { attempts.delete(key); }

/**
 * Session token = signed JWT (HS256, server-side secret) wrapping a DB-backed
 * session id. Signature proves authenticity; the DB row allows revocation
 * (logout / ban). Neither the secret nor anything sensitive is in the payload.
 */
function createSession(userId) {
  const sid = token(20);
  D.insert('sessions', { token: sid, userId, createdAt: now(), expiresAt: now() + SESSION_TTL * 1000 });
  return JWT.sign({ sid, uid: userId }, SESSION_TTL);
}

function destroySession(jwtToken) {
  const payload = JWT.verify(jwtToken);
  if (payload && payload.sid) D.remove('sessions', s => s.token === payload.sid);
}

function userFromRequest(req, cookies) {
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  const payload = JWT.verify(raw);
  if (!payload || !payload.sid) return null;
  const sess = D.find('sessions', s => s.token === payload.sid && s.expiresAt > now());
  if (!sess) return null;
  const user = D.find('users', u => u.id === sess.userId);
  if (!user || user.banned) return null;
  return user;
}

function communityStatus(userId) {
  const app = D.find('community_apps', a => a.userId === userId);
  if (!app) return 'none';
  return app.status; // pending | approved | rejected
}

function publicUser(user) {
  if (!user) return null;
  const kyc = D.find('kyc', k => k.userId === user.id);
  const leader = D.find('copy_leaders', l => l.userId === user.id);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    firstName: user.firstName,
    country: user.country,
    role: user.role,
    joinedAt: user.joinedAt,
    referralCode: user.referralCode,
    newsletter: !!user.newsletter,
    avatarColor: user.avatarColor || '#d3a877',
    kycStatus: kyc ? kyc.status : 'not_submitted',
    kycReason: kyc && kyc.status === 'rejected' ? kyc.reason : '',
    communityStatus: communityStatus(user.id),
    copyLeader: leader ? leader.status : '',
    profileComplete: !!(user.name && user.dob && user.country && user.phone)
  };
}

const COLORS = ['#d3a877', '#1ba94b', '#2E91FC', '#e8709a', '#9d7bea', '#f0b429', '#4cc9f0'];
function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

function genReferral(name) {
  const base = (name || 'BB').replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase() || 'BB';
  return base + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function registerUser(data) {
  const email = String(data.email || '').trim().toLowerCase();
  if (D.find('users', u => u.email === email)) return { error: 'An account with this email already exists. Try logging in instead.' };
  const user = {
    id: uid('u_'),
    email,
    passwordHash: hashPassword(data.password),
    name: String(data.name || '').trim(),
    firstName: String(data.name || '').trim().split(' ')[0],
    lastName: String(data.name || '').trim().split(' ').slice(1).join(' '),
    dob: data.dob || '',
    country: data.country || '',
    phone: data.phone || '',
    experience: data.experience || '',
    sourceOfFunds: data.sourceOfFunds || '',
    role: 'user',
    banned: false,
    joinedAt: now(),
    lastLogin: now(),
    referralCode: genReferral(data.name),
    referredBy: data.referredBy || '',
    newsletter: !!data.newsletter,
    avatarColor: randomColor()
  };
  D.insert('users', user);
  const amt = Number(D.db().settings.demoStartBalance) || 10000;
  D.insert('wallets', { userId: user.id, mode: 'demo', usd: amt });
  D.insert('wallets', { userId: user.id, mode: 'live', usd: 0 });
  return { user };
}

module.exports = {
  SESSION_COOKIE, CHAT_COOKIE, createSession, destroySession, userFromRequest, publicUser,
  registerUser, checkRate, failRate, okRate, randomColor, communityStatus
};
