'use strict';
const { HttpError } = require('./errors');
const { PASS_SECONDS } = require('./catalog');
const { toMinor, fromMinor, parseGatewayAmount, normalizeAssetDoc, validateListing, isValidGatedKey } = require('./validation');

const DAY_MS = 24 * 3600 * 1000;

function defaultConfig(env = {}) {
  const pct = Number(env.PLATFORM_FEE_PCT || 0);
  return {
    adPackages: [{
      id: 'standard-7d', name: 'Standard advert', days: Number(env.AD_DAYS || 7),
      priceMinor: toMinor(env.AD_PRICE_ZMW || 50), currency: 'ZMW'
    }],
    platformFeePct: Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 50) : 0,
    renewWindowHours: Number(env.RENEW_WINDOW_HOURS || 72),   // early renewal allowed this long before expiry
    orderTtlHours: Number(env.ORDER_TTL_HOURS || 48),         // unpaid checkouts are cancelled after this
    termsVersion: String(env.TERMS_VERSION || '2026-10-v2'), // bump when the advertising rules / refund policy change
    blockedTerms: String(env.AD_BLOCKED_TERMS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean), // automatic screening, comma-separated
    resubmissions: Number(env.AD_RESUBMISSIONS || 2),         // free fix-and-resubmit attempts after a rejection
    streamTtlSeconds: Number(env.STREAM_URL_TTL_SECONDS || 3600),
    downloadTtlSeconds: Number(env.DOWNLOAD_URL_TTL_SECONDS || 300)
  };
}

