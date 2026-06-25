/**
 * Shared tolerant audit_logs writer.
 *
 * Prod audit_logs may still be missing the Migration 021 columns
 * (session_id / section_key / duration_ms) when the table-ownership fix
 * hasn't been applied. Every audit write in the codebase must go through
 * here so a partial schema can never 500 a business operation: the full
 * 10-column insert is tried first, and on a missing-column error we flip
 * a remembered flag and fall back to the legacy 7-column insert.
 *
 * Never throws.
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');

// Tracks whether the Migration 021 columns on audit_logs are present. Detected
// lazily on first failure and remembered so we don't repeatedly probe a schema
// we already know is partial.
let hasMigration021Cols = true;

async function insertAuditRow({
    userId = null,
    sessionId = null,
    action,
    entityType,
    entityId = null,
    sectionKey = null,
    changes = null,
    ip = null,
    userAgent = null,
    durationMs = null,
}) {
    const changesJson = changes == null ? null : JSON.stringify(changes);

    if (hasMigration021Cols) {
        try {
            await query(
                adaptQuery(`
                    INSERT INTO audit_logs
                        (user_id, action, entity_type, entity_id, changes, ip_address, user_agent, session_id, section_key, duration_ms)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `),
                [userId, action, entityType, entityId, changesJson, ip, userAgent, sessionId, sectionKey, durationMs]
            );
            return;
        } catch (err) {
            const msg = (err.message || '').toLowerCase();
            if (msg.includes('session_id') || msg.includes('section_key') || msg.includes('duration_ms') || msg.includes('column')) {
                hasMigration021Cols = false;
                logger.warn('audit-writer: Migration 021 columns missing on audit_logs — falling back to legacy insert. Run scripts/fix-ownership-all.js to restore full tracking.');
            } else {
                logger.warn('audit-writer: write failed —', err.message);
                return;
            }
        }
    }

    // Legacy fallback — works against pre-Migration-021 audit_logs schema.
    try {
        await query(
            adaptQuery(`
                INSERT INTO audit_logs
                    (user_id, action, entity_type, entity_id, changes, ip_address, user_agent)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `),
            [userId, action, entityType, entityId, changesJson, ip, userAgent]
        );
    } catch (err) {
        logger.warn('audit-writer: legacy write failed —', err.message);
    }
}

module.exports = { insertAuditRow };
