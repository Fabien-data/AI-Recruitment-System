/**
 * WhatsApp reachability bookkeeping
 * =================================
 * Update a candidate's WhatsApp reachability flag from a notification send result.
 * A confirmed WhatsApp delivery clears the flag; a genuine "not a WhatsApp user"
 * (reason='no_whatsapp') sets it (so the candidate sinks to the bottom of lists
 * and lands in the no-WhatsApp call-list CSV). Transient reasons (out_of_window /
 * rate_limited / queued) leave the flag untouched.
 *
 * Defensive: any error (e.g. a missing column on a not-yet-migrated DB) is
 * swallowed so a send/import never fails on bookkeeping. Shared by the interview
 * bulk-send path (routes/interviews.js) and the bulk-import welcome pass
 * (services/bulk-import-service.js) so the flag is set identically everywhere.
 */
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('./logger');

async function applyWhatsappReachability(candidateId, notification) {
    if (!candidateId || !notification) return;
    try {
        const okWhatsapp = (notification.success || []).some((s) => s.channel === 'whatsapp');
        const noWhatsapp = (notification.failed || []).find((f) => f.channel === 'whatsapp' && f.reason === 'no_whatsapp');
        if (okWhatsapp) {
            await query(
                adaptQuery('UPDATE candidates SET whatsapp_unreachable = FALSE, whatsapp_last_error = NULL, whatsapp_checked_at = NOW() WHERE id = $1'),
                [candidateId]
            );
        } else if (noWhatsapp) {
            await query(
                adaptQuery('UPDATE candidates SET whatsapp_unreachable = TRUE, whatsapp_last_error = $2, whatsapp_checked_at = NOW() WHERE id = $1'),
                [candidateId, String(noWhatsapp.error || 'Not a WhatsApp number').slice(0, 500)]
            );
        }
    } catch (err) {
        logger.debug(`whatsapp reachability update skipped for ${candidateId}: ${err.message}`);
    }
}

module.exports = { applyWhatsappReachability };
