'use strict';
const express = require('express');
const { HttpError } = require('./errors');
const { CATALOG } = require('./catalog');

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** Fixed-window limiter, per instance. Put Cloudflare/Render IP limits in front for the rest. */
function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (v.reset <= t) hits.delete(k); }, windowMs);
  if (timer.unref) timer.unref();
  return (key) => {
    const t = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= t) { h = { n: 0, reset: t + windowMs }; hits.set(key, h); }
    h.n++;
    if (hits.size > 200000) hits.clear(); // hard memory ceiling
    return h.n <= max;
  };
}

function createRouter({ service, lenco, auth, env = {}, logger = console }) {
  const router = express.Router();
  const json = express.json({ limit: '16kb' });
  const rl = {
    checkout: createLimiter({ windowMs: 10 * 60 * 1000, max: 30 }),
    verify: createLimiter({ windowMs: 10 * 60 * 1000, max: 90 }),
    access: createLimiter({ windowMs: 10 * 60 * 1000, max: 240 }),
    admin: createLimiter({ windowMs: 10 * 60 * 1000, max: 1200 }),
    hook: createLimiter({ windowMs: 60 * 1000, max: 600 })
  };
  const gateway = {
    publicKey: env.LENCO_PUBLIC_KEY || '',
    scriptUrl: (env.LENCO_ENV || 'live') === 'sandbox' ? 'https://pay.sandbox.lenco.co/js/v1/inline.js' : 'https://pay.lenco.co/js/v1/inline.js'
  };

  router.use((req, res, next) => (req.path.startsWith('/webhooks/') ? next() : json(req, res, next)));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  const authed = wrap(async (req, res, next) => {
    const h = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw new HttpError(401, 'NO_TOKEN', 'Please sign in again.');
    let decoded;
    try { decoded = await auth.verifyIdToken(m[1]); } catch (e) { throw new HttpError(401, 'BAD_TOKEN', 'Your session expired. Please sign in again.'); }
    req.user = { uid: decoded.uid, email: decoded.email || null, admin: decoded.admin === true };
    next();
  });
  const adminOnly = (req, res, next) => (req.user && req.user.admin ? next() : next(new HttpError(403, 'FORBIDDEN', 'Admins only.')));
  const limited = (name) => (req, res, next) => (rl[name](req.user ? req.user.uid : req.ip) ? next() : next(new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.')));
  const id = (v, what = 'id') => { if (!ID_RE.test(String(v || ''))) throw new HttpError(400, 'BAD_ID', `Invalid ${what}.`); return String(v); };

  router.get('/health', (req, res) => res.json({ ok: true }));
  router.get('/catalog', (req, res) => { res.set('Cache-Control', 'public, max-age=300'); res.json(CATALOG); });
  router.get('/packages', (req, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json({ packages: service.getPackages(), termsVersion: service.getTerms() }); });

  // ---- advertising
  router.post('/ads/checkout', authed, limited('checkout'), wrap(async (req, res) => {
    if (String(req.body.termsVersion || '') !== service.getTerms()) throw new HttpError(400, 'TERMS', 'Please accept the Advertising Rules and Refund Policy to continue.');
    const order = await service.startAdCheckout({ uid: req.user.uid, productId: id(req.body.productId, 'advert'), packageId: String(req.body.packageId || ''), termsVersion: service.getTerms() });
    res.json({ order, gateway });
  }));
  router.post('/ads/:productId/resubmit', authed, limited('checkout'), wrap(async (req, res) => {
    res.json(await service.resubmitAd({ uid: req.user.uid, productId: id(req.params.productId, 'advert') }));
  }));
  router.post('/ads/:productId/request-refund', authed, limited('checkout'), wrap(async (req, res) => {
    res.json(await service.requestRefund({ uid: req.user.uid, productId: id(req.params.productId, 'advert') }));
  }));

  // ---- buyer purchases
  router.post('/purchases/checkout', authed, limited('checkout'), wrap(async (req, res) => {
    const order = await service.startPurchaseCheckout({ uid: req.user.uid, productId: id(req.body.productId, 'advert'), item: String(req.body.item || ''), pass: req.body.pass == null ? null : String(req.body.pass) });
    res.json({ order, gateway });
  }));

  router.post('/orders/:orderId/verify', authed, limited('verify'), wrap(async (req, res) => {
    const r = await service.verifyOrder({ uid: req.user.uid, orderId: id(req.params.orderId, 'order'), isAdmin: req.user.admin });
    res.json({ status: r.status, order: r.order, gatewayUnavailable: !!r.gatewayUnavailable, reason: r.reason || null });
  }));

  router.post('/access-url', authed, limited('access'), wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await service.getAccessUrls({ uid: req.user.uid, isAdmin: req.user.admin, productId: id(req.body.productId, 'advert'), intent: String(req.body.intent || '') }));
  }));

  // ---- admin
  router.post('/admin/ads/:productId/takedown', authed, adminOnly, limited('admin'), wrap(async (req, res) => {
    res.json(await service.takedownAd({ adminUid: req.user.uid, productId: id(req.params.productId, 'advert'), reason: req.body.reason }));
  }));
  router.post('/admin/orders/:orderId/refund', authed, adminOnly, limited('admin'), wrap(async (req, res) => {
    res.json(await service.resolveRefund({ adminUid: req.user.uid, orderId: id(req.params.orderId, 'order'), outcome: req.body.outcome, ref: req.body.ref, note: req.body.note }));
  }));

  // ---- Lenco webhook
  // The signature is checked against the RAW body. Even after it passes, the
  // payment is re-confirmed with Lenco's API before anything is applied, so a
  // forged or replayed event can never grant anything.
  router.post('/webhooks/lenco', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
    if (!rl.hook(req.ip)) return res.status(429).end();
    let raw = Buffer.isBuffer(req.body) ? req.body : (req.rawBody || null);
    if (!raw && req.body && typeof req.body === 'object') raw = JSON.stringify(req.body); // host parsed JSON first (less robust; see README)
    if (!raw || !lenco.verifyWebhookSignature(raw, req.get('X-Lenco-Signature'))) {
      logger.warn && logger.warn('[market] webhook rejected: bad signature');
      return res.status(401).json({ error: 'bad signature' });
    }
    let event;
    try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw); } catch (e) { return res.status(400).json({ error: 'bad json' }); }
    res.status(200).json({ received: true }); // acknowledge fast; Lenco retries anything but 200/201/202
    const ref = event && event.data && event.data.reference;
    const m = /^IDT-(?:AD|PU)-([A-Za-z0-9_-]{6,64})$/.exec(String(ref || ''));
    if (!m || !/^collection\./.test(String(event.event || ''))) return;
    service.settleOrder(m[1]).catch((err) => logger.error && logger.error('[market] webhook settle failed', { ref, message: err.message }));
  });

  // ---- errors
  router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details || undefined });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.', code: 'BAD_JSON' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.', code: 'TOO_LARGE' });
    logger.error && logger.error('[market] unhandled error', { path: req.path, message: err && err.message, stack: err && err.stack });
    return res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' });
  });

  return router;
}

module.exports = { createRouter, createLimiter };
