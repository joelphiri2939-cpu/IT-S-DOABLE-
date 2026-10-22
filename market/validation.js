'use strict';
const { getCategory, LIMITS, PASS_IDS } = require('./catalog');

// ---------- money (integer ngwee: floats never touch payment amounts) ----------
function toMinor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const minor = Math.round(n * 100);
  if (Math.abs(n * 100 - minor) > 1e-6) return null; // more than 2 decimals
  return minor;
}
const fromMinor = (minor) => Math.round(minor) / 100;
function parseGatewayAmount(str) {
  // Lenco returns amounts as strings, e.g. "50.00"
  if (typeof str === 'number') return toMinor(str);
  if (typeof str !== 'string' || !/^\d+(\.\d{1,2})?$/.test(str.trim())) return null;
  return toMinor(str.trim());
}

// ---------- text helpers ----------
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
function searchTokens(...parts) {
  const out = new Set();
  for (const part of parts) {
    String(part || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).forEach((w) => { if (w.length >= 2 && w.length <= 24) out.add(w); });
  }
  return Array.from(out).slice(0, 25);
}

// ---------- gated file keys ----------
// Paid/gated files live under market-gated/<ownerUid>/<productId>/<preview|main>/<random>.
// The owner writes the asset docs, so the server must prove every key really
// belongs to that owner+product — otherwise someone could point their own
// listing at another user's private file and have us sign a URL for it.
function keyPrefix(ownerUid, productId, kind) { return `market-gated/${ownerUid}/${productId}/${kind}/`; }
function isValidGatedKey(key, ownerUid, productId, kind) {
  return typeof key === 'string' && key.startsWith(keyPrefix(ownerUid, productId, kind))
    && /^[A-Za-z0-9._-]{8,140}$/.test(key.slice(keyPrefix(ownerUid, productId, kind).length));
}
function acceptsType(accept, type) {
  const t = String(type || '').toLowerCase();
  return String(accept).split(',').map((s) => s.trim().toLowerCase()).some((a) => (a.endsWith('/*') ? t.startsWith(a.slice(0, -1)) : t === a));
}
function normalizeAssetDoc(data) {
  if (!data) return { files: [] };
  if (Array.isArray(data.files)) return { files: data.files };
  if (data.filePath) return { files: [{ key: data.filePath, name: data.fileName || 'file', type: data.fileType || '', size: data.fileSizeBytes || 0 }] };
  return { files: [] };
}

function priceField(errors, field, value, label) {
  const minor = toMinor(value);
  if (minor === null) { errors.push({ field, message: `${label}: enter a valid price (max 2 decimals).` }); return null; }
  if (minor < LIMITS.minPriceZmw * 100) { errors.push({ field, message: `${label}: the minimum price is K${LIMITS.minPriceZmw}.` }); return null; }
  if (minor > LIMITS.maxPriceZmw * 100) { errors.push({ field, message: `${label}: the maximum price is K${LIMITS.maxPriceZmw}.` }); return null; }
  return minor;
}

function checkFiles(errors, field, files, { ownerUid, productId, kind, accept, max, label }) {
  if (!Array.isArray(files) || files.length < 1) { errors.push({ field, message: `${label}: add at least one file.` }); return; }
  if (files.length > max) { errors.push({ field, message: `${label}: at most ${max} files.` }); return; }
  files.forEach((f, i) => {
    if (!f || !isValidGatedKey(f.key, ownerUid, productId, kind)) { errors.push({ field, message: `${label}: file ${i + 1} is not valid. Please re-upload it.` }); return; }
    if (!acceptsType(accept, f.type)) { errors.push({ field, message: `${label}: file ${i + 1} is not an allowed type for this category.` }); return; }
    const major = String(f.type).split('/')[0];
    const cap = LIMITS.maxFileBytes[major];
    if (cap && Number(f.size) > cap) errors.push({ field, message: `${label}: file ${i + 1} is too large.` });
  });
}

/**
 * Validates a listing before it can be paid for or resubmitted. Pure function:
 * returns { errors, derived }. derived is trusted data the server writes back.
 */
