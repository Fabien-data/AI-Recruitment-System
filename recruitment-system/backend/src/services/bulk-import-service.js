/**
 * Bulk Application Import Service
 * ==============================
 * Imports existing agency applications (≈1000, project-by-project) from a parsed
 * spreadsheet. Each accepted row reproduces the normal intake cascade —
 *   Candidate → CV Manager entry (cv_files) → Application → Conversation (communications)
 * — with labels (candidates.tags), mirroring routes/chatbot-intake.js but without
 * the WhatsApp bits.
 *
 * Locked product rules (see the plan file):
 *  1. CVs arrive as files matched to rows by the caller; this service receives the
 *     matched file (Buffer) per row, uploads it via utils/gcs-upload, links cv_files.
 *  2. Rows with NO CV still create the candidate AND the application — the normal CV
 *     screening gate (applications.js POST handler) is bypassed by inserting directly
 *     here. CV-less rows are flagged metadata.cv_missing=true and the candidate is
 *     left at stage 'new' (deriveCandidateStage), so they surface in Awaiting-CV.
 *  3. Every imported application is created at status 'certified' (certified_at /
 *     certified_by set) so interviews can be bulk-scheduled afterwards.
 *  4. A row whose phone OR email already exists in the DB (or repeats earlier in the
 *     file) is SKIPPED and reported — the existing system record is never touched.
 *
 * Idempotent by construction: skip-by-phone/email + ON CONFLICT (candidate_id,job_id)
 * DO NOTHING. Every created candidate/application/communication is stamped
 * metadata.import_batch_id for one-query rollback and reporting.
 */

const { query, withTransaction, generateUUID } = require('../config/database');
const { isMySQL } = require('../utils/query-adapter');
const { normalizePhone } = require('../utils/phone');
const { saveCVFile } = require('../utils/gcs-upload');
const { normalizeApplicationStatus, syncCandidateStage } = require('./candidate-stage');
const logger = require('../utils/logger');

const ALLOWED_LANGUAGES = new Set(['en', 'si', 'ta']);

// ── small coercion helpers ───────────────────────────────────────────────────
function cleanStr(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
}
function toIntOrNull(v) {
    if (v == null || v === '') return null;
    const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
    return Number.isNaN(n) ? null : n;
}
function normalizeGender(v) {
    const s = (cleanStr(v) || '').toLowerCase();
    if (['m', 'male', 'man', 'boy'].includes(s)) return 'male';
    if (['f', 'female', 'woman', 'girl'].includes(s)) return 'female';
    return cleanStr(v) || null;
}
function splitList(v) {
    const s = cleanStr(v);
    if (!s) return [];
    return s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}
