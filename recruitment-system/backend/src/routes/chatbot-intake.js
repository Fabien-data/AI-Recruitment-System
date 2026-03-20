/**
 * Chatbot Intake Route
 * ====================
 * Secure endpoint that receives fully collected candidate data
 * from the WhatsApp Python chatbot and creates/updates the
 * candidate record in the recruitment system.
 *
 * Auth: x-chatbot-api-key header (shared secret, NOT JWT)
 *
 * POST /api/chatbot/intake
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, generateUUID } = require('../config/database');
const { saveCVFile } = require('../utils/gcs-upload');
const { isMySQL } = require('../utils/query-adapter');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const { recruiterAlert } = require('../services/recruiter-alerts');
const { checkForDuplicate } = require('../services/duplicate-detection');
const multer = require('multer');
const { normalizeIncomingCvUrl } = require('../utils/cv-url');

// Multer for multipart/form-data CV uploads (max 20MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Strict rate limit for this endpoint ─────────────────────────────────────
const chatbotLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute window
    max: 60,               // max 60 calls per minute (1 per second avg)
    message: { error: 'Too many requests from chatbot, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }, // trust proxy is set at app level
});

// ── API Key Authentication middleware (supports dual-key rotation) ────────
function authenticateChatbot(req, res, next) {
    const apiKey = req.headers['x-chatbot-api-key'];
    const expectedKey = process.env.CHATBOT_API_KEY;
    const expectedOldKey = process.env.CHATBOT_API_KEY_OLD;

    if (!expectedKey) {
        logger.error('CHATBOT_API_KEY not set in environment!');
        return res.status(500).json({ error: 'Server misconfiguration: chatbot key not set' });
    }

    if (!apiKey) {
        logger.warn(`Chatbot intake: rejected request with no key from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: missing chatbot API key' });
    }

    // Accept current key
    if (apiKey === expectedKey) {
        return next();
    }

    // Accept old key during rotation window
    if (expectedOldKey && apiKey === expectedOldKey) {
        logger.info('Chatbot intake: authenticated with OLD API key — rotation in progress');
        return next();
    }

    logger.warn(`Chatbot intake: rejected request with invalid key from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: invalid chatbot API key' });
}

// ── GET /api/chatbot/jobs — Active jobs for chatbot job cache bootstrap ───────
router.get('/jobs', authenticateChatbot, async (req, res) => {
    try {
        const jobsSQL = isMySQL
            ? `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available,
                      p.id as project_id, p.countries, p.benefits, p.interview_date
               FROM jobs j
               LEFT JOIN projects p ON j.project_id = p.id
               WHERE j.status = 'active'
               ORDER BY j.created_at DESC`
            : `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available,
                      p.id as project_id, p.countries, p.benefits, p.interview_date
               FROM jobs j
               LEFT JOIN projects p ON j.project_id = p.id
               WHERE j.status = 'active'
               ORDER BY j.created_at DESC`;

        const result = await query(jobsSQL, []);
        const jobs = result.rows.map(job => {
            let requirements = {};
            if (job.requirements) {
                try {
                    requirements = typeof job.requirements === 'string'
                        ? JSON.parse(job.requirements)
                        : job.requirements;
                } catch (e) { /* ignore parse error */ }
            }
            return {
                job_id: job.id,
                title: job.title,
                category: job.category,
                status: job.status,
                salary_range: job.salary_range,
                positions_available: job.positions_available,
                project_id: job.project_id,
                requirements,
            };
        });

        logger.info(`Chatbot jobs fetch: returned ${jobs.length} active jobs`);
        return res.json({ jobs });
    } catch (error) {
        logger.error('Chatbot jobs fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch jobs', detail: error.message });
    }
});

