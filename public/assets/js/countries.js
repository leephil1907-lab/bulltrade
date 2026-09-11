// Country list now lives in common.js (CTRY: [{n: name, c: ISO code}]) so the
// globe picker, the signup wizard and the country->currency mapping share one
// source of truth. This shim keeps the classic COUNTRIES name working.
const COUNTRIES = (typeof BB !== 'undefined' && typeof CTRY !== 'undefined') ? CTRY : [];
