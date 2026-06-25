/**
 * Claim sessions
 * ==============
 * Audit trail for chat claims (migration 041). candidates.claimed_by/claimed_at
 * remain the live "who holds it" source of truth; claim_sessions records every
 * claim WINDOW so engagement stats can attribute calls/messages to the agent who
 * actually held the chat. Write paths stamp the open session id onto call_logs /
 * communications rows at INSERT time (migration 042).
 *
 * Best-effort like activity-log.js: a failure here must never break the
 * claim/send/log action itself — the stamp is just lost (row counts for no one).
 */
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');

/**
 * Open a claim session for an agent, closing whoever held it before
 * (release_reason 'reassigned' — claim transfer is allowed and recorded).
 * Returns the new session id, or null on failure.
 */
async function openClaimSession(candidateId, agentId, { releasedBy = agentId, reason = 'reassigned' } = {}) {
    if (!candidateId || !agentId) return null;
    const close = () => query(
        adaptQuery(`UPDATE claim_sessions
                    SET released_at = NOW(), released_by = $1, release_reason = $2
                    WHERE candidate_id = $3 AND released_at IS NULL`),
        [releasedBy, reason, candidateId]
    );
    try {
        await close();
        const ins = await query(
            adaptQuery(`INSERT INTO claim_sessions (candidate_id, agent_id) VALUES ($1, $2) RETURNING id`),
            [candidateId, agentId]
        );
        return ins.rows[0]?.id || null;
    } catch (err) {
        // uq_claim_sessions_open race: someone opened a session between our
        // close and insert — close again and retry once.
        try {
            await close();
            const ins = await query(
                adaptQuery(`INSERT INTO claim_sessions (candidate_id, agent_id) VALUES ($1, $2) RETURNING id`),
                [candidateId, agentId]
            );
            return ins.rows[0]?.id || null;
        } catch (err2) {
            logger.warn(`claim-sessions: could not open session for ${candidateId}: ${err2.message}`);
            return null;
        }
    }
}

/**
 * Close whatever session is open for the candidate (keyed on candidate, not
 * agent, so an admin releasing someone else's claim closes it too).
 */
async function closeClaimSession(candidateId, { releasedBy = null, reason = 'manual' } = {}) {
    if (!candidateId) return false;
    try {
        await query(
            adaptQuery(`UPDATE claim_sessions
                        SET released_at = NOW(), released_by = $1, release_reason = $2
                        WHERE candidate_id = $3 AND released_at IS NULL`),
            [releasedBy, reason, candidateId]
        );
        return true;
    } catch (err) {
        logger.warn(`claim-sessions: could not close session for ${candidateId}: ${err.message}`);
        return false;
    }
}

/**
 * The stamp lookup: this agent's OPEN session on this candidate, or null if
 * they don't currently hold the claim.
 */
async function getOpenClaimSessionId(candidateId, agentId) {
    if (!candidateId || !agentId) return null;
    try {
        const res = await query(
            adaptQuery(`SELECT id FROM claim_sessions
                        WHERE candidate_id = $1 AND agent_id = $2 AND released_at IS NULL
                        LIMIT 1`),
            [candidateId, agentId]
        );
        return res.rows[0]?.id || null;
    } catch (err) {
        logger.warn(`claim-sessions: lookup failed for ${candidateId}: ${err.message}`);
        return null;
    }
}

module.exports = { openClaimSession, closeClaimSession, getOpenClaimSessionId };
