'use strict';
const crypto = require('node:crypto');

/**
 * Background work: expire finished adverts, re-check unpaid checkouts.
 * Several Render instances can run this; a short Firestore lease makes sure
 * only one does each pass (and everything inside is idempotent anyway).
 */
function startJobs({ service, intervalMs = 60000, logger = console }) {
  const holder = crypto.randomBytes(8).toString('hex');
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      if (!(await service.tryAcquireLease('market-jobs', Math.max(intervalMs - 5000, 5000), holder))) return;
      for (let page = 0; page < 5; page++) { // drain a backlog, but never loop forever
        const r = await service.sweepExpired({ limit: 400 });
        if (r.expired) logger.info && logger.info(`[market] expired ${r.expired} adverts`);
        if (!r.more) break;
      }
      const rec = await service.reconcilePending({ limit: 100 });
      if (rec.settled || rec.cancelled) logger.info && logger.info(`[market] reconcile: settled ${rec.settled}, cancelled ${rec.cancelled}`);
    } catch (err) {
      logger.error && logger.error('[market] job tick failed', { message: err.message });
    } finally { running = false; }
  }

  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  tick();
  return { stop() { stopped = true; clearInterval(timer); }, tick };
}

module.exports = { startJobs };