// ── Payload Validation middleware ────────────────────────────────────────────
function validateIntakePayload(req, res, next) {
    const { phone, name, job_interest } = req.body;
    const errors = [];

    // phone: required, E.164-compatible
    if (!phone || typeof phone !== 'string') {
        errors.push('phone is required');
    } else {
        const normalizedPhone = phone.replace(/[\s\-]/g, '');
        if (!/^\+?[0-9]{7,15}$/.test(normalizedPhone)) {
            errors.push(`phone format invalid: "${phone}" — expected E.164 e.g. +94771234567`);
        }
    }

    // name: required, min 2 chars
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        errors.push('name is required (min 2 characters)');
    }

    // job_interest: required
    if (!job_interest || typeof job_interest !== 'string' || job_interest.trim().length < 2) {
        errors.push('job_interest is required (which role the candidate applied for)');
    }

    // email: optional but must be valid if provided
    const { email } = req.body;
    if (email && typeof email === 'string' && email.trim().length > 0) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            errors.push(`email format invalid: "${email}"`);
        }
    }

    // experience_years: optional but must be integer 0–60
    const { experience_years } = req.body;
    if (experience_years !== undefined && experience_years !== null) {
        const exp = parseInt(experience_years, 10);
        if (isNaN(exp) || exp < 0 || exp > 60) {
            errors.push('experience_years must be an integer between 0 and 60');
        }
    }

    // preferred_language: must be en/si/ta/singlish/tanglish if provided
    const { preferred_language } = req.body;
    if (preferred_language && !['en', 'si', 'ta', 'singlish', 'tanglish'].includes(preferred_language)) {
        errors.push('preferred_language must be one of: en, si, ta, singlish, tanglish');
    }

    if (errors.length > 0) {
        logger.warn('Chatbot intake validation failed:', errors);
        return res.status(400).json({
            error: 'Validation failed',
            details: errors
        });
    }

    next();
}

// ── Normalize phone to E.164-ish format ──────────────────────────────────────
function normalizePhone(phone) {
    return phone.replace(/[\s\-()]/g, '');
}

function parseAdditionalDocuments(rawValue) {
    if (!rawValue) return [];
    if (Array.isArray(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
        try {
            const parsed = JSON.parse(rawValue);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            logger.warn(`Chatbot intake: failed to parse additional_documents JSON — ${err.message}`);
            return [];
        }
    }
    return [];
}

function inferFileType(fileName) {
    const ext = String(fileName || '').toLowerCase().split('.').pop();
    if (!ext || ext === String(fileName || '').toLowerCase()) return 'document';
    if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) return ext;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
    return ext;
}

function withDocumentCategory(parsedData, category) {
    const base = parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)
        ? parsedData
        : {};

    return {
        ...base,
        __document_category: category,
    };
}

// ── Main Intake Handler ───────────────────────────────────────────────────────

/**
 * POST /api/chatbot/intake
 *
 * Body:
 *   phone              string  REQUIRED
 *   name               string  REQUIRED
 *   job_interest       string  REQUIRED  (job title candidate applied for)
 *   email              string  optional
 *   preferred_language string  optional  (en|si|ta)
 *   skills             string  optional  (comma-separated)
 *   experience_years   number  optional
 *   highest_qualification string optional
 *   destination_country string optional
 *   cv_file_path       string  optional  (local path on chatbot server)
 *   cv_base64          string  optional  (base64 encoded file contents)
 *   cv_file_name       string  optional  (name of the file if base64 provided)
 *   cv_raw_text        string  optional
 *   cv_parsed_data     object  optional  (full JSON from chatbot extraction)
 *   additional_documents array optional (each: {file_name, file_url|file_path|file_base64, raw_text?, parsed_data?})
 *   job_id             string  optional  (UUID — known if candidate came via ad)
 *   ad_ref             string  optional  (e.g. "job_abc123" from META ad)
 *   chatbot_candidate_id number optional (chatbot's internal candidate PK)
 *
 * Response 201: { candidate_id, application_id, status: "created" }
 * Response 200: { candidate_id, application_id, status: "updated" }
 */
