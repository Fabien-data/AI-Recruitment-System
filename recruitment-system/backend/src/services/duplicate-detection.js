/**
 * Duplicate Candidate Detection Service
 *
 * Detects potential duplicate candidates using:
 * - Exact phone match (different records, same normalized phone)
 * - Exact email match
 * - Fuzzy name match (Levenshtein distance ≤ 2)
 *
 * Returns pairs with a confidence score (0.0 – 1.0).
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');

/**
 * Levenshtein distance between two strings (case-insensitive)
 */
function levenshtein(a, b) {
    const s1 = a.toLowerCase().trim();
    const s2 = b.toLowerCase().trim();
    if (s1 === s2) return 0;
    if (s1.length === 0) return s2.length;
    if (s2.length === 0) return s1.length;

    const matrix = [];
    for (let i = 0; i <= s2.length; i++) matrix[i] = [i];
    for (let j = 0; j <= s1.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= s2.length; i++) {
        for (let j = 1; j <= s1.length; j++) {
            const cost = s1[j - 1] === s2[i - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    return matrix[s2.length][s1.length];
}

/**
 * Strip country code / spaces / formatting from phone number
 */
function normalizePhone(phone) {
    if (!phone) return '';
    let p = phone.replace(/[\s\-().+]/g, '');
    // Strip leading country codes (94 for Sri Lanka, 1 for US/CA, etc.)
    if (p.startsWith('94') && p.length > 9) p = p.slice(2);
    if (p.startsWith('0') && p.length > 9) p = p.slice(1);
    return p;
}

/**
 * Calculate confidence score for a pair of candidates
 */
function calculateConfidence(c1, c2) {
    let score = 0;
    const reasons = [];

    const p1 = normalizePhone(c1.phone || c1.whatsapp_phone);
    const p2 = normalizePhone(c2.phone || c2.whatsapp_phone);
    const rawMatch = c1.phone === c2.phone || c1.whatsapp_phone === c2.whatsapp_phone;

    if (rawMatch) { score += 0.7; reasons.push('exact_phone'); }
    else if (p1 && p2 && p1 === p2) { score += 0.6; reasons.push('normalized_phone'); }

    if (c1.email && c2.email && c1.email.toLowerCase() === c2.email.toLowerCase()) {
        score += 0.5; reasons.push('exact_email');
    }

    if (c1.name && c2.name) {
        const dist = levenshtein(c1.name, c2.name);
        if (dist === 0) { score += 0.3; reasons.push('exact_name'); }
        else if (dist <= 2) { score += 0.2; reasons.push(`fuzzy_name_dist_${dist}`); }
    }

    // Cap at 1.0
    return { confidence: Math.min(score, 1.0), reasons };
}

/**
 * Find all potential duplicate pairs across all active candidates
 * Returns pairs with confidence >= minConfidence
 */
async function findDuplicates(minConfidence = 0.5, limit = 100) {
    try {
        // Fetch all non-merged candidates with essential fields
        const result = await query(
            adaptQuery(`
                SELECT id, name, phone, whatsapp_phone, email, status, created_at
                FROM candidates
                WHERE status != 'merged'
                ORDER BY created_at DESC
                LIMIT 2000
            `)
        );

        const candidates = result.rows;
        const pairs = [];
        const seen = new Set();

        for (let i = 0; i < candidates.length; i++) {
            for (let j = i + 1; j < candidates.length; j++) {
                const c1 = candidates[i];
                const c2 = candidates[j];
                const key = [c1.id, c2.id].sort().join('::');
                if (seen.has(key)) continue;
                seen.add(key);

                const { confidence, reasons } = calculateConfidence(c1, c2);
                if (confidence >= minConfidence) {
                    pairs.push({
                        candidate_1: c1,
                        candidate_2: c2,
                        confidence,
                        reasons
                    });
                }
            }
        }

        // Sort by confidence descending
        pairs.sort((a, b) => b.confidence - a.confidence);
        return pairs.slice(0, limit);
    } catch (err) {
        logger.error('duplicate-detection: findDuplicates error —', err.message);
        throw err;
    }
}

/**
 * Check if a newly created candidate is a potential duplicate of an existing one
 * Returns the best match (or null if below threshold)
 */
async function checkForDuplicate(candidateId, minConfidence = 0.6) {
    try {
        const newResult = await query(
            adaptQuery('SELECT id, name, phone, whatsapp_phone, email, status FROM candidates WHERE id = $1'),
            [candidateId]
        );
        if (newResult.rows.length === 0) return null;
        const newCandidate = newResult.rows[0];

        // Quick SQL-level pre-filter by normalized phone
        const np = normalizePhone(newCandidate.phone || newCandidate.whatsapp_phone);
        const existing = await query(
            adaptQuery(`
                SELECT id, name, phone, whatsapp_phone, email, status
                FROM candidates
                WHERE id != $1
                  AND status != 'merged'
                  AND (
                      phone = $2 OR whatsapp_phone = $2
                      OR email = $3
                      OR name ILIKE $4
                  )
                LIMIT 20
            `),
            [
                candidateId,
                newCandidate.phone || '',
                newCandidate.email || '',
                `%${(newCandidate.name || '').split(' ')[0]}%`
            ]
        );

        let best = null;
        for (const c of existing.rows) {
            const { confidence, reasons } = calculateConfidence(newCandidate, c);
            if (confidence >= minConfidence) {
                if (!best || confidence > best.confidence) {
                    best = { candidate: c, confidence, reasons };
                }
            }
        }

        return best;
    } catch (err) {
        logger.error('duplicate-detection: checkForDuplicate error —', err.message);
        return null;
    }
}

/**
 * Merge two candidates: migrate all data from merge_id → keep_id
 * and soft-delete the merged record (status = 'merged')
 */
async function mergeCandidates(keepId, mergeId, performedByUserId = null) {
    try {
        // Migrate applications (skip duplicates)
        await query(
            adaptQuery(`
                UPDATE applications SET candidate_id = $1
                WHERE candidate_id = $2
                  AND NOT EXISTS (
                    SELECT 1 FROM applications ex
                    WHERE ex.candidate_id = $1 AND ex.job_id = applications.job_id
                  )
            `),
            [keepId, mergeId]
        );
        // Delete any remaining apps from merge_id that would conflict
        await query(
            adaptQuery('DELETE FROM applications WHERE candidate_id = $1'),
            [mergeId]
        );

        // Migrate communications
        await query(
            adaptQuery('UPDATE communications SET candidate_id = $1 WHERE candidate_id = $2'),
            [keepId, mergeId]
        );

        // Migrate CV files
        await query(
            adaptQuery('UPDATE cv_files SET candidate_id = $1 WHERE candidate_id = $2'),
            [keepId, mergeId]
        );

        // Migrate notification queue
        await query(
            adaptQuery('UPDATE notification_queue SET candidate_id = $1 WHERE candidate_id = $2'),
            [keepId, mergeId]
        );

        // Soft-delete the merged candidate
        await query(
            adaptQuery(`
                UPDATE candidates
                SET status = 'merged',
                    merged_into_id = $1,
                    updated_at = NOW()
                WHERE id = $2
            `),
            [keepId, mergeId]
        );

        // Write audit log if table exists
        try {
            await query(
                adaptQuery(`
                    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes)
                    VALUES ($1, 'merge', 'candidate', $2, $3)
                `),
                [
                    performedByUserId,
                    mergeId,
                    JSON.stringify({ merged_into: keepId })
                ]
            );
        } catch (_) { /* audit table may not have merged_into_id column yet */ }

        logger.info(`duplicate-detection: merged candidate ${mergeId} → ${keepId}`);
        return { success: true, kept_id: keepId, merged_id: mergeId };
    } catch (err) {
        logger.error('duplicate-detection: mergeCandidates error —', err.message);
        throw err;
    }
}

module.exports = { findDuplicates, checkForDuplicate, mergeCandidates, calculateConfidence, normalizePhone };