function parseDateOrNull(v) {
    const s = cleanStr(v);
    if (!s) return null;
    const d = new Date(s);
    // Date-only (YYYY-MM-DD) so applied_at lands on the intended calendar day on
    // both PG (::timestamp) and MySQL without timezone drift rolling the date.
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function fileExt(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : null;
}
function normalizeLanguage(v) {
    const s = (cleanStr(v) || '').toLowerCase();
    return ALLOWED_LANGUAGES.has(s) ? s : 'en';
}

/**
 * Map a raw spreadsheet row (already keyed by canonical column names on the
 * frontend) into a trimmed, predictable shape. Defensive — re-cleans on the
 * backend so a hand-built JSON payload still behaves.
 */
function normalizeRow(raw, index) {
    return {
        _index: typeof raw._index === 'number' ? raw._index : index,
        name: cleanStr(raw.name),
        phone: cleanStr(raw.phone),
        email: cleanStr(raw.email),
        job_title: cleanStr(raw.job_title),
        cv_filename: cleanStr(raw.cv_filename),
        applied_date: cleanStr(raw.applied_date),
        preferred_language: raw.preferred_language,
        experience_years: raw.experience_years,
        highest_qualification: cleanStr(raw.highest_qualification),
        skills: cleanStr(raw.skills),
        age: raw.age,
        gender: raw.gender,
        nationality: cleanStr(raw.nationality),
        current_location: cleanStr(raw.current_location),
        destination_country: cleanStr(raw.destination_country),
        labels: raw.labels,
        notes: cleanStr(raw.notes),
        source: cleanStr(raw.source),
        application_status: cleanStr(raw.application_status),
        // set by the frontend file-match step; the commit path also knows from the
        // actual file presence, so this is only used for the dry-run count.
        cv_present: raw.cv_present === true || raw.cv_present === 'true',
    };
}

/**
 * Resolve which job inside the selected project a row maps to.
 *  1. exact case-insensitive title match
 *  2. partial (contains) match either direction
 *  3. fall back to the wizard's default job (validated to be in the project)
 * Returns a job id or null (row errors as `unresolved_job`).
 */
function resolveJobId(row, jobs, defaultJobId) {
    const title = (row.job_title || '').trim().toLowerCase();
    if (title) {
        const exact = jobs.find((j) => String(j.title || '').trim().toLowerCase() === title);
        if (exact) return exact.id;
        const partial = jobs.find((j) => {
            const t = String(j.title || '').trim().toLowerCase();
            return t && (t.includes(title) || title.includes(t));
        });
        if (partial) return partial.id;
    }
    if (defaultJobId && jobs.some((j) => j.id === defaultJobId)) return defaultJobId;
    return null;
}

async function loadProjectJobs(projectId) {
    const sql = isMySQL
        ? 'SELECT id, title FROM jobs WHERE project_id = ?'
        : 'SELECT id, title FROM jobs WHERE project_id = $1';
    const r = await query(sql, [projectId]);
    return r.rows || [];
}

/**
 * One batched probe for existing candidates matching any of the given phones or
 * emails. Returns Sets used by the dry-run analysis. Portable IN-list (works on
 * both PG and MySQL — avoids PG-only ANY(array)).
 */
async function loadExistingContacts(phones, emails) {
    const existingPhones = new Set();
    const existingEmails = new Set();
    const uniqPhones = [...new Set(phones.filter(Boolean))];
    const uniqEmails = [...new Set(emails.filter(Boolean))];

    const collect = (rows) => {
        (rows || []).forEach((row) => {
            if (row.phone) existingPhones.add(row.phone);
            if (row.email) existingEmails.add(String(row.email).toLowerCase());
        });
    };

    if (uniqPhones.length) {
        const ph = uniqPhones.map((_, i) => (isMySQL ? '?' : `$${i + 1}`)).join(',');
        const r = await query(`SELECT phone, email FROM candidates WHERE phone IN (${ph})`, uniqPhones);
        collect(r.rows);
    }
    if (uniqEmails.length) {
        const em = uniqEmails.map((_, i) => (isMySQL ? '?' : `$${i + 1}`)).join(',');
        const r = await query(`SELECT phone, email FROM candidates WHERE LOWER(email) IN (${em})`, uniqEmails);
        collect(r.rows);
    }
    return { existingPhones, existingEmails };
}

/**
 * Pure dry-run analysis. Given the project's jobs + the sets of contacts already
 * in the DB, classify every row WITHOUT writing anything. Used by the validate
 * endpoint. `cv_present` per row (set by the frontend match step) feeds the
 * missing_cv count.
 */
function analyzeRows(rawRows, { jobs, defaultJobId, existingPhones, existingEmails }) {
    const seenPhones = new Set();
    const seenEmails = new Set();
    const rows = [];
    let willCreate = 0;
    let inFileDups = 0;
    let dbDups = 0;
    let missingCv = 0;
    let unresolvedJob = 0;
    let errors = 0;

    rawRows.forEach((raw, i) => {
        const row = normalizeRow(raw, i);
        const v = { row_index: row._index, name: row.name, phone: null, verdict: 'ok', reason: null, matched_field: null };

        if (!row.name) { v.verdict = 'error'; v.reason = 'missing_name'; errors++; rows.push(v); return; }
        const phone = normalizePhone(row.phone);
        if (!phone) { v.verdict = 'error'; v.reason = 'invalid_phone'; errors++; rows.push(v); return; }
        v.phone = phone;
        const email = row.email ? row.email.toLowerCase() : null;

        if (seenPhones.has(phone) || (email && seenEmails.has(email))) {
            v.verdict = 'in_file_duplicate';
            v.matched_field = seenPhones.has(phone) ? 'phone' : 'email';
            v.reason = 'Duplicate of an earlier row in this file';
            inFileDups++; rows.push(v); return;
        }
        seenPhones.add(phone);
        if (email) seenEmails.add(email);

        if (existingPhones.has(phone) || (email && existingEmails.has(email))) {
            v.verdict = 'db_duplicate';
            v.matched_field = existingPhones.has(phone) ? 'phone' : 'email';
            v.reason = 'Already exists in the system (kept untouched)';
            dbDups++; rows.push(v); return;
        }

        const jobId = resolveJobId(row, jobs, defaultJobId);
        if (!jobId) {
            v.verdict = 'unresolved_job';
            v.reason = row.job_title
                ? `No job "${row.job_title}" in this project`
                : 'No job_title and no default job selected';
            unresolvedJob++; rows.push(v); return;
        }
        v.job_id = jobId;
        if (!row.cv_present) missingCv++;
        willCreate++;
        rows.push(v);
    });

    return {
        total: rawRows.length,
        will_create: willCreate,
        in_file_dups: inFileDups,
        db_dups: dbDups,
        missing_cv: missingCv,
        unresolved_job: unresolvedJob,
        errors,
        rows,
    };
}

/** Validate endpoint core: load jobs + existing contacts, then analyze. */
async function validateRows(rawRows, { projectId, defaultJobId }) {
    const jobs = await loadProjectJobs(projectId);
    const normalized = rawRows.map((r, i) => normalizeRow(r, i));
    const phones = normalized.map((r) => normalizePhone(r.phone)).filter(Boolean);
    const emails = normalized.map((r) => (r.email ? r.email.toLowerCase() : null)).filter(Boolean);
    const { existingPhones, existingEmails } = await loadExistingContacts(phones, emails);
    return {
        jobs_count: jobs.length,
        ...analyzeRows(rawRows, { jobs, defaultJobId, existingPhones, existingEmails }),
    };
}

/**
 * Import a single row. Per-row transaction so one bad row never rolls back the
 * batch. Returns a result descriptor (never throws for "expected" outcomes like
 * duplicates / unresolved job — those are statuses, not exceptions).
 */
async function importRow(raw, cvFile, ctx) {
    const row = normalizeRow(raw, raw._index);
    const result = {
        row_index: row._index,
        status: 'error',
        candidate_id: null,
        application_id: null,
        cv_attached: false,
        reason: null,
        matched_field: null,
        matched_candidate_id: null,
    };

    if (!row.name) { result.reason = 'missing_name'; return result; }
    const phone = normalizePhone(row.phone);
    if (!phone) { result.reason = 'invalid_phone'; return result; }
    const email = row.email ? row.email.toLowerCase() : null;

    // In-batch dedup (first occurrence wins).
    if (ctx.seenPhones.has(phone) || (email && ctx.seenEmails.has(email))) {
        result.status = 'skipped_duplicate';
        result.reason = 'in_file';
        result.matched_field = ctx.seenPhones.has(phone) ? 'phone' : 'email';
        return result;
    }

    // Resolve the job up-front so we never create an orphan candidate.
    const jobId = resolveJobId(row, ctx.jobs, ctx.defaultJobId);
    if (!jobId) { result.status = 'error'; result.reason = 'unresolved_job'; return result; }

    // DB duplicate → skip the whole row, keep the system record (locked rule 4).
    const dupSql = isMySQL
        ? 'SELECT id FROM candidates WHERE phone = ? OR (email IS NOT NULL AND ? IS NOT NULL AND LOWER(email) = ?) LIMIT 1'
        : 'SELECT id FROM candidates WHERE phone = $1 OR (email IS NOT NULL AND $2 IS NOT NULL AND LOWER(email) = $2) LIMIT 1';
    const dupParams = isMySQL ? [phone, email, email] : [phone, email];
    const dup = await query(dupSql, dupParams);
    if (dup.rows && dup.rows.length) {
        ctx.seenPhones.add(phone);
        if (email) ctx.seenEmails.add(email);
        result.status = 'skipped_duplicate';
        result.reason = 'db';
        result.matched_candidate_id = dup.rows[0].id;
        result.matched_field = 'phone/email';
        return result;
    }

    // Reserve this contact for the rest of the batch.
    ctx.seenPhones.add(phone);
    if (email) ctx.seenEmails.add(email);

    const candidateId = generateUUID();

    // Upload the CV first (outside the DB transaction). A storage failure does NOT
    // fail the row — per locked rule 2 we still import it as cv_missing.
    let cvInfo = null;
    if (cvFile && cvFile.buffer) {
        try {
            const base64 = cvFile.buffer.toString('base64');
            const originalName = cvFile.originalname || `${phone}.pdf`;
            const saved = await saveCVFile(base64, originalName, candidateId, process.env.UPLOAD_DIR);
            if (saved && saved.url) {
                cvInfo = { url: saved.url, name: originalName, type: fileExt(originalName), size: cvFile.buffer.length };
            }
        } catch (e) {
            logger.warn(`bulk-import: CV upload failed for ${phone} — ${e.message}`);
        }
    }
    const hasCv = !!cvInfo;

    const labels = splitList(row.labels);
    const skills = splitList(row.skills).join(', ') || null;
    const originalStatus = row.application_status
        ? normalizeApplicationStatus(row.application_status.toLowerCase())
        : null;
    const metadata = {
        age: toIntOrNull(row.age),
        gender: normalizeGender(row.gender),
        nationality: row.nationality || null,
        location: row.current_location || null,
        destination_country: row.destination_country || null,
        cv_missing: !hasCv,
        import_batch_id: ctx.batchId,
        imported_by: ctx.userId,
        imported_at: new Date().toISOString(),
        original_status: originalStatus,
    };
    const appliedAt = parseDateOrNull(row.applied_date);
    const metaJson = JSON.stringify(metadata);
    const appMeta = JSON.stringify({ import_batch_id: ctx.batchId, original_status: originalStatus, source: 'bulk_import' });
    const commMeta = JSON.stringify({
        source: 'bulk_import',
        import_batch_id: ctx.batchId,
        job_id: jobId,
        cv_url: hasCv ? cvInfo.url : null,
        original_status: originalStatus,
        labels,
    });
    const content = row.notes || 'Application imported from agency spreadsheet';

    let applicationId = null;
    try {
        await withTransaction(async (client) => {
            // 1) Candidate — status starts 'new'; syncCandidateStage (post-commit)
            //    promotes to 'certified' when a CV is present, or keeps 'new' for
            //    CV-less rows (Awaiting-CV).
            if (isMySQL) {
                await client.query(
                    `INSERT INTO candidates
                        (id, name, phone, whatsapp_phone, email, source, preferred_language, status,
                         tags, skills, experience_years, highest_qualification, notes, metadata, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                    [candidateId, row.name, phone, phone, email, row.source || 'import',
                        normalizeLanguage(row.preferred_language), JSON.stringify(labels), skills,
                        toIntOrNull(row.experience_years), row.highest_qualification || null, row.notes || null, metaJson]
                );
            } else {
                await client.query(
                    `INSERT INTO candidates
                        (id, name, phone, whatsapp_phone, email, source, preferred_language, status,
                         tags, skills, experience_years, highest_qualification, notes, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'new', $8, $9, $10, $11, $12, $13::jsonb)`,
                    [candidateId, row.name, phone, phone, email, row.source || 'import',
                        normalizeLanguage(row.preferred_language), labels, skills,
                        toIntOrNull(row.experience_years), row.highest_qualification || null, row.notes || null, metaJson]
                );
            }

            // 2) CV Manager entry (cv_files) — only when a file was stored.
            if (hasCv) {
                const cvId = generateUUID();
                if (isMySQL) {
                    await client.query(
                        `INSERT INTO cv_files
                            (id, candidate_id, file_url, file_name, file_size, file_type, ocr_status, is_primary, uploaded_at)
                         VALUES (?, ?, ?, ?, ?, ?, 'pending', TRUE, NOW())`,
                        [cvId, candidateId, cvInfo.url, cvInfo.name, cvInfo.size, cvInfo.type]
                    );
                    await client.query(
                        "UPDATE candidates SET cv_uploaded = TRUE, cv_status = 'completed', updated_at = NOW() WHERE id = ?",
                        [candidateId]
                    );
                } else {
                    await client.query(
                        `INSERT INTO cv_files
                            (id, candidate_id, file_url, file_name, file_size, file_type, ocr_status, is_primary, uploaded_at)
                         VALUES ($1, $2, $3, $4, $5, $6, 'pending', TRUE, NOW())`,
                        [cvId, candidateId, cvInfo.url, cvInfo.name, cvInfo.size, cvInfo.type]
                    );
                    await client.query(
                        "UPDATE candidates SET cv_uploaded = TRUE, cv_status = 'completed', updated_at = NOW() WHERE id = $1",
                        [candidateId]
                    );
                }
            }

            // 3) Application — status 'certified', screening gate bypassed (direct
            //    insert, never via the POST /api/applications handler). Idempotent.
            const appId = generateUUID();
            if (isMySQL) {
                await client.query(
                    `INSERT INTO applications
                        (id, candidate_id, job_id, status, applied_at, certified_at, certified_by, certification_notes, metadata)
                     VALUES (?, ?, ?, 'certified', COALESCE(?, NOW()), NOW(), ?, ?, ?)
                     ON DUPLICATE KEY UPDATE id = id`,
                    [appId, candidateId, jobId, appliedAt, ctx.userId, `Bulk import ${ctx.batchId}`, appMeta]
                );
                const ex = await client.query(
                    'SELECT id FROM applications WHERE candidate_id = ? AND job_id = ? LIMIT 1',
                    [candidateId, jobId]
                );
                applicationId = ex.rows[0] ? ex.rows[0].id : appId;
            } else {
                const ins = await client.query(
                    `INSERT INTO applications
                        (id, candidate_id, job_id, status, applied_at, certified_at, certified_by, certification_notes, metadata)
                     VALUES ($1, $2, $3, 'certified', COALESCE($4::timestamp, NOW()), NOW(), $5, $6, $7::jsonb)
                     ON CONFLICT (candidate_id, job_id) DO NOTHING
                     RETURNING id`,
                    [appId, candidateId, jobId, appliedAt, ctx.userId, `Bulk import ${ctx.batchId}`, appMeta]
                );
                applicationId = ins.rows[0] ? ins.rows[0].id : appId;
            }

            // 4) Conversation (communications) — the "Conversations object".
            const commId = generateUUID();
            if (isMySQL) {
                await client.query(
                    `INSERT INTO communications
                        (id, candidate_id, channel, direction, message_type, content, metadata, sent_at)
                     VALUES (?, ?, 'import', 'inbound', 'document', ?, ?, NOW())`,
                    [commId, candidateId, content, commMeta]
                );
            } else {
                await client.query(
                    `INSERT INTO communications
                        (id, candidate_id, channel, direction, message_type, content, metadata)
                     VALUES ($1, $2, 'import', 'inbound', 'document', $3, $4::jsonb)`,
                    [commId, candidateId, content, commMeta]
                );
            }
        });
    } catch (e) {
        // A (phone OR email) duplicate that raced past the pre-check trips the DB
        // trigger / unique constraint — treat as a skip, not a hard error.
        if (/duplicate/i.test(e.message || '')) {
            result.status = 'skipped_duplicate';
            result.reason = 'db_race';
            return result;
        }
        result.status = 'error';
        result.reason = e.message;
        return result;
    }

    // Post-commit: derive the candidate's canonical stage. CV present → 'certified';
    // CV missing → 'new' (Awaiting-CV). Fire-and-forget semantics, but awaited so
    // batch results / tests are deterministic.
    try { await syncCandidateStage(candidateId); } catch (_) { /* never fatal */ }

    result.status = 'created';
    result.candidate_id = candidateId;
    result.application_id = applicationId;
    result.cv_attached = hasCv;
    result.reason = hasCv ? null : 'cv_missing';
    return result;
}

/**
 * Commit one batch of rows. `files` maps a row's _index → { buffer, originalname,
 * mimetype } (the route reconstructs this from multer files + the file_map).
 */
async function importApplicationBatch(rawRows, files, options) {
    const { projectId, defaultJobId, userId, batchId } = options;
    const jobs = await loadProjectJobs(projectId);
    const ctx = {
        projectId,
        defaultJobId,
        userId,
        batchId,
        jobs,
        seenPhones: new Set(),
        seenEmails: new Set(),
    };

    const results = [];
    for (const raw of rawRows) {
        const cvFile = files ? files[raw._index] : null;
        try {
            results.push(await importRow(raw, cvFile, ctx));
        } catch (e) {
            logger.error(`bulk-import: unexpected failure on row ${raw._index} — ${e.message}`);
            results.push({
                row_index: raw._index,
                status: 'error',
                reason: e.message,
                candidate_id: null,
                application_id: null,
                cv_attached: false,
            });
        }
    }

    const summary = results.reduce(
        (acc, r) => {
            if (r.status === 'created') acc.created++;
            else if (r.status === 'skipped_duplicate') acc.skipped_duplicate++;
            else acc.error++;
            if (r.cv_attached) acc.cv_attached++;
            return acc;
        },
        { created: 0, skipped_duplicate: 0, error: 0, cv_attached: 0 }
    );

    return { results, summary };
}

module.exports = {
    // public
    validateRows,
    importApplicationBatch,
    // exported for unit tests
    normalizeRow,
    resolveJobId,
    analyzeRows,
    importRow,
    splitList,
    normalizeGender,
};
