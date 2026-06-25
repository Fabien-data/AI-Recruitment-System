/**
 * Campaign Runner
 * ===============
 * Paced, resumable worker that delivers a bulk WhatsApp template blast
 * (the "campaigns" / "campaign_recipients" tables, migrations 063/064).
 *
 * Design goals:
 *  - Idempotent & resumable: only `pending` recipients are sent; a UNIQUE
 *    (campaign_id, candidate_id) row + the status guard mean a re-run (after a
 *    deploy/crash) never double-sends. The sweeper re-kicks `sending` campaigns
 *    on startup, so an interrupted blast continues where it left off.
 *  - Meta-safe pacing: a per-rolling-day cap (`campaigns.daily_cap`) bounds how
 *    many business-initiated templates go out per day; when hit, the campaign
 *    stops for the day and the sweeper resumes it once the Colombo date rolls.
 *    A small inter-send throttle protects the number's quality rating.
 *  - Auto-pause on sustained infra failure (rate_limited / token_expired) so a
 *    broken token or a Meta throttle doesn't burn the whole recipient list.
 *
 * Single-instance assumption: the backend runs one Cloud Run instance (see the
 * socketio-single-instance decision), so an in-process guard + interval sweeper
 * is sufficient — no external queue/lock needed.
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');
const chatbotNotifier = require('./chatbotNotifier');

const THROTTLE_MS = 150;            // pause between sends (rate-limit / quality safety)
const BATCH = 25;                   // recipients pulled per loop iteration
const AUTOPAUSE_CONSECUTIVE = 25;   // consecutive infra failures → auto-pause
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // re-kick stuck/next-day campaigns every 10 min
const MAX_ATTEMPTS = 3;             // transient failures auto-retry up to this many sends

const running = new Set();          // campaign ids currently being processed (in-proc guard)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Current Asia/Colombo calendar date as 'YYYY-MM-DD' (cap windows are local). */
async function colomboToday() {
    const r = await query(`SELECT (NOW() AT TIME ZONE 'Asia/Colombo')::date::text AS d`, []);
    return r.rows[0].d;
}

/** Recompute the campaign rollup counters + failure breakdown from the ledger. */
async function rollup(campaignId) {
    try {
        const c = await query(adaptQuery(`
            SELECT COUNT(*)::int AS total,
                   SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END)::int AS sent,
                   SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END)::int AS failed,
                   SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END)::int AS skipped
            FROM campaign_recipients WHERE campaign_id = $1
        `), [campaignId]);
        const row = c.rows[0] || {};
        const reasons = await query(adaptQuery(`
            SELECT COALESCE(reason, 'other') AS reason, COUNT(*)::int AS n
            FROM campaign_recipients WHERE campaign_id = $1 AND status = 'failed'
            GROUP BY COALESCE(reason, 'other')
        `), [campaignId]);
        const summary = { no_whatsapp: 0, token_expired: 0, rate_limited: 0, other: 0 };
        for (const r of reasons.rows) {
            const key = ['no_whatsapp', 'token_expired', 'rate_limited'].includes(r.reason) ? r.reason : 'other';
            summary[key] += Number(r.n) || 0;
        }
        await query(adaptQuery(`
            UPDATE campaigns
            SET total = $1, sent = $2, failed = $3, skipped = $4,
                delivery_summary = $5, updated_at = NOW()
            WHERE id = $6
        `), [row.total || 0, row.sent || 0, row.failed || 0, row.skipped || 0, JSON.stringify(summary), campaignId]);
    } catch (err) {
        logger.warn(`campaignRunner.rollup ${campaignId} failed: ${err.message}`);
    }
}

/**
 * Drive one campaign until it runs dry, hits its daily cap, gets paused, or
 * auto-pauses. Guarded so only one driver per campaign runs at a time.
 */