router.post(
    '/',
    chatbotLimiter,
    authenticateChatbot,
    upload.fields([
        { name: 'cv_file', maxCount: 1 },
        { name: 'additional_files', maxCount: 10 }
    ]),  // Accept optional multipart CV + additional documents
    // Merge multipart payload field into req.body if present
    (req, res, next) => {
        if (req.body.payload) {
            try {
                const parsed = JSON.parse(req.body.payload);
                req.body = { ...parsed };
            } catch (e) {
                return res.status(400).json({ error: 'Invalid JSON in payload field' });
            }
        }

        // Verify CV checksum if provided
        const multipartCvFile = req.files?.cv_file?.[0] || null;
        if (multipartCvFile && req.headers['x-cv-checksum']) {
            const actual = crypto.createHash('sha256').update(multipartCvFile.buffer).digest('hex');
            if (actual !== req.headers['x-cv-checksum']) {
                logger.warn(`CV checksum mismatch: expected=${req.headers['x-cv-checksum']}, actual=${actual}`);
                return res.status(400).json({ error: 'CV file checksum mismatch — file corrupted in transit' });
            }
            logger.debug(`CV checksum verified: ${actual.substring(0, 16)}...`);
        }

        next();
    },
    validateIntakePayload,
    async (req, res) => {
        const idempotencyKey = req.headers['x-idempotency-key'];

        // ── Idempotency check: reject duplicate submissions ──────────────
        if (idempotencyKey) {
            try {
                const idempSQL = isMySQL
                    ? 'SELECT candidate_id, application_id, status FROM chatbot_intake_log WHERE idempotency_key = ? LIMIT 1'
                    : 'SELECT candidate_id, application_id, status FROM chatbot_intake_log WHERE idempotency_key = $1 LIMIT 1';
                const idempResult = await query(idempSQL, [idempotencyKey]);
                if (idempResult.rows.length > 0) {
                    const prev = idempResult.rows[0];
                    logger.info(`Chatbot intake: idempotent replay for key ${idempotencyKey.substring(0, 12)}...`);
                    return res.status(200).json({
                        status: 'already_processed',
                        candidate_id: prev.candidate_id,
                        application_id: prev.application_id,
                        message: 'This submission was already processed (idempotency key match)'
                    });
                }
            } catch (idempErr) {
                // Table might not exist yet — log and continue (non-blocking)
                logger.warn(`Idempotency check skipped (table may not exist): ${idempErr.message}`);
            }
        }

        const {
            phone,
            name,
            email,
            preferred_language: raw_preferred_language = 'en',
            source = 'whatsapp',
            experience_years,
            highest_qualification,
            job_interest,
            destination_country,
            cv_file_path,
            cv_base64,
            cv_file_name,
            cv_raw_text,
            cv_parsed_data,
            additional_documents,
            job_id: providedJobId,
            ad_ref,
            chatbot_candidate_id
        } = req.body;

        const multipartCvFile = req.files?.cv_file?.[0] || null;
        const multipartAdditionalFiles = Array.isArray(req.files?.additional_files)
            ? req.files.additional_files
            : [];

        const hasMultipartCV = Boolean(multipartCvFile && multipartCvFile.buffer);
        const additionalDocumentsFromPayload = parseAdditionalDocuments(additional_documents);
        const requireCvForChatbot = process.env.CHATBOT_REQUIRE_CV !== 'false';
        const hasAnyCvPayload = Boolean(cv_file_path || cv_base64 || hasMultipartCV);

        if (requireCvForChatbot && hasAnyCvPayload === false) {
            logger.warn('Chatbot intake: rejected candidate onboarding because CV payload is missing');
            return res.status(422).json({
                success: false,
                error: 'CV file is required for chatbot onboarding.',
                code: 'cv_required'
            });
        }

        // `skills` needs to be mutable so we can fall back to cv_parsed_data.technical_skills
        let skills = req.body.skills;

        // ── Normalize language: singlish→si, tanglish→ta ─────────────────────
        const LANG_NORMALISE_MAP = { singlish: 'si', tanglish: 'ta' };
        const preferred_language = LANG_NORMALISE_MAP[raw_preferred_language] || raw_preferred_language || 'en';
        const language_register = raw_preferred_language; // keep the precise register

        const normalizedPhone = normalizePhone(phone);

        try {
            // ── Step 1: Lookup existing candidate by phone ─────────────────
            let existingCandidate = null;
            const lookupSQL = isMySQL
                ? 'SELECT id, name, status, metadata FROM candidates WHERE phone = ? OR whatsapp_phone = ? LIMIT 1'
                : 'SELECT id, name, status, metadata FROM candidates WHERE phone = $1 OR whatsapp_phone = $2 LIMIT 1';

            const lookupResult = await query(lookupSQL, [normalizedPhone, normalizedPhone]);
            existingCandidate = lookupResult.rows.length > 0 ? lookupResult.rows[0] : null;

            let existingMetadata = {};
            if (existingCandidate && existingCandidate.metadata) {
                try {
                    existingMetadata = typeof existingCandidate.metadata === 'string'
                        ? JSON.parse(existingCandidate.metadata)
                        : existingCandidate.metadata;
                } catch (e) { }
            }

            let metadataUpdates = {};
            if (cv_parsed_data) {
                if (cv_parsed_data.mismatches) metadataUpdates.mismatches = cv_parsed_data.mismatches;
                if (cv_parsed_data.age != null) metadataUpdates.age = cv_parsed_data.age;
                if (cv_parsed_data.height_cm != null) metadataUpdates.height_cm = cv_parsed_data.height_cm;
                // Store the precise language register (singlish/tanglish/si/ta/en)
                if (cv_parsed_data.language_register) {
                    metadataUpdates.language_register = cv_parsed_data.language_register;
                }
                // Store experience_years from CV parsed data in metadata for UI display
                const cvExp = cv_parsed_data.total_experience_years ?? cv_parsed_data.experience_years;
                if (cvExp != null) metadataUpdates.experience_years = cvExp;

                // Fallback: derive skills string from CV's technical_skills if top-level skills is missing
                if (!skills && cv_parsed_data.technical_skills) {
                    const ts = cv_parsed_data.technical_skills;
                    skills = Array.isArray(ts) ? ts.join(', ') : String(ts);
                }
            }
            // Also capture language_register from top-level if not already in cv_parsed_data
            if (!metadataUpdates.language_register && language_register) {
                metadataUpdates.language_register = language_register;
            }

            // Always store the candidate's stated job interest and destination in metadata
            // so recruiters can see it in the CV Manager even when no job_id is matched
            if (job_interest) {
                metadataUpdates.job_interest_stated = job_interest.trim();
            }
            if (destination_country) {
                metadataUpdates.destination_country = destination_country.trim();
            }

            // Propagate future_pool flag set by the chatbot (unmatched job role)
            if (cv_parsed_data && cv_parsed_data.future_pool) {
                metadataUpdates.future_pool = true;
                metadataUpdates.future_pool_role = cv_parsed_data.future_pool_role || job_interest || '';
            }

            const mergedMetadata = { ...existingMetadata, ...metadataUpdates };
            // Produce a valid JSON value (never the string "null")
            const metadataJson = Object.keys(mergedMetadata).length > 0
                ? JSON.stringify(mergedMetadata)
                : null;

            let candidateId;
            let responseStatus;

            if (existingCandidate) {
                // ── Step 2a: UPDATE existing candidate ─────────────────────
                candidateId = existingCandidate.id;
                responseStatus = 'updated';

                const updateSQL = isMySQL
                    ? `UPDATE candidates SET
                        name                 = COALESCE(?, name),
                        email                = COALESCE(?, email),
                        preferred_language   = ?,
                        skills               = COALESCE(?, skills),
                        experience_years     = COALESCE(?, experience_years),
                        highest_qualification = COALESCE(?, highest_qualification),
                        whatsapp_phone       = ?,
                        chatbot_ref          = COALESCE(?, chatbot_ref),
                        ad_ref               = COALESCE(?, ad_ref),
                        metadata             = ?,
                        last_contact_at      = NOW(),
                        updated_at           = NOW()
                       WHERE id = ?`
                    : `UPDATE candidates SET
                        name                 = COALESCE($1, name),
                        email                = COALESCE($2, email),
                        preferred_language   = $3,
                        skills               = COALESCE($4, skills),
                        experience_years     = COALESCE($5, experience_years),
                        highest_qualification = COALESCE($6, highest_qualification),
                        whatsapp_phone       = $7,
                        chatbot_ref          = COALESCE($8, chatbot_ref),
                        ad_ref               = COALESCE($9, ad_ref),
                        metadata             = $10,
                        last_contact_at      = NOW(),
                        updated_at           = NOW()
                       WHERE id = $11`;

                await query(updateSQL, [
                    name?.trim() || null,
                    email?.trim() || null,
                    preferred_language,
                    skills || null,
                    (experience_years != null && !isNaN(parseInt(experience_years, 10))) ? parseInt(experience_years, 10) : null,
                    highest_qualification || null,
                    normalizedPhone,
                    chatbot_candidate_id ? String(chatbot_candidate_id) : null,
                    ad_ref || null,
                    metadataJson,   // unified JSON string or null — no double-stringify
                    candidateId
                ]);

                logger.info(`Chatbot intake: UPDATED candidate ${candidateId} (${normalizedPhone})`);
            } else {
                // ── Step 2b: INSERT new candidate ──────────────────────────
                responseStatus = 'created';
                candidateId = generateUUID();

                const insertSQL = isMySQL
                    ? `INSERT INTO candidates
                        (id, phone, whatsapp_phone, name, email, source, preferred_language,
                         skills, experience_years, highest_qualification,
                         chatbot_ref, ad_ref, metadata, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NOW(), NOW())`
                    : `INSERT INTO candidates
                        (id, phone, whatsapp_phone, name, email, source, preferred_language,
                         skills, experience_years, highest_qualification,
                         chatbot_ref, ad_ref, metadata, status)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'new')`;

                await query(insertSQL, [
                    candidateId,
                    normalizedPhone,
                    normalizedPhone,
                    name.trim(),
                    email?.trim() || null,
                    source || 'whatsapp',
                    preferred_language,
                    skills || null,
                    (experience_years != null && !isNaN(parseInt(experience_years, 10))) ? parseInt(experience_years, 10) : null,
                    highest_qualification || null,
                    chatbot_candidate_id ? String(chatbot_candidate_id) : null,
                    ad_ref || null,
                    metadataJson    // unified JSON string or null — no double-stringify
                ]);

                logger.info(`Chatbot intake: CREATED candidate ${candidateId} (${normalizedPhone})`);
            }

            // ── Step 3: Create CV + additional document records ─────────────
            let cvFileId = null;
            const additionalDocumentIds = [];

            const insertDocumentRecord = async ({
                category,
                inputFileUrl,
                inputFileName,
                inputBase64,
                inputRawText,
                inputParsedData,
                multipartFile
            }) => {
                const recordId = generateUUID();
                const normalizedIncomingUrl = normalizeIncomingCvUrl(inputFileUrl, candidateId);
                let savedFileUrl = normalizedIncomingUrl;
                let savedFileName = inputFileName || (inputFileUrl ? inputFileUrl.split('/').pop() : `${category}_${normalizedPhone}.pdf`);
                const hasPhysicalPayload = Boolean(multipartFile || inputBase64 || inputFileUrl);

                if (multipartFile?.buffer) {
                    try {
                        const uploadDir = process.env.UPLOAD_DIR || null;
                        const fileBase64 = multipartFile.buffer.toString('base64');
                        savedFileName = multipartFile.originalname || savedFileName;
                        const { url: storedUrl, name: storedName } = await saveCVFile(
                            fileBase64,
                            savedFileName,
                            candidateId,
                            uploadDir
                        );
                        if (storedUrl) {
                            savedFileUrl = storedUrl;
                            savedFileName = storedName;
                            logger.info(`Chatbot intake: ${category} (multipart) stored at ${savedFileUrl}`);
                        }
                    } catch (err) {
                        logger.error(`Chatbot intake: Failed to save multipart ${category} — ${err.message}`);
                    }
                } else if (inputBase64) {
                    try {
                        const uploadDir = process.env.UPLOAD_DIR || null;
                        const { url: storedUrl, name: storedName } = await saveCVFile(
                            inputBase64,
                            savedFileName,
                            candidateId,
                            uploadDir
                        );
                        if (storedUrl) {
                            savedFileUrl = storedUrl;
                            savedFileName = storedName;
                            logger.info(`Chatbot intake: ${category} stored at ${savedFileUrl}`);
                        }
                    } catch (err) {
                        logger.error(`Chatbot intake: Failed to save ${category} — ${err.message}`);
                    }
                }

                const hasRetrievableUrl =
                    typeof savedFileUrl === 'string' &&
                    (savedFileUrl.startsWith('http://') || savedFileUrl.startsWith('https://') || savedFileUrl.startsWith('/'));

                if (hasPhysicalPayload && !hasRetrievableUrl) {
                    throw new Error(`${category}_storage_unretrievable`);
                }

                const documentParsedData = withDocumentCategory(inputParsedData, category);
                const detectedFileType = inferFileType(savedFileName);
                const isPrimary = category === 'cv';

                const cvInsertSQL = isMySQL
                    ? `INSERT INTO cv_files
                        (id, candidate_id, file_url, file_name, file_type,
                         ocr_status, ocr_text, parsed_data, uploaded_at, is_primary)
                       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, NOW(), ?)`
                    : `INSERT INTO cv_files
                        (id, candidate_id, file_url, file_name, file_type,
                         ocr_status, ocr_text, parsed_data, is_primary)
                       VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8)`;

                await query(cvInsertSQL, [
                    recordId,
                    candidateId,
                    savedFileUrl,
                    savedFileName,
                    detectedFileType,
                    inputRawText || null,
                    JSON.stringify(documentParsedData),
                    isPrimary
                ]);

                return recordId;
            };

            if (cv_file_path || cv_raw_text || cv_parsed_data || cv_base64 || hasMultipartCV) {
                try {
                    cvFileId = await insertDocumentRecord({
                        category: 'cv',
                        inputFileUrl: cv_file_path,
                        inputFileName: cv_file_name || (cv_file_path ? cv_file_path.split('/').pop() : `chatbot_cv_${normalizedPhone}.pdf`),
                        inputBase64: cv_base64,
                        inputRawText: cv_raw_text,
                        inputParsedData: cv_parsed_data,
                        multipartFile: multipartCvFile
                    });
                } catch (err) {
                    if (err.message === 'cv_storage_unretrievable') {
                        logger.error(`Chatbot intake: rejecting onboarding for ${candidateId} because CV storage URL is not retrievable`);
                        return res.status(422).json({
                            success: false,
                            error: 'CV upload received but file URL is not retrievable. Please retry upload.',
                            candidate_id: candidateId,
                            code: 'cv_storage_unretrievable'
                        });
                    }
                    throw err;
                }
            }

            const additionalDocInputs = [
                ...additionalDocumentsFromPayload,
                ...multipartAdditionalFiles.map((file) => ({
                    file_name: file.originalname,
                    multipart_file: file
                }))
            ];

            for (const doc of additionalDocInputs) {
                const docName = doc.file_name || doc.name || 'additional_document';
                const docId = await insertDocumentRecord({
                    category: 'additional',
                    inputFileUrl: doc.file_url || doc.file_path || null,
                    inputFileName: docName,
                    inputBase64: doc.file_base64 || doc.base64 || null,
                    inputRawText: doc.raw_text || null,
                    inputParsedData: doc.parsed_data || null,
                    multipartFile: doc.multipart_file || null,
                });
                additionalDocumentIds.push(docId);
            }

            // ── Step 4: Resolve job_id from ad_ref or job lookup ───────────
            let resolvedJobId = providedJobId || null;

            if (!resolvedJobId && ad_ref) {
                // Find job_id from ad_tracking
                const adSQL = isMySQL
                    ? 'SELECT job_id FROM ad_tracking WHERE ad_ref = ? AND is_active = 1 LIMIT 1'
                    : 'SELECT job_id FROM ad_tracking WHERE ad_ref = $1 AND is_active = TRUE LIMIT 1';
                const adResult = await query(adSQL, [ad_ref]);
                if (adResult.rows.length > 0) {
                    resolvedJobId = adResult.rows[0].job_id;
                }
            }

            if (!resolvedJobId && job_interest) {
                // Best-effort: find active job by title match
                const jobSQL = isMySQL
                    ? `SELECT id FROM jobs
                       WHERE status = 'active'
                         AND (title LIKE ? OR title LIKE ?)
                       LIMIT 1`
                    : `SELECT id FROM jobs
                       WHERE status = 'active'
                         AND (title ILIKE $1 OR title ILIKE $2)
                       LIMIT 1`;
                const searchTerm = `%${job_interest.trim()}%`;
                const wordSearch = `%${job_interest.trim().split(' ')[0]}%`;
                const jobResult = await query(jobSQL, [searchTerm, wordSearch]);
                if (jobResult.rows.length > 0) {
                    resolvedJobId = jobResult.rows[0].id;
                    logger.info(`Chatbot intake: fuzzy-matched job "${job_interest}" → ${resolvedJobId}`);
                }
            }

            // ── Step 5: Create application record ─────────────────────────
            let applicationId = null;
            if (resolvedJobId) {
                // Check for duplicate application
                const dupSQL = isMySQL
                    ? 'SELECT id FROM applications WHERE candidate_id = ? AND job_id = ? LIMIT 1'
                    : 'SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2 LIMIT 1';
                const dupResult = await query(dupSQL, [candidateId, resolvedJobId]);

                if (dupResult.rows.length > 0) {
                    applicationId = dupResult.rows[0].id;
                    logger.info(`Chatbot intake: application already exists ${applicationId}`);
                } else {
                    applicationId = generateUUID();
                    const appSQL = isMySQL
                        ? `INSERT INTO applications
                            (id, candidate_id, job_id, status, applied_at,
                             metadata)
                           VALUES (?, ?, ?, 'applied', NOW(), ?)`
                        : `INSERT INTO applications
                            (id, candidate_id, job_id, status,
                             metadata)
                           VALUES ($1, $2, $3, 'applied', $4)`;

                    await query(appSQL, [
                        applicationId,
                        candidateId,
                        resolvedJobId,
                        JSON.stringify({
                            source: 'whatsapp_chatbot',
                            ad_ref: ad_ref || null,
                            destination_country: destination_country || null,
                            job_interest_stated: job_interest,
                            cv_file_id: cvFileId,
                            additional_document_ids: additionalDocumentIds
                        })
                    ]);

                    logger.info(`Chatbot intake: CREATED application ${applicationId} for candidate ${candidateId}`);
                }
            }

            // ── Step 5b: Set future_pool status when no job matched ────────
            // When the chatbot marks a candidate as future_pool (requested role not available),
            // update their status so recruiters can find them in the Future Pool view.
            if (!resolvedJobId && cv_parsed_data && cv_parsed_data.future_pool) {
                const futurePoolSQL = isMySQL
                    ? `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = ? AND status = 'new'`
                    : `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1 AND status = 'new'`;
                await query(futurePoolSQL, [candidateId]).catch(err =>
                    logger.warn(`Failed to set future_pool status for candidate ${candidateId}: ${err.message}`)
                );
                logger.info(`Chatbot intake: candidate ${candidateId} set to future_pool (requested role: "${cv_parsed_data.future_pool_role || job_interest}")`);
            }

            // ── Step 6: Increment ad_tracking conversions ──────────────────
            if (ad_ref && responseStatus === 'created') {
                const adUpdateSQL = isMySQL
                    ? 'UPDATE ad_tracking SET conversions = conversions + 1, updated_at = NOW() WHERE ad_ref = ?'
                    : 'UPDATE ad_tracking SET conversions = conversions + 1, updated_at = NOW() WHERE ad_ref = $1';
                await query(adUpdateSQL, [ad_ref]).catch(err =>
                    logger.warn(`Failed to increment conversion for ad_ref ${ad_ref}: ${err.message}`)
                );
            }

            // ── Step 7: Log inbound communication ─────────────────────────
            const commId = generateUUID();
            const commSQL = isMySQL
                ? `INSERT INTO communications
                    (id, candidate_id, channel, direction, message_type, content, metadata, sent_at)
                   VALUES (?, ?, 'whatsapp', 'inbound', 'document', 'CV and application submitted via chatbot', ?, NOW())`
                : `INSERT INTO communications
                    (id, candidate_id, channel, direction, message_type, content, metadata)
                   VALUES ($1, $2, 'whatsapp', 'inbound', 'document', 'CV and application submitted via chatbot', $3)`;

            await query(commSQL, [
                commId,
                candidateId,
                JSON.stringify({
                    source: 'chatbot_intake',
                    ad_ref: ad_ref || null,
                    job_interest,
                    destination_country: destination_country || null,
                    cv_file_id: cvFileId,
                    additional_document_ids: additionalDocumentIds
                })
            ]).catch(err => logger.warn(`Failed to log communication: ${err.message}`));
            // ── Step 8: Log idempotency key for replay protection ─────────
            if (idempotencyKey) {
                try {
                    const logSQL = isMySQL
                        ? `INSERT INTO chatbot_intake_log
                            (id, idempotency_key, candidate_id, application_id, status, created_at)
                           VALUES (?, ?, ?, ?, ?, NOW())
                           ON DUPLICATE KEY UPDATE updated_at = NOW()`
                        : `INSERT INTO chatbot_intake_log
                            (id, idempotency_key, candidate_id, application_id, status)
                           VALUES ($1, $2, $3, $4, $5)
                           ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()`;
                    await query(logSQL, [
                        generateUUID(),
                        idempotencyKey,
                        candidateId,
                        applicationId,
                        responseStatus
                    ]);
                } catch (logErr) {
                    logger.warn(`Failed to log idempotency key: ${logErr.message}`);
                }
            }

            // ── Step 9: Recruiter alert + duplicate check (async) ─────────────
            setImmediate(async () => {
                try {
                    // Fetch the candidate record for alert context
                    const candRow = await query(
                        isMySQL
                            ? 'SELECT id, name, phone FROM candidates WHERE id = ? LIMIT 1'
                            : 'SELECT id, name, phone FROM candidates WHERE id = $1 LIMIT 1',
                        [candidateId]
                    ).then(r => r.rows[0]).catch(() => null);

                    // Find job title for alert context
                    let jobTitle = job_interest;
                    if (resolvedJobId) {
                        const jr = await query(
                            isMySQL ? 'SELECT title FROM jobs WHERE id = ? LIMIT 1'
                                : 'SELECT title FROM jobs WHERE id = $1 LIMIT 1',
                            [resolvedJobId]
                        ).catch(() => ({ rows: [] }));
                        if (jr.rows.length > 0) jobTitle = jr.rows[0].title;
                    }

                    // Notify recruiters of new candidate
                    await recruiterAlert('new_candidate', {
                        candidate: candRow,
                        jobTitle,
                        matchScore: null,
                        adRef: ad_ref || null
                    }, resolvedJobId);

                    // Auto-check for duplicates on newly created candidates
                    if (responseStatus === 'created') {
                        const dup = await checkForDuplicate(candidateId, 0.6);
                        if (dup) {
                            logger.warn(`Chatbot intake: potential duplicate detected for ${candidateId} — confidence ${dup.confidence}`);
                            await recruiterAlert('new_candidate', {
                                candidate: candRow,
                                jobTitle,
                                _duplicate_warning: `Possible duplicate of candidate ${dup.candidate.name} (${dup.candidate.phone}) — confidence ${Math.round(dup.confidence * 100)}%`,
                                matchScore: null,
                                adRef: ad_ref || null
                            }, resolvedJobId);
                        }
                    }
                } catch (alertErr) {
                    logger.warn(`Chatbot intake: recruiter alert failed — ${alertErr.message}`);
                }
            });
            // ── Response ───────────────────────────────────────────────────
            const httpStatus = responseStatus === 'created' ? 201 : 200;
            return res.status(httpStatus).json({
                status: responseStatus,
                candidate_id: candidateId,
                application_id: applicationId,
                cv_file_id: cvFileId,
                additional_document_ids: additionalDocumentIds,
                message: responseStatus === 'created'
                    ? 'Candidate created successfully'
                    : 'Candidate updated successfully'
            });

        } catch (error) {
            logger.error('Chatbot intake error:', error);

            // Handle duplicate phone (race condition)
            if (
                error.code === 'ER_DUP_ENTRY' ||
                (error.message && error.message.toLowerCase().includes('duplicate'))
            ) {
                return res.status(409).json({
                    error: 'Duplicate candidate',
                    detail: 'A candidate with this phone number already exists'
                });
            }

            return res.status(500).json({
                error: 'Internal server error',
                detail: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
);

// ── POST /api/chatbot/sync-message ────────────────────────────────────────────
// Receives a single chat message (inbound from candidate, or outbound bot reply)
// from the Python chatbot in real time and stores it in the communications table.
// Also emits a WebSocket event so live agents see the message immediately.
//
// Body: { phone, direction, content, message_type?, language?, chatbot_state? }
// Auth: x-chatbot-api-key header
router.post('/sync-message', chatbotLimiter, authenticateChatbot, async (req, res) => {
    const { phone, direction, content, message_type = 'text', language = 'en', chatbot_state = '' } = req.body;

    if (!phone || !direction || !content) {
        return res.status(400).json({ error: 'phone, direction, and content are required' });
    }
    if (!['inbound', 'outbound'].includes(direction)) {
        return res.status(400).json({ error: 'direction must be "inbound" or "outbound"' });
    }

    const normalizedPhone = phone.replace(/[\s\-()]/g, '');

    try {
        // Look up candidate by phone — needed for candidate_id FK
        const candResult = await query(
            isMySQL
                ? 'SELECT id, name FROM candidates WHERE phone = ? OR whatsapp_phone = ? LIMIT 1'
                : 'SELECT id, name FROM candidates WHERE phone = $1 OR whatsapp_phone = $2 LIMIT 1',
            [normalizedPhone, normalizedPhone]
        );

        let candidateId = null;
        let candidateName = null;
        if (candResult.rows.length > 0) {
            candidateId = candResult.rows[0].id;
            candidateName = candResult.rows[0].name;
        }

        // Insert into communications
        const commId = generateUUID();
        const senderType = direction === 'inbound' ? 'candidate' : 'bot';

        const insertSQL = isMySQL
            ? `INSERT INTO communications
               (id, candidate_id, channel, direction, message_type, content,
                sender_type, chatbot_state, detected_language, sent_at)
               VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, NOW())`
            : `INSERT INTO communications
               (id, candidate_id, channel, direction, message_type, content,
                sender_type, chatbot_state, detected_language)
               VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8)`;

        await query(insertSQL, [
            commId,
            candidateId,
            direction,
            message_type,
            content.slice(0, 4000),
            senderType,
            chatbot_state || null,
            language || null,
        ]);

        // Emit WebSocket event to agents watching this candidate
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io && candidateId) {
                io.to(`candidate:${candidateId}`).emit('new_message', {
                    id: commId,
                    candidate_id: candidateId,
                    candidate_name: candidateName,
                    channel: 'whatsapp',
                    direction,
                    message_type,
                    content: content.slice(0, 4000),
                    sender_type: senderType,
                    chatbot_state: chatbot_state || null,
                    detected_language: language || null,
                    sent_at: new Date().toISOString(),
                });
                // Also notify the global chat list that this candidate has new activity
                io.emit('chat_activity', {
                    candidate_id: candidateId,
                    candidate_name: candidateName,
                    phone: normalizedPhone,
                    last_message: content.slice(0, 80),
                    direction,
                    chatbot_state: chatbot_state || null,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            // WebSocket emit failure is non-critical
            logger.debug(`sync-message: WebSocket emit skipped — ${wsErr.message}`);
        }

        return res.status(201).json({ id: commId, candidate_id: candidateId });
    } catch (error) {
        logger.error('sync-message error:', error.message);
        return res.status(500).json({ error: 'Failed to store message', detail: error.message });
    }
});

module.exports = router;
