'use strict';
/**
 * Manual KYC verification: document upload (base64), validation, storage, admin review.
 */
const fs = require('fs');
const path = require('path');
const { uid, now } = require('./utils');
const D = require('./db');

const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const MAX_DOC = 5 * 1024 * 1024; // 5MB

function submitKyc(user, idType, docs, details) {
  const validTypes = ['passport', 'drivers_license', 'national_id'];
  if (!validTypes.includes(idType)) return { status: 400, error: 'Choose a valid ID document type.' };

  // identity details required for full verification
  const d = details || {};
  const clean = k => String(d[k] || '').trim().slice(0, 160);
  const detailsRec = { fullName: clean('fullName'), idNumber: clean('idNumber'), address: clean('address'), city: clean('city'), country: clean('country') };
  if (!detailsRec.fullName) return { status: 400, error: 'Please enter your full legal name as shown on the document.' };
  if (!detailsRec.idNumber) return { status: 400, error: 'Please enter your document / ID number.' };
  if (!detailsRec.address) return { status: 400, error: 'Please enter your residential address.' };

  // front AND back of the document are required; selfie is optional but recommended
  const list = Array.isArray(docs) ? docs : [];
  const has = k => list.some(x => x && x.kind === k);
  if (!has('front') || !has('back')) return { status: 400, error: 'Please upload both the FRONT and BACK of your ID document.' };

  // duplicate guard first: an active/pending submission cannot be replaced
  const existing = D.find('kyc', k => k.userId === user.id);
  if (existing && existing.status === 'pending') return { status: 409, error: 'Your KYC is already under review.' };
  if (existing && existing.status === 'approved') return { status: 409, error: 'You are already verified.' };

  const dir = path.join(D.UPLOAD_DIR, user.id);
  fs.mkdirSync(dir, { recursive: true });

  const stored = [];
  for (const d of list.slice(0, 4)) {
    const mime = String(d.mime || '');
    if (!ALLOWED[mime]) return { status: 400, error: 'Documents must be JPG, PNG, WEBP or PDF.' };
    const b64 = String(d.data || '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf || buf.length < 100) return { status: 400, error: 'One of the documents appears to be empty.' };
    if (buf.length > MAX_DOC) return { status: 400, error: 'Each document must be under 5MB.' };
    const id = uid('d_');
    const file = `${id}${ALLOWED[mime]}`;
    fs.writeFileSync(path.join(dir, file), buf);
    require('./backup').pushFile(path.join(dir, file)); // GitHub data-sync
    stored.push({ id, kind: d.kind || 'document', file, origName: String(d.name || 'document').slice(0, 120), mime, size: buf.length });
  }

  const rec = {
    id: uid('kyc_'), userId: user.id, status: 'pending', idType,
    details: detailsRec, docs: stored, submittedAt: now(), reviewedAt: 0, reviewerId: '', reason: ''
  };
  if (existing) {
    Object.assign(existing, rec, { id: existing.id });
    D.save();
  } else {
    D.insert('kyc', rec);
  }
  return { ok: true, message: 'KYC documents received. Verification usually completes within 24 hours.' };
}

module.exports = { submitKyc };
