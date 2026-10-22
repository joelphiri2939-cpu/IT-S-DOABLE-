'use strict';
const { createLencoClient } = require('./lenco');
const { createMarketService, defaultConfig } = require('./service');
const { createRouter } = require('./router');
const { startJobs } = require('./jobs');
const { CATALOG } = require('./catalog');

/**
 * Wire the Market Square backend into your existing Express server.
 *
 *   const app0 = initializeApp({ credential: cert(serviceAccountJson) });   // from 'firebase-admin/app'
 *   const market = createMarket({ app: app0, presignGet });
 *   app.use('/api/market', market.router);   // BEFORE any global express.json()
 *   market.startJobs();
 *
 * `app`        the initialised firebase-admin app (works with firebase-admin 11 to 14+)
 * `presignGet` async (key, { expiresIn, download, fileName }) => signed GET url (your existing R2 helper)
 */
function createMarket({ app, presignGet, env = process.env, logger = console, fetchImpl }) {
  if (!app) throw new Error('createMarket: the initialised firebase-admin app is required');
  const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
  const { getAuth } = require('firebase-admin/auth');
  const lenco = createLencoClient({
    secretKey: env.LENCO_SECRET_KEY,
    baseUrl: env.LENCO_API_BASE || 'https://api.lenco.co/access/v2',
    fetchImpl: fetchImpl || globalThis.fetch,
    logger
  });
  const service = createMarketService({
    db: getFirestore(app), FieldValue, Timestamp,
    lenco, config: defaultConfig(env), presignGet, logger
  });
  const router = createRouter({ service, lenco, auth: getAuth(app), env, logger });
  return { router, service, lenco, startJobs: (opts = {}) => startJobs({ service, logger, ...opts }) };
}

module.exports = { createMarket, CATALOG };
