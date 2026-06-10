/**
 * Agent activity log
 * ==================
 * Records an agent ACTION (certify / schedule interview / …) as a call_logs row
 * tagged with action_type, so it shows in the candidate's engagement timeline
 * ("Certified for X", "Interview sent — <when>") and feeds the per-agent rollup.
 * These actions previously bypassed call_logs entirely, so they were invisible in
 * Engagement. Best-effort + never throws — logging must not break the action.
 */
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');

/**
 * @param {object} opts
 * @param {string} opts.candidateId
 * @param {*}      opts.agentId
 * @param {string} opts.actionType   - 'certify' | 'interview' | 'assign' | 'note' | …
 * @param {string} [opts.remark]     - human-readable detail (e.g. "Interview on … — invite sent")
 * @param {string} [opts.jobId]
 * @param {string} [opts.applicationId]
 * @param {string} [opts.outcome]    - optional call outcome (usually null for pure actions)
 */
async function logAgentAction({ candidateId, agentId, actionType, remark = null, jobId = null, applicationId = null, outcome = null }) {
    if (!candidateId || !actionType) return null;
    try {
        const id = generateUUID();
        await query(
            adaptQuery(`INSERT INTO call_logs
                            (id, candidate_id, agent_id, outcome, disposition, remark, duration_seconds, job_id, application_id, reason, action_type)
                        VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, $7, NULL, $8)`),
            [id, candidateId, agentId || null, outcome, remark, jobId, applicationId, actionType]
        );
        return id;
    } catch (err) {
        logger.warn(`activity-log: could not record ${actionType} for ${candidateId}: ${err.message}`);
        return null;
    }
}

module.exports = { logAgentAction };
