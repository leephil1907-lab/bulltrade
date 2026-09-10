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

function submitKyc(user, idType, docs) {
  const validTypes = ['passport', 'drivers_license', 'national_id'];
  if (!validTypes.includes(idType)) return { status: 400, error: 'Choose a valid ID document type.' };

  // duplicate guard first: an active/pending submission cannot be replaced
  const existing = D.find('kyc', k => k.userId === user.id);
  if (existing && existing.status === 'pending') return { status: 409, error: 'Your KYC is already under review.' };
  if (existing && existing.status === 'approved') return { status: 409, error: 'You are already verified.' };

  if (!docs || docs.length < 2) return { status: 400, error: 'Please upload the front of your ID and a selfie.' };

  const dir = path.join(D.UPLOAD_DIR, user.id);
  fs.mkdirSync(dir, { recursive: true });

  const stored = [];
  for (const d of docs.slice(0, 3)) {
    const mime = String(d.mime || '');
    if (!ALLOWED[mime]) return { status: 400, error: 'Documents must be JPG, PNG, WEBP or PDF.' };
    const b64 = String(d.data || '');
    const buf = Buffer.from(b64, 'base64');
    if (!buf || buf.length < 100) return { status: 400, error: 'One of the documents appears to be empty.' };
    if (buf.length > MAX_DOC) return { status: 400, error: 'Each document must be under 5MB.' };
    const id = uid('d_');
    const file = `${id}${ALLOWED[mime]}`;
    fs.writeFileSync(path.join(dir, file), buf);
    stored.push({ id, kind: d.kind || 'document', file, origName: String(d.name || 'document').slice(0, 120), mime, size: buf.length });
  }

  const rec = {
    id: uid('kyc_'), userId: user.id, status: 'pending', idType,
    docs: stored, submittedAt: now(), reviewedAt: 0, reviewerId: '', reason: ''
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
