/**
 * Job Re-engagement Waiting List
 * ==============================
 * When a candidate asked about a role we had no opening for, the chatbot parks
 * them in `general_pool` with metadata.job_interest_stated (the role they
 * wanted). When a matching job is later ACTIVATED (created active, or flipped to
 * active), notifyWaitlistForJob() finds those parked candidates and sends them a
 * proactive "we now have a {role} job — want to apply?" WhatsApp via the chatbot.
 *
 * interest_notified_at (migration 026) de-dupes: a pool entry is invited at most
 * once. Sends go through the same chatbotNotifier path as every other proactive
 * message; out-of-24h-window delivery needs the approved `dewan_job_now_available`
 * template (the chatbot picks template vs free-form by the candidate's window).
 *
 * The canonical-category map below MIRRORS the chatbot's _ROLE_SYNONYMS
 * (app/services/vacancy_service.py). Keep the two in sync when roles change.
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const notifications = require('./notifications');
const logger = require('../utils/logger');

// canonical category → synonyms. Mirrors chatbot vacancy_service._ROLE_SYNONYMS
// (plus "security officer", the exact ad wording).
const ROLE_SYNONYMS = {
    'security guard': ['security', 'guard', 'sec', 'watchman', 'security officer', 'securitar'],
    'driver': ['driver', 'drv', 'riyaduru', 'vehicle', 'chauffeur'],
    'nurse': ['nurse', 'nursing', 'caregiver', 'hediya'],
    'cook': ['cook', 'chef', 'cooking', 'kitchen'],
    'cleaner': ['cleaner', 'cleaning', 'janitor', 'housekeeping'],
    'factory worker': ['factory', 'production', 'manufacturing', 'assembly'],
    'welder': ['welder', 'welding', 'weld'],
    'electrician': ['electrician', 'electric', 'electrical'],
    'carpenter': ['carpenter', 'joinery', 'woodwork'],
    'plumber': ['plumber', 'plumbing', 'pipe'],
    'mason': ['mason', 'masonry', 'bricklayer'],
    'helper': ['helper', 'general worker', 'labour', 'laborer', 'labor'],
    'housemaid': ['housemaid', 'domestic', 'maid', 'servant'],
};

/** Map free text ("security officer", "watchman") to a canonical category. */
function canonicalCategory(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return '';
    for (const [canonical, syns] of Object.entries(ROLE_SYNONYMS)) {
        if (t === canonical) return canonical;
        for (const syn of syns) {
            if (t === syn || t.includes(syn)) return canonical;
        }
    }
    return t;
}

/** True if a candidate's stated interest matches a job's role. */
function interestMatchesJob(interestText, job) {
    if (!interestText) return false;
    const interest = canonicalCategory(interestText);
    const jobCat = canonicalCategory(job.category || '');
    const jobTitleCat = canonicalCategory(job.title || '');
    if (interest && (interest === jobCat || interest === jobTitleCat)) return true;
    // Substring fallback both ways (e.g. interest "security" vs title "Security Officer").
    const it = String(interestText).toLowerCase().trim();
    const haystack = `${job.title || ''} ${job.category || ''}`.toLowerCase();
    return Boolean(it && (haystack.includes(it) || (interest && haystack.includes(interest))));
}

function _parseMetadata(meta) {
    if (!meta) return {};
    if (typeof meta === 'string') {
        try { return JSON.parse(meta); } catch (_) { return {}; }
    }
    return meta;
}

/**
 * Notify waiting-list candidates that a matching job just opened.
 * Returns { matched, notified }. Never throws (logs and continues).
 * @param {{id:string, title:string, category:string, status?:string}} job
 */
async function notifyWaitlistForJob(job) {
    if (!job || !job.id) return { matched: 0, notified: 0 };
    if (job.status && String(job.status).toLowerCase() !== 'active') {
        return { matched: 0, notified: 0 };
    }

    let rows;
    try {
        rows = await query(adaptQuery(`
            SELECT gp.id AS pool_id, gp.metadata,
                   c.id AS candidate_id, c.name, c.phone
            FROM general_pool gp
            JOIN candidates c ON gp.candidate_id = c.id
            WHERE gp.interest_notified_at IS NULL
              AND c.phone IS NOT NULL
              AND COALESCE(c.status, '') NOT IN ('merged', 'hired')
            LIMIT 1000
        `));
    } catch (err) {
        logger.warn(`job-waitlist: query failed for job ${job.id}: ${err.message}`);
        return { matched: 0, notified: 0 };
    }

    let matched = 0;
    let notified = 0;
    for (const r of rows.rows) {
        const meta = _parseMetadata(r.metadata);
        const interest = meta.job_interest_stated || meta.future_pool_role || meta.desired_category || '';
        if (!interestMatchesJob(interest, job)) continue;
        matched += 1;
        try {
            const res = await notifications.sendJobAvailableNotification(r.candidate_id, job.title);
            const ok = res && Array.isArray(res.success) && res.success.length > 0;
            if (ok) {
                notified += 1;
                // Mark notified only on a confirmed send so a failed (e.g.
                // out-of-window, no template yet) attempt retries on the next
                // matching activation.
                await query(
                    adaptQuery('UPDATE general_pool SET interest_notified_at = NOW() WHERE id = $1'),
                    [r.pool_id]
                );
            }
        } catch (err) {
            logger.warn(`job-waitlist: notify failed for candidate ${r.candidate_id}: ${err.message}`);
        }
    }

    if (matched > 0) {
        logger.info(`job-waitlist: job ${job.id} (${job.title}) — matched ${matched}, notified ${notified}`);
    }
    return { matched, notified };
}

module.exports = {
    notifyWaitlistForJob,
    canonicalCategory,
    interestMatchesJob,
};