async function processCampaign(campaignId) {
    if (running.has(campaignId)) return;
    running.add(campaignId);
    try {
        // Outer loop: each pass pulls and sends a batch; exits on cap / dry / not-sending.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const cRes = await query(adaptQuery('SELECT * FROM campaigns WHERE id = $1'), [campaignId]);
            const camp = cRes.rows[0];
            if (!camp || camp.status !== 'sending') break;

            // Reset the daily counter when the Colombo date rolls over.
            const today = await colomboToday();
            const sendDay = camp.send_day ? String(camp.send_day).slice(0, 10) : null;
            let sentToday = camp.sent_today || 0;
            if (sendDay !== today) {
                sentToday = 0;
                await query(adaptQuery('UPDATE campaigns SET send_day = $1, sent_today = 0 WHERE id = $2'), [today, campaignId]);
            }

            const cap = Number(camp.daily_cap) || 0;
            if (cap > 0 && sentToday >= cap) {
                logger.info(`campaign ${campaignId}: daily cap ${cap} reached (${sentToday}); will resume next day`);
                break;
            }

            const remaining = cap > 0 ? Math.max(0, cap - sentToday) : BATCH;
            const limit = Math.max(1, Math.min(BATCH, remaining));
            const rRes = await query(adaptQuery(`
                SELECT id, candidate_id, phone FROM campaign_recipients
                WHERE campaign_id = $1 AND status = 'pending'
                ORDER BY created_at ASC LIMIT ${limit}
            `), [campaignId]);

            if (rRes.rows.length === 0) {
                // Before finishing, auto-retry transient failures (rate_limited /
                // token_expired / other) under the per-recipient attempt cap — the
                // "every message attempted" guarantee. attempts increments on each
                // send, so this converges (no infinite loop). Permanent reasons
                // (no_whatsapp / no_phone) are never re-queued.
                const rq = await query(adaptQuery(`
                    UPDATE campaign_recipients SET status = 'pending', reason = NULL
                    WHERE campaign_id = $1 AND status = 'failed'
                      AND COALESCE(reason,'other') IN ('rate_limited','token_expired','other')
                      AND attempts < ${MAX_ATTEMPTS}
                `), [campaignId]);
                if (Number(rq.rowCount || 0) > 0) {
                    logger.info(`campaign ${campaignId}: re-queued ${rq.rowCount} transient failures for retry`);
                    await rollup(campaignId);
                    await sleep(2000); // brief backoff before the retry pass
                    continue;          // loop again to drain the re-queued rows
                }
                await query(adaptQuery(
                    "UPDATE campaigns SET status = 'done', updated_at = NOW() WHERE id = $1 AND status = 'sending'"
                ), [campaignId]);
                await rollup(campaignId);
                logger.info(`campaign ${campaignId}: complete (no pending recipients left)`);
                break;
            }

            let consecFail = 0;
            for (const rec of rRes.rows) {
                if (!rec.phone) {
                    await query(adaptQuery(
                        "UPDATE campaign_recipients SET status = 'skipped', reason = 'no_phone', attempts = attempts + 1 WHERE id = $1"
                    ), [rec.id]);
                    continue;
                }
                const sendRes = await chatbotNotifier.sendCampaignTemplate({
                    phone: rec.phone,
                    templateName: camp.template_name,
                    language: camp.language || 'en',
                });
                if (sendRes.ok) {
                    await query(adaptQuery(`
                        UPDATE campaign_recipients
                        SET status = 'sent', whatsapp_message_id = $1, attempts = attempts + 1,
                            sent_at = NOW(), reason = NULL
                        WHERE id = $2
                    `), [sendRes.messageId || null, rec.id]);
                    sentToday += 1;
                    consecFail = 0;
                    await query(adaptQuery('UPDATE campaigns SET sent_today = sent_today + 1 WHERE id = $1'), [campaignId]);
                } else {
                    const reason = sendRes.reason || 'other';
                    await query(adaptQuery(
                        "UPDATE campaign_recipients SET status = 'failed', reason = $1, attempts = attempts + 1 WHERE id = $2"
                    ), [reason, rec.id]);
                    consecFail = (reason === 'rate_limited' || reason === 'token_expired') ? consecFail + 1 : 0;
                }

                await sleep(THROTTLE_MS);

                if (consecFail >= AUTOPAUSE_CONSECUTIVE) {
                    await query(adaptQuery(
                        "UPDATE campaigns SET status = 'paused', last_error = $1, updated_at = NOW() WHERE id = $2"
                    ), [`auto-paused after ${consecFail} consecutive infra failures (rate_limited/token_expired)`, campaignId]);
                    logger.warn(`campaign ${campaignId}: auto-paused after ${consecFail} consecutive infra failures`);
                    await rollup(campaignId);
                    return;
                }
                if (cap > 0 && sentToday >= cap) break;
            }
            await rollup(campaignId);
        }
    } catch (err) {
        logger.error(`campaignRunner ${campaignId} crashed: ${err.message}`);
        await query(adaptQuery('UPDATE campaigns SET last_error = $1, updated_at = NOW() WHERE id = $2'),
            [String(err.message || err).slice(0, 500), campaignId]).catch(() => {});
    } finally {
        running.delete(campaignId);
    }
}

/** Fire-and-forget kick (used by the create/resume routes). */
function kickCampaign(campaignId) {
    processCampaign(campaignId).catch((e) => logger.error(`kickCampaign ${campaignId}: ${e.message}`));
}

/**
 * Periodic sweeper: resume any `sending` campaign that still has pending
 * recipients (covers next-day cap rollover and crash/deploy recovery).
 */
function startCampaignSweeper() {
    const sweep = async () => {
        try {
            const res = await query(adaptQuery(`
                SELECT c.id FROM campaigns c
                WHERE c.status = 'sending'
                  AND EXISTS (SELECT 1 FROM campaign_recipients r
                              WHERE r.campaign_id = c.id AND r.status = 'pending')
            `), []);
            for (const row of res.rows) {
                if (!running.has(row.id)) kickCampaign(row.id);
            }
        } catch (err) {
            logger.warn(`campaign sweeper failed: ${err.message}`);
        }
    };
    // First sweep shortly after boot (resume interrupted blasts), then on interval.
    setTimeout(sweep, 15 * 1000);
    setInterval(sweep, SWEEP_INTERVAL_MS).unref?.();
}

module.exports = { processCampaign, kickCampaign, startCampaignSweeper, rollup };