function createMarketService({ db, FieldValue, Timestamp, lenco, config = defaultConfig(), presignGet, now = Date.now, logger = console }) {
  const ts = (ms) => Timestamp.fromMillis(ms);
  const productRef = (id) => db.collection('products').doc(id);
  const orderRef = (id) => db.collection('orders').doc(id);
  const entRef = (uid, productId) => db.collection('entitlements').doc(`${uid}_${productId}`);
  const notifCol = (uid) => db.collection('users').doc(uid).collection('notifications');

  function notifyTx(tx, uid, { type, title, body, url }) {
    if (!uid) return;
    tx.set(notifCol(uid).doc(), {
      type, title, body, fromUid: null, fromName: 'IT’S DOABLE!', relatedType: null, relatedId: null,
      url: url || '#/my-adverts', isRead: false, createdAt: ts(now())
    });
  }

  async function loadListing(productId) {
    const snap = await productRef(productId).get();
    if (!snap.exists) throw new HttpError(404, 'NOT_FOUND', 'That advert no longer exists.');
    const [pv, mn] = await Promise.all([
      productRef(productId).collection('assets').doc('preview').get(),
      productRef(productId).collection('assets').doc('main').get()
    ]);
    return { product: snap.data(), assets: { preview: normalizeAssetDoc(pv.exists ? pv.data() : null), main: normalizeAssetDoc(mn.exists ? mn.data() : null) } };
  }

  // Automatic screening: there is no human review before publishing, so every advert is
  // checked by code both at checkout and again inside the payment transaction.
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function screenListing(p) {
    if (!config.blockedTerms.length) return [];
    const text = ` ${[p.title, p.description, p.offering, p.sellerName].filter(Boolean).join(' ').toLowerCase()} `;
    const hit = config.blockedTerms.find((term) => new RegExp(`(^|[^a-z0-9])${escRe(term)}([^a-z0-9]|$)`).test(text));
    return hit ? [{ field: 'text', message: 'Your advert contains wording that is not allowed under the advertising rules. Please reword it.' }] : [];
  }
  function listingErrors(product, assets, ids) {
    const r = validateListing(product, assets, ids);
    return { errors: [...r.errors, ...screenListing(product)], derived: r.derived };
  }
  function assertValid(product, assets, productId) {
    const { errors, derived } = listingErrors(product, assets, { ownerUid: product.builderId, productId });
    if (errors.length) throw new HttpError(422, 'LISTING_INVALID', 'Your advert needs a few fixes before it can be published.', errors);
    return derived;
  }

  const getTerms = () => config.termsVersion;
  const getPackages = () => config.adPackages.map((p) => ({ id: p.id, name: p.name, days: p.days, price: fromMinor(p.priceMinor), currency: p.currency }));

  const publicOrder = (id, o) => ({
    orderId: id, type: o.type, status: o.status, amount: fromMinor(o.amountMinor), currency: o.currency,
    reference: o.reference, productId: o.productId, refundStatus: o.refundStatus || 'none'
  });

  // ------------------------------------------------------------------ checkout
  async function findOpenOrder(where) {
    let q = db.collection('orders');
    Object.entries(where).forEach(([k, v]) => { q = q.where(k, '==', v); });
    const snap = await q.where('status', '==', 'awaiting_payment').limit(5).get();
    const cutoff = now() - config.orderTtlHours * 3600 * 1000;
    const hit = snap.docs.find((d) => (d.data().createdAt ? d.data().createdAt.toMillis() : 0) > cutoff);
    return hit || null;
  }

  async function startAdCheckout({ uid, productId, packageId, termsVersion = null }) {
    const pkg = config.adPackages.find((p) => p.id === packageId);
    if (!pkg) throw new HttpError(400, 'BAD_PACKAGE', 'Choose an advertising package.');
    const { product, assets } = await loadListing(productId);
    if (product.builderId !== uid) throw new HttpError(403, 'FORBIDDEN', 'You can only advertise your own listings.');
    const uSnap = await db.collection('users').doc(uid).get();
    if (!uSnap.exists || uSnap.data().role !== 'builder') throw new HttpError(403, 'BUILDERS_ONLY', 'Advertising is for Builders. Advertise from your My Market page.');

    let adKind;
    switch (product.status) {
      case 'draft': adKind = 'new'; break;
      case 'expired': adKind = 'renewal'; break;
      case 'active': {
        const remaining = (product.expiresAt ? product.expiresAt.toMillis() : 0) - now();
        if (remaining > config.renewWindowHours * 3600 * 1000) throw new HttpError(409, 'RENEW_TOO_EARLY', `You can renew in the last ${config.renewWindowHours} hours of your advert.`);
        adKind = 'extension'; break;
      }
      case 'rejected':
        if ((product.paidDaysPending || 0) > 0) throw new HttpError(409, 'USE_RESUBMIT', 'You already paid for this advert. Fix it and resubmit — no new payment needed.');
        adKind = 'new'; break;
      default: throw new HttpError(409, 'NOT_ALLOWED', 'This advert cannot be paid for.');
    }
    if (adKind !== 'extension') assertValid(product, assets, productId); // nothing that cannot be published automatically gets paid for

    const open = await findOpenOrder({ productId, uid, type: 'ad' });
    if (open && open.data().packageId === pkg.id) return { ...publicOrder(open.id, open.data()), packageName: pkg.name, days: pkg.days, reused: true };

    const ref = orderRef(); // auto id
    const t = now();
    const order = {
      type: 'ad', status: 'awaiting_payment', uid, sellerUid: uid, productId, packageId: pkg.id, adKind,
      days: pkg.days, amountMinor: pkg.priceMinor, currency: pkg.currency, reference: `IDT-AD-${ref.id}`,
      termsVersion, refundStatus: 'none', checks: 0, nextCheckAt: ts(t + 120 * 1000), createdAt: ts(t), updatedAt: ts(t)
    };
    await ref.set(order);
    return { ...publicOrder(ref.id, order), packageName: pkg.name, days: pkg.days, reused: false };
  }

  async function startPurchaseCheckout({ uid, productId, item, pass }) {
    if (!['preview', 'access', 'download'].includes(item)) throw new HttpError(400, 'BAD_ITEM', 'Unknown purchase option.');
    const snap = await productRef(productId).get();
    if (!snap.exists) throw new HttpError(404, 'NOT_FOUND', 'That advert no longer exists.');
    const p = snap.data();
    if (p.status !== 'active') throw new HttpError(409, 'NOT_FOR_SALE', 'This advert is not currently available.');
    if (p.builderId === uid) throw new HttpError(400, 'OWN_LISTING', 'You cannot buy your own listing.');

    let amountMinor;
    let passId = null;
    if (item === 'preview') {
      if (p.previewMode !== 'paid') throw new HttpError(400, 'NOT_PAID', 'This preview is not for sale.');
      amountMinor = toMinor(p.previewPrice);
    } else if (item === 'download') {
      if (p.downloadMode !== 'paid') throw new HttpError(400, 'NOT_PAID', 'This download is not for sale.');
      amountMinor = toMinor(p.downloadPrice);
    } else {
      if (p.accessMode !== 'paid') throw new HttpError(400, 'NOT_PAID', 'Access is not for sale.');
      passId = String(pass || '');
      const prices = p.passPrices || {};
      if (!(passId in PASS_SECONDS) && passId !== 'lifetime') throw new HttpError(400, 'BAD_PASS', 'Choose an access pass.');
      if (prices[passId] == null || prices[passId] === '') throw new HttpError(400, 'BAD_PASS', 'That pass is not offered.');
      amountMinor = toMinor(prices[passId]);
    }
    if (!amountMinor || amountMinor <= 0) throw new HttpError(409, 'BAD_PRICE', 'This option has no valid price.');

    const ent = await entRef(uid, productId).get();
    if (ent.exists) {
      const e = ent.data();
      if (item === 'preview' && e.preview) throw new HttpError(409, 'ALREADY_OWNED', 'You already have this preview.');
      if (item === 'download' && e.download) throw new HttpError(409, 'ALREADY_OWNED', 'You already bought the download.');
      if (item === 'access' && e.accessLifetime) throw new HttpError(409, 'ALREADY_OWNED', 'You already have lifetime access.');
    }

    const open = await findOpenOrder({ productId, uid, type: 'purchase' });
    if (open && open.data().item === item && (open.data().pass || null) === passId && open.data().amountMinor === amountMinor) return { ...publicOrder(open.id, open.data()), reused: true };

    const ref = orderRef();
    const t = now();
    const order = {
      type: 'purchase', status: 'awaiting_payment', uid, sellerUid: p.builderId, productId, item, pass: passId,
      amountMinor, currency: 'ZMW', reference: `IDT-PU-${ref.id}`, titleSnapshot: String(p.title || '').slice(0, 80),
      refundStatus: 'none', checks: 0, nextCheckAt: ts(t + 120 * 1000), createdAt: ts(t), updatedAt: ts(t)
    };
    await ref.set(order);
    return { ...publicOrder(ref.id, order), reused: false };
  }

  // ------------------------------------------------------------------ settlement
  // Called by: the browser after the widget closes, the Lenco webhook, and the
  // reconciliation sweep. All three are safe to run any number of times and
  // concurrently: money is applied inside ONE transaction that re-checks the
  // order, so a payment can never be applied twice.
  async function settleOrder(orderId) {
    const ref = orderRef(orderId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
    const o = snap.data();
    if (o.status === 'paid') return { status: 'paid', order: publicOrder(orderId, o) };

    let g;
    try { g = await lenco.getCollectionByReference(o.reference); }
    catch (err) {
      logger.warn && logger.warn('[market] gateway lookup failed', { orderId, message: err.message });
      return { status: o.status, gatewayUnavailable: true, order: publicOrder(orderId, o) };
    }

    if (g.status === 'pending') {
      const checks = (o.checks || 0) + 1;
      const backoff = Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** Math.min(checks, 5));
      await ref.update({ checks, nextCheckAt: ts(now() + backoff), updatedAt: ts(now()) });
      return { status: 'awaiting_payment', order: publicOrder(orderId, { ...o }) };
    }
    if (g.status === 'failed') {
      if (o.status === 'awaiting_payment') await ref.update({ status: 'failed', failureReason: String(g.reason || '').slice(0, 200), updatedAt: ts(now()) });
      return { status: 'failed', reason: g.reason || null, order: publicOrder(orderId, { ...o, status: 'failed' }) };
    }

    // successful: the amount and currency must match what WE asked for.
    if (parseGatewayAmount(g.amount) !== o.amountMinor || String(g.currency).toUpperCase() !== o.currency) {
      logger.error && logger.error('[market] PAYMENT AMOUNT MISMATCH', { orderId, expected: o.amountMinor, got: g.amount, currency: g.currency });
      await ref.update({ status: 'review_required', reviewNote: `Gateway reported ${g.amount} ${g.currency}`, updatedAt: ts(now()) });
      return { status: 'review_required', order: publicOrder(orderId, { ...o, status: 'review_required' }) };
    }

    const result = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      const cur = fresh.data();
      if (cur.status === 'paid') return { status: 'paid', already: true, cur };
      const t = now();
      const paidFields = {
        status: 'paid', paidAt: ts(t), appliedAt: ts(t), lencoReference: g.lencoReference || null,
        gatewayFeeMinor: g.fee == null ? null : parseGatewayAmount(g.fee), updatedAt: ts(t)
      };
      if (cur.type === 'ad') await applyAdOrderTx(tx, orderId, cur, paidFields, t);
      else await applyPurchaseOrderTx(tx, orderId, cur, paidFields, t);
      return { status: 'paid', already: false, cur: { ...cur, ...paidFields } };
    });
    return { status: 'paid', order: publicOrder(orderId, result.cur) };
  }

  async function applyAdOrderTx(tx, orderId, o, paidFields, t) {
    const pRef = productRef(o.productId);
    const pSnap = await tx.get(pRef);
    const orderUpdate = { ...paidFields };
    if (!pSnap.exists || pSnap.data().status === 'removed') {
      // Nothing left to advertise: the money goes straight into the refund queue.
      Object.assign(orderUpdate, { refundStatus: 'requested', refundNote: 'Advert no longer exists', refundRequestedAt: ts(t) });
      tx.update(orderRef(orderId), orderUpdate);
      notifyTx(tx, o.uid, { type: 'ad_refund', title: 'Refund queued', body: 'We received your advert payment but the advert no longer exists. A refund is on its way.' });
      return;
    }
    const p = pSnap.data();
    const days = o.days;
    const upd = { updatedAt: ts(t), lastOrderId: orderId };
    const rejectedWithBank = p.status === 'rejected' && (p.paidDaysPending || 0) > 0;
    if (p.status === 'active') {
      // Already live: payment simply buys more time.
      const base = Math.max(p.expiresAt ? p.expiresAt.toMillis() : t, t);
      upd.expiresAt = ts(base + days * DAY_MS);
      upd.renewalCount = (p.renewalCount || 0) + 1;
      notifyTx(tx, o.uid, { type: 'ad_renewed', title: 'Advert extended', body: `\u201C${p.title}\u201D now runs ${days} days longer.` });
    } else if (rejectedWithBank) {
      upd.paidDaysPending = (p.paidDaysPending || 0) + days; // banked until the advert passes the automatic check
      notifyTx(tx, o.uid, { type: 'ad_paid', title: 'Payment received', body: `\u201C${p.title}\u201D has extra days banked. Fix it and resubmit to go live.` });
    } else { // draft | expired | rejected-and-refunded
      // The owner could still edit a draft between checkout and payment, so the advert is
      // re-checked here, inside the same transaction that takes the money.
      const [pv, mn] = await Promise.all([
        tx.get(productRef(o.productId).collection('assets').doc('preview')),
        tx.get(productRef(o.productId).collection('assets').doc('main'))
      ]);
      const { errors, derived } = listingErrors(p, { preview: normalizeAssetDoc(pv.exists ? pv.data() : null), main: normalizeAssetDoc(mn.exists ? mn.data() : null) }, { ownerUid: p.builderId, productId: o.productId });
      const bank = (p.paidDaysPending || 0) + days;
      upd.submittedAt = ts(t);
      upd.resubmissionsLeft = config.resubmissions;
      upd.adOrderId = orderId;
      if (errors.length) {
        upd.paidDaysPending = bank;
        upd.status = 'rejected';
        upd.rejectionCode = 'auto_check';
        upd.rejectionReason = `Automatic check: ${errors.slice(0, 3).map((e) => e.message).join(' ')}`.slice(0, 500);
        notifyTx(tx, o.uid, { type: 'ad_rejected', title: 'Payment received \u2014 advert needs a fix', body: `\u201C${p.title}\u201D could not be published: ${upd.rejectionReason} Fix it and resubmit for free.` });
      } else {
        // Published immediately. The advertising period starts now.
        const expiresAt = ts(t + bank * DAY_MS);
        Object.assign(upd, {
          status: 'active', publishedAt: ts(t), expiresAt, paidDaysPending: 0, autoPublished: true,
          fromPrice: derived.fromPrice, searchTokens: derived.searchTokens,
          rejectionReason: FieldValue.delete(), rejectionCode: FieldValue.delete()
        });
        notifyTx(tx, o.uid, { type: 'ad_approved', title: 'Your advert is live', body: `\u201C${p.title}\u201D is now in the Market Square until ${expiresAt.toDate().toDateString()}.` });
      }
    }
    tx.update(pRef, upd);
    tx.update(orderRef(orderId), orderUpdate);
  }

  async function applyPurchaseOrderTx(tx, orderId, o, paidFields, t) {
    const eRef = entRef(o.uid, o.productId);
    const wRef = db.collection('wallets').doc(o.sellerUid);
    const lRef = db.collection('ledger').doc(orderId); // deterministic: can never double-credit
    const [eSnap, lSnap] = await Promise.all([tx.get(eRef), tx.get(lRef)]);
    const e = eSnap.exists ? eSnap.data() : {};
    const upd = { buyerUid: o.uid, sellerUid: o.sellerUid, productId: o.productId, updatedAt: ts(t) };
    if (o.item === 'preview') upd.preview = true;
    else if (o.item === 'download') upd.download = true;
    else if (o.pass === 'lifetime') { upd.accessLifetime = true; upd.accessUntil = null; }
    else {
      const base = Math.max(e.accessUntil ? e.accessUntil.toMillis() : 0, t);
      upd.accessUntil = ts(base + PASS_SECONDS[o.pass] * 1000);
    }
    if (!eSnap.exists) upd.createdAt = ts(t);
    tx.set(eRef, upd, { merge: true });

    if (!lSnap.exists) {
      const fee = Math.floor((o.amountMinor * config.platformFeePct) / 100);
      tx.set(lRef, { sellerUid: o.sellerUid, buyerUid: o.uid, orderId, productId: o.productId, item: o.item, pass: o.pass || null, grossMinor: o.amountMinor, feeMinor: fee, netMinor: o.amountMinor - fee, status: 'owed', createdAt: ts(t) });
      tx.set(wRef, { earnedGrossMinor: FieldValue.increment(o.amountMinor), earnedNetMinor: FieldValue.increment(o.amountMinor - fee), salesCount: FieldValue.increment(1), updatedAt: ts(t) }, { merge: true });
    }
    tx.update(orderRef(orderId), paidFields);
    notifyTx(tx, o.sellerUid, { type: 'sale', title: 'New sale', body: `Someone bought access to “${o.titleSnapshot || 'your advert'}”.`, url: '#/wallet' });
  }

  async function verifyOrder({ uid, orderId, isAdmin = false }) {
    const snap = await orderRef(orderId).get();
    if (!snap.exists) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
    if (snap.data().uid !== uid && !isAdmin) throw new HttpError(403, 'FORBIDDEN', 'Not your order.');
    return settleOrder(orderId);
  }

  // ------------------------------------------------------------------ moderation (after publishing)
  async function takedownAd({ adminUid, productId, reason }) {
    const text = String(reason || '').trim();
    if (text.length < 5 || text.length > 500) throw new HttpError(400, 'BAD_REASON', 'Give a clear reason (5-500 characters).');
    return db.runTransaction(async (tx) => {
      const ref = productRef(productId);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpError(404, 'NOT_FOUND', 'Advert not found.');
      const p = snap.data();
      if (p.status !== 'active') throw new HttpError(409, 'WRONG_STATE', 'Only live adverts can be taken down.');
      const t = now();
      tx.update(ref, { status: 'removed', rejectionReason: text, reviewedBy: adminUid, reviewedAt: ts(t), updatedAt: ts(t) });
      notifyTx(tx, p.builderId, { type: 'ad_removed', title: 'Advert removed', body: `“${p.title}” was removed for breaking the advertising rules: ${text}` });
      return { status: 'removed' };
    });
  }

  async function resubmitAd({ uid, productId }) {
    const { product, assets } = await loadListing(productId);
    if (product.builderId !== uid) throw new HttpError(403, 'FORBIDDEN', 'Not your advert.');
    if (product.status !== 'rejected') throw new HttpError(409, 'WRONG_STATE', 'Only adverts that failed the automatic check can be resubmitted.');
    if (!(product.paidDaysPending > 0)) throw new HttpError(409, 'NOT_PAID', 'This advert has no payment on it. Pay to advertise it again.');
    if (!(product.resubmissionsLeft > 0)) throw new HttpError(409, 'NO_RESUBMISSIONS', 'No free resubmissions left. You can ask for a refund instead.');
    const derived = assertValid(product, assets, productId);
    return db.runTransaction(async (tx) => {
      const ref = productRef(productId);
      const snap = await tx.get(ref);
      const p = snap.data();
      if (p.status !== 'rejected' || !(p.resubmissionsLeft > 0)) throw new HttpError(409, 'WRONG_STATE', 'This advert changed. Reload and try again.');
      const t = now();
      const expiresAt = ts(t + p.paidDaysPending * DAY_MS);
      tx.update(ref, {
        status: 'active', publishedAt: ts(t), expiresAt, paidDaysPending: 0, autoPublished: true,
        resubmissionsLeft: p.resubmissionsLeft - 1, submittedAt: ts(t), fromPrice: derived.fromPrice, searchTokens: derived.searchTokens,
        rejectionReason: FieldValue.delete(), rejectionCode: FieldValue.delete(), updatedAt: ts(t)
      });
      notifyTx(tx, p.builderId, { type: 'ad_approved', title: 'Your advert is live', body: `\u201C${p.title}\u201D is now in the Market Square until ${expiresAt.toDate().toDateString()}.` });
      return { status: 'active', expiresAt: expiresAt.toMillis() };
    });
  }

  // ------------------------------------------------------------------ refunds
  // Policy: only a REJECTED advert is refundable, in full. Lenco's public API
  // has no refund call we can rely on, so refunds are a tracked queue: the
  // advertiser asks, an admin pays it back from the Lenco dashboard and records
  // the reference here. Nothing is ever refunded silently.
  async function requestRefund({ uid, productId }) {
    const snap = await db.collection('orders').where('productId', '==', productId).where('uid', '==', uid).limit(25).get();
    const candidates = snap.docs
      .filter((d) => d.data().type === 'ad' && d.data().status === 'paid' && (d.data().refundStatus || 'none') === 'none')
      .sort((a, b) => b.data().paidAt.toMillis() - a.data().paidAt.toMillis());
    if (!candidates.length) throw new HttpError(404, 'NO_ORDER', 'There is no refundable payment for this advert.');
    const target = candidates[0];
    return db.runTransaction(async (tx) => {
      const pRef = productRef(productId);
      const [pSnap, oSnap] = await Promise.all([tx.get(pRef), tx.get(orderRef(target.id))]);
      const o = oSnap.data();
      if (o.refundStatus && o.refundStatus !== 'none') throw new HttpError(409, 'ALREADY_REQUESTED', 'A refund was already requested.');
      const p = pSnap.exists ? pSnap.data() : null;
      if (p && p.status !== 'rejected') throw new HttpError(409, 'NOT_REFUNDABLE', 'Only rejected adverts can be refunded.');
      if (p && !(p.paidDaysPending >= o.days)) throw new HttpError(409, 'NOT_REFUNDABLE', 'This payment is no longer refundable.');
      const t = now();
      tx.update(orderRef(target.id), { refundStatus: 'requested', refundRequestedAt: ts(t), updatedAt: ts(t) });
      if (p) tx.update(pRef, { paidDaysPending: p.paidDaysPending - o.days, updatedAt: ts(t) });
      notifyTx(tx, uid, { type: 'ad_refund', title: 'Refund requested', body: 'We have your refund request. It is processed within 7 business days.' });
      return { orderId: target.id, refundStatus: 'requested' };
    });
  }

  async function resolveRefund({ adminUid, orderId, outcome, ref, note }) {
    if (!['refunded', 'declined'].includes(outcome)) throw new HttpError(400, 'BAD_OUTCOME', 'Outcome must be refunded or declined.');
    const reference = String(ref || '').trim().slice(0, 100);
    const why = String(note || '').trim().slice(0, 300);
    if (outcome === 'refunded' && reference.length < 3) throw new HttpError(400, 'BAD_REF', 'Enter the payout reference from Lenco.');
    if (outcome === 'declined' && why.length < 5) throw new HttpError(400, 'BAD_NOTE', 'Say why the refund was declined.');
    return db.runTransaction(async (tx) => {
      const oRef = orderRef(orderId);
      const oSnap = await tx.get(oRef);
      if (!oSnap.exists) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
      const o = oSnap.data();
      if (o.refundStatus !== 'requested') throw new HttpError(409, 'WRONG_STATE', 'This refund is not waiting to be processed.');
      const pRef = productRef(o.productId);
      const pSnap = outcome === 'declined' ? await tx.get(pRef) : null;
      const t = now();
      tx.update(oRef, { refundStatus: outcome, refundRef: reference || null, refundNote: why || null, refundedBy: adminUid, refundedAt: ts(t), updatedAt: ts(t) });
      if (outcome === 'declined' && pSnap && pSnap.exists) tx.update(pRef, { paidDaysPending: (pSnap.data().paidDaysPending || 0) + o.days, updatedAt: ts(t) });
      notifyTx(tx, o.uid, outcome === 'refunded'
        ? { type: 'ad_refund', title: 'Refund sent', body: `K${fromMinor(o.amountMinor).toFixed(2)} has been refunded (ref ${reference}).` }
        : { type: 'ad_refund', title: 'Refund declined', body: why });
      return { refundStatus: outcome };
    });
  }

  // ------------------------------------------------------------------ gated media
  const accessActive = (e) => !!e && (e.accessLifetime === true || (e.accessUntil && e.accessUntil.toMillis() > now()));

  async function getAccessUrls({ uid, isAdmin, productId, intent }) {
    if (!['preview', 'stream', 'download'].includes(intent)) throw new HttpError(400, 'BAD_INTENT', 'Unknown request.');
    if (typeof presignGet !== 'function') throw new HttpError(503, 'NOT_CONFIGURED', 'Media signing is not configured.');
    const snap = await productRef(productId).get();
    if (!snap.exists) throw new HttpError(404, 'NOT_FOUND', 'That advert no longer exists.');
    const p = snap.data();
    const privileged = p.builderId === uid || isAdmin === true;

    if (!privileged) {
      if (p.status === 'removed') throw new HttpError(410, 'GONE', 'This advert has been removed.');
      const eSnap = await entRef(uid, productId).get();
      const e = eSnap.exists ? eSnap.data() : null;
      const live = p.status === 'active';
      let ok = false;
      if (intent === 'preview') ok = (live && p.previewMode === 'free') || (p.previewMode === 'paid' && (!!(e && e.preview) || accessActive(e)));
      else if (intent === 'stream') ok = (live && p.accessMode === 'free') || (p.accessMode === 'paid' && accessActive(e));
      else ok = (live && p.downloadMode === 'free') || (p.downloadMode === 'paid' && !!(e && e.download));
      if (!ok) throw new HttpError(402, 'LOCKED', 'Unlock this to continue.');
    }

    const kind = intent === 'preview' ? 'preview' : 'main';
    const aSnap = await productRef(productId).collection('assets').doc(kind).get();
    const files = normalizeAssetDoc(aSnap.exists ? aSnap.data() : null).files;
    if (!files.length) throw new HttpError(404, 'NO_FILES', 'There are no files here yet.');
    const ttl = intent === 'download' ? config.downloadTtlSeconds : config.streamTtlSeconds;
    const out = [];
    for (const f of files) {
      if (!isValidGatedKey(f.key, p.builderId, productId, kind)) continue; // never sign a key that is not the owner's own
      out.push({ name: String(f.name || 'file').slice(0, 120), type: f.type || '', url: await presignGet(f.key, { expiresIn: ttl, download: intent === 'download', fileName: f.name }) });
    }
    if (!out.length) throw new HttpError(404, 'NO_FILES', 'There are no files here yet.');
    return { files: out, expiresInSeconds: ttl };
  }

  // ------------------------------------------------------------------ background jobs
  async function tryAcquireLease(name, ttlMs, holder) {
    const ref = db.collection('system').doc(`lease_${name}`);
    return db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const t = now();
      if (s.exists && s.data().holder !== holder && s.data().until && s.data().until.toMillis() > t) return false;
      tx.set(ref, { holder, until: ts(t + ttlMs) });
      return true;
    });
  }

  async function mapLimit(items, n, fn) {
    const results = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const idx = i++; try { results[idx] = await fn(items[idx]); } catch (e) { results[idx] = { error: e }; } }
    }));
    return results;
  }

  /** Flips live adverts whose time is up to 'expired'. Safe to run on several instances at once. */
  async function sweepExpired({ limit = 400 } = {}) {
    const snap = await db.collection('products').where('status', '==', 'active').where('expiresAt', '<=', ts(now())).orderBy('expiresAt', 'asc').limit(limit).get();
    let expired = 0;
    await mapLimit(snap.docs, 10, async (d) => {
      const done = await db.runTransaction(async (tx) => {
        const s = await tx.get(d.ref);
        const p = s.data();
        // re-check inside the transaction: a renewal may have just extended it
        if (!p || p.status !== 'active' || !p.expiresAt || p.expiresAt.toMillis() > now()) return false;
        tx.update(d.ref, { status: 'expired', updatedAt: ts(now()) });
        notifyTx(tx, p.builderId, { type: 'ad_expired', title: 'Your advert has ended', body: `“${p.title}” has finished its run. Renew it to put it back in the Market Square.` });
        return true;
      });
      if (done) expired++;
    });
    return { scanned: snap.size, expired, more: snap.size === limit };
  }

  /** Re-checks unpaid checkouts with Lenco (webhooks can be missed) and cancels abandoned ones. */
  async function reconcilePending({ limit = 100 } = {}) {
    const snap = await db.collection('orders').where('status', '==', 'awaiting_payment').where('nextCheckAt', '<=', ts(now())).orderBy('nextCheckAt', 'asc').limit(limit).get();
    const cutoff = now() - config.orderTtlHours * 3600 * 1000;
    let settled = 0; let cancelled = 0;
    await mapLimit(snap.docs, 5, async (d) => {
      const o = d.data();
      const r = await settleOrder(d.id);
      if (r.status === 'paid') { settled++; return; }
      if (r.status === 'awaiting_payment' && o.createdAt.toMillis() < cutoff) {
        await d.ref.update({ status: 'cancelled', updatedAt: ts(now()) });
        cancelled++;
      }
    });
    return { scanned: snap.size, settled, cancelled };
  }

  return {
    getPackages, getTerms, startAdCheckout, startPurchaseCheckout, settleOrder, verifyOrder,
    takedownAd, resubmitAd, requestRefund, resolveRefund,
    getAccessUrls, sweepExpired, reconcilePending, tryAcquireLease, config
  };
}

module.exports = { createMarketService, defaultConfig };
