'use strict';
/**
 * XP + achievement badges engine.
 * Levels: every 250 XP = +1 level. Badges are permanent once earned.
 */
const D = require('./db');

const XP_PER_LEVEL = 250;

const BADGES = {
  first_trade:   { icon: 'fa-rocket',        name: 'First Trade',      desc: 'Placed your first market order' },
  ten_trades:    { icon: 'fa-fire',          name: 'Ten Trades Deep',  desc: 'Closed 10 trades' },
  profitable:    { icon: 'fa-chart-line',    name: 'In Profit',        desc: 'Closed a winning trade' },
  streak_3:      { icon: 'fa-bolt',          name: '3-Win Streak',     desc: 'Three winning trades in a row' },
  big_shot:      { icon: 'fa-sack-dollar',   name: 'Big Shot',         desc: 'Closed a single trade of $5,000+ notional' },
  kyc_verified:  { icon: 'fa-id-card',       name: 'Verified Trader',  desc: 'Completed KYC verification' },
  quiz_pass:     { icon: 'fa-graduation-cap',name: 'Chart Literate',   desc: 'Passed the community onboarding quiz' },
  herd_member:   { icon: 'fa-users',         name: 'Herd Member',      desc: 'Approved into the Bullhorn community' },
  copy_starter:  { icon: 'fa-copy',          name: 'Copy Starter',     desc: 'Started your first copy allocation' },
  referrer:      { icon: 'fa-user-plus',     name: 'Recruiter',        desc: 'Referred 3 traders to the platform' }
};

function levelOf(xp) { return Math.floor((xp || 0) / XP_PER_LEVEL) + 1; }

function addXP(userId, amount, reason) {
  const u = D.find('users', x => x.id === userId);
  if (!u) return;
  u.xp = (u.xp || 0) + Math.max(0, Math.round(amount));
  D.save();
}

function grantBadge(userId, badgeId) {
  const meta = BADGES[badgeId];
  const u = D.find('users', x => x.id === userId);
  if (!u || !meta) return false;
  u.badges = Array.isArray(u.badges) ? u.badges : [];
  if (u.badges.includes(badgeId)) return false;
  u.badges.push(badgeId);
  u.xp = (u.xp || 0) + 50; // badge bonus
  D.save();
  return true;
}

function profile(u) {
  const xp = u.xp || 0;
  const level = levelOf(xp);
  return {
    xp, level,
    xpIntoLevel: xp % XP_PER_LEVEL,
    xpForNext: XP_PER_LEVEL,
    badges: (u.badges || []).map(id => Object.assign({ id }, BADGES[id])).filter(b => b.name)
  };
}

module.exports = { BADGES, XP_PER_LEVEL, addXP, grantBadge, profile, levelOf };
