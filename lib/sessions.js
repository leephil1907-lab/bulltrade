'use strict';
/**
 * Trading sessions, server side.
 *
 * The /sessions page carries its own copy of these windows because the browser
 * cannot require() a module — but anything the *server* needs (the market brief
 * inside outgoing email, for example) uses this file, so at least there is one
 * authoritative definition on the server and one in the page, rather than the
 * numbers being scattered across the codebase.
 *
 * Hours are UTC on a 0–24 clock. `open` > `close` means the session wraps past
 * midnight (Sydney does).
 */

const SESSIONS = [
  { key: 'sydney',  name: 'Sydney',   open: 21, close: 6,  marks: ['ASX'] },
  { key: 'tokyo',   name: 'Tokyo',    open: 0,  close: 9,  marks: ['NIKKEI', 'HSI', 'NIFTY'] },
  { key: 'london',  name: 'London',   open: 7,  close: 16, marks: ['FTSE', 'DAX', 'CAC'] },
  { key: 'newyork', name: 'New York', open: 12, close: 21, marks: ['SPX', 'NDX', 'DJI', 'RUT'] }
];

const OVERLAPS = [
  { from: 7,  to: 9,  label: 'Tokyo × London' },
  { from: 12, to: 16, label: 'London × New York' }
];

const utcHours = (d = new Date()) => d.getUTCHours() + d.getUTCMinutes() / 60;

function inWindow(h, open, close) {
  if (open === close) return false;
  return open < close ? (h >= open && h < close) : (h >= open || h < close);
}

const isOpen = (s, d = new Date()) => inWindow(utcHours(d), s.open, s.close);

const openSessions = (d = new Date()) => SESSIONS.filter(s => isOpen(s, d));

/** The soonest upcoming boundary, as { label, minutes }. */
function nextEvent(d = new Date()) {
  const h = utcHours(d);
  const events = [];
  for (const s of SESSIONS) {
    const open = isOpen(s, d);
    let delta = (open ? s.close : s.open) - h;
    if (delta <= 0) delta += 24;
    events.push({ label: `${s.name} ${open ? 'closes' : 'opens'}`, minutes: delta * 60 });
  }
  for (const o of OVERLAPS) {
    let delta = o.from - h;
    if (delta <= 0) delta += 24;
    events.push({ label: `${o.label} overlap begins`, minutes: delta * 60 });
  }
  events.sort((a, b) => a.minutes - b.minutes);
  return events[0];
}

/** "4h 07m" / "45m" — the same phrasing the website uses. */
function humanMinutes(mins) {
  mins = Math.max(0, Math.round(mins));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 24) return `${Math.round(h / 24)}d`;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

module.exports = { SESSIONS, OVERLAPS, isOpen, openSessions, nextEvent, humanMinutes, utcHours };
