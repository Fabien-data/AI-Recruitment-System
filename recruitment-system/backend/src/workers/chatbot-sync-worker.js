/**
 * Chatbot Sync Worker
 * ===================
 * Drives the chatbot_sync_outbox: drains pending rows on a short interval and
 * reconciles drifted entities on a longer one.
 *
 * Started from server.js after applyMigrations() completes, behind the
 * CHATBOT_SYNC_WORKER_ENABLED env flag (default: true).
 */

const { drainOnce, reconcile } = require('../services/chatbot-outbox');
const logger = require('../utils/logger');

const DRAIN_INTERVAL_MS     = parseInt(process.env.CHATBOT_SYNC_DRAIN_INTERVAL_MS, 10)     || 5000;
const RECONCILE_INTERVAL_MS = parseInt(process.env.CHATBOT_SYNC_RECONCILE_INTERVAL_MS, 10) || 600000;

let drainTimer = null;
let reconcileTimer = null;
let draining = false;
let reconciling = false;

async function _drainTick() {
    if (draining) return;
    draining = true;
    try {
        const stats = await drainOnce({ batchSize: 25 });
        if (stats.drained > 0) {
            logger.info(`chatbot-sync-worker: drained=${stats.drained} sent=${stats.sent} failed=${stats.failed}`);
        }
    } catch (err) {
        logger.error(`chatbot-sync-worker drain error: ${err.message}`);
    } finally {
        draining = false;
    }
}

async function _reconcileTick() {
    if (reconciling) return;
    reconciling = true;
    try {
        await reconcile();
    } catch (err) {
        logger.error(`chatbot-sync-worker reconcile error: ${err.message}`);
    } finally {
        reconciling = false;
    }
}

function start() {
    if (process.env.CHATBOT_SYNC_WORKER_ENABLED === 'false') {
        logger.info('chatbot-sync-worker: disabled via CHATBOT_SYNC_WORKER_ENABLED=false');
        return;
    }
    if (drainTimer || reconcileTimer) {
        logger.warn('chatbot-sync-worker: already started');
        return;
    }
    logger.info(`chatbot-sync-worker: starting (drain=${DRAIN_INTERVAL_MS}ms, reconcile=${RECONCILE_INTERVAL_MS}ms)`);
    // Kick once shortly after startup so any missed pushes catch up quickly.
    setTimeout(_drainTick, 2000);
    drainTimer     = setInterval(_drainTick, DRAIN_INTERVAL_MS);
    reconcileTimer = setInterval(_reconcileTick, RECONCILE_INTERVAL_MS);
}

function stop() {
    if (drainTimer)     { clearInterval(drainTimer);     drainTimer     = null; }
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
    logger.info('chatbot-sync-worker: stopped');
}

module.exports = { start, stop };