function validateListing(product, assets, ctx) {
  const errors = [];
  const p = product || {};
  const cat = getCategory(p.category);
  if (!cat) { errors.push({ field: 'category', message: 'Choose a category.' }); return { errors, derived: null }; }
  if (!cat.offerings.includes(p.offering)) errors.push({ field: 'offering', message: 'Choose what you are offering.' });

  const title = cleanText(p.title, LIMITS.titleMax + 1);
  if (title.length < LIMITS.titleMin || title.length > LIMITS.titleMax) errors.push({ field: 'title', message: `Title must be ${LIMITS.titleMin}-${LIMITS.titleMax} characters.` });
  if (cleanText(p.description, LIMITS.descriptionMax + 1).length > LIMITS.descriptionMax) errors.push({ field: 'description', message: `Description is too long (max ${LIMITS.descriptionMax}).` });
  if (!p.coverPath || !p.coverUrl) errors.push({ field: 'cover', message: 'Add a cover photo for your advert.' });

  const prices = [];

  // Preview
  const previewMode = p.previewMode || 'none';
  if (!['none', 'free', 'paid'].includes(previewMode)) errors.push({ field: 'previewMode', message: 'Invalid preview option.' });
  else if (previewMode !== 'none') {
    if (!cat.preview.modes.includes(previewMode)) errors.push({ field: 'previewMode', message: `${cat.label} does not allow a ${previewMode} preview.` });
    else {
      checkFiles(errors, 'preview', assets.preview.files, { ownerUid: ctx.ownerUid, productId: ctx.productId, kind: 'preview', accept: cat.accept, max: LIMITS.maxPreviewFiles, label: 'Preview' });
      if (previewMode === 'paid') { const m = priceField(errors, 'previewPrice', p.previewPrice, 'Preview price'); if (m !== null) prices.push(m); }
    }
  }

  // Full access (stream / read / view)
  const accessMode = p.accessMode || 'none';
  const passPrices = p.passPrices && typeof p.passPrices === 'object' ? p.passPrices : {};
  let needsMain = false;
  if (!['none', 'free', 'paid'].includes(accessMode)) errors.push({ field: 'accessMode', message: 'Invalid access option.' });
  else if (accessMode !== 'none') {
    needsMain = true;
    if (accessMode === 'paid') {
      const allowed = cat.access.kind === 'view' ? ['lifetime'] : PASS_IDS;
      const given = Object.keys(passPrices).filter((k) => passPrices[k] !== '' && passPrices[k] != null);
      const bad = given.filter((k) => !allowed.includes(k));
      if (bad.length) errors.push({ field: 'passPrices', message: 'Invalid access pass.' });
      const useful = given.filter((k) => allowed.includes(k));
      if (!useful.length) errors.push({ field: 'passPrices', message: cat.access.kind === 'view' ? 'Set the price for access.' : 'Enable at least one pass (24-hour, 7-day or 30-day) and set its price.' });
      useful.forEach((k) => { const m = priceField(errors, 'passPrices', passPrices[k], 'Access price'); if (m !== null) prices.push(m); });
    }
  }

  // Download
  const downloadMode = p.downloadMode || 'none';
  if (!['none', 'free', 'paid'].includes(downloadMode)) errors.push({ field: 'downloadMode', message: 'Invalid download option.' });
  else if (downloadMode !== 'none') {
    needsMain = true;
    if (downloadMode === 'paid') { const m = priceField(errors, 'downloadPrice', p.downloadPrice, 'Download price'); if (m !== null) prices.push(m); }
  }

  if (needsMain) checkFiles(errors, 'main', assets.main.files, { ownerUid: ctx.ownerUid, productId: ctx.productId, kind: 'main', accept: cat.accept, max: LIMITS.maxMainFiles, label: 'Main files' });

  if (p.orderable && !cat.order) errors.push({ field: 'orderable', message: `${cat.label} does not support orders.` });

  const offersSomething = previewMode !== 'none' || accessMode !== 'none' || downloadMode !== 'none' || !!p.bookable || !!p.orderable;
  if (!offersSomething) errors.push({ field: 'offer', message: 'Choose at least one thing people can do: preview, access, download, book or order.' });

  const anyFree = previewMode === 'free' || accessMode === 'free' || downloadMode === 'free';
  const fromPriceMinor = prices.length ? Math.min(...prices) : (anyFree ? 0 : null);

  return {
    errors,
    derived: {
      title,
      fromPrice: fromPriceMinor === null ? null : fromMinor(fromPriceMinor),
      searchTokens: searchTokens(title, p.offering, cat.label, p.sellerName),
      categoryLabel: cat.label
    }
  };
}

module.exports = { toMinor, fromMinor, parseGatewayAmount, cleanText, searchTokens, keyPrefix, isValidGatedKey, acceptsType, normalizeAssetDoc, validateListing };
