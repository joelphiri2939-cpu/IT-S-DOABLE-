'use strict';
const crypto = require('node:crypto');

class GatewayError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal Lenco client: collection status lookup + webhook signature check.
 * (Docs: https://lenco-api.readme.io/v2.0/reference/get-collection-by-reference
 *        https://lenco-api.readme.io/v2.0/reference/webhooks)
 *
 * The browser never calls Lenco's API; it only opens the Lenco Pay widget.
 * Every payment is confirmed HERE, server-to-server, using the secret key.
 */
function createLencoClient({ secretKey, baseUrl = 'https://api.lenco.co/access/v2', fetchImpl = globalThis.fetch, timeoutMs = 10000, retries = 2, logger = console } = {}) {
  if (!secretKey) throw new Error('LENCO_SECRET_KEY is required');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required (Node 18+).');

  // Lenco: "webhook_hash_key is a SHA256 hash of your API token"
  const webhookKey = crypto.createHash('sha256').update(secretKey).digest('hex');

  async function request(path) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}${path}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${secretKey}`, Accept: 'application/json' },
          signal: ctrl.signal
        });
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error page */ }
        if (res.status === 404) return { notFound: true, body };
        if (res.status >= 500 || res.status === 429) { lastErr = new GatewayError(`Lenco responded ${res.status}`, { status: res.status, retryable: true }); }
        else if (!res.ok) throw new GatewayError((body && body.message) || `Lenco responded ${res.status}`, { status: res.status, retryable: false });
        else return { body };
      } catch (err) {
        if (err instanceof GatewayError && !err.retryable) throw err;
        lastErr = err instanceof GatewayError ? err : new GatewayError(err.name === 'AbortError' ? 'Lenco request timed out' : `Lenco request failed: ${err.message}`, { retryable: true });
      } finally { clearTimeout(timer); }
      if (attempt < retries) await sleep(300 * 2 ** attempt);
    }
    throw lastErr;
  }

  /**
   * Returns { found, status: 'successful'|'failed'|'pending', amount (string), currency, lencoReference, fee, reason }.
   * 'pay-offline' / '3ds-auth-required' / 'pending' are all "not finished yet".
   */
  async function getCollectionByReference(reference) {
    if (!/^[A-Za-z0-9._-]{6,100}$/.test(String(reference))) throw new GatewayError('Invalid payment reference');
    const r = await request(`/collections/status/${encodeURIComponent(reference)}`);
    if (r.notFound) return { found: false, status: 'pending' };
    const data = r.body && r.body.data;
    if (!r.body || r.body.status !== true || !data) throw new GatewayError('Unexpected response from Lenco', { retryable: true });
    const status = data.status === 'successful' ? 'successful' : (data.status === 'failed' ? 'failed' : 'pending');
    return {
      found: true, status,
      rawStatus: data.status,
      reference: data.reference || null,
      amount: data.amount, currency: data.currency,
      lencoReference: data.lencoReference || null,
      fee: data.fee == null ? null : data.fee,
      reason: data.reasonForFailure || null
    };
  }

  /** HMAC-SHA512 of the raw request body, compared in constant time. */
  function verifyWebhookSignature(rawBody, signatureHeader) {
    if (!signatureHeader || (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody))) return false;
    const expected = crypto.createHmac('sha512', webhookKey).update(rawBody).digest();
    let given;
    try { given = Buffer.from(String(signatureHeader).trim(), 'hex'); } catch (e) { return false; }
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected);
  }

  return { getCollectionByReference, verifyWebhookSignature, _webhookKey: webhookKey };
}

module.exports = { createLencoClient, GatewayError };
