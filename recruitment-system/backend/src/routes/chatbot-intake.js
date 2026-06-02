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
const { saveCVFile, uploadToGCS } = require('../utils/gcs-upload');
const { isMySQL } = require('../utils/query-adapter');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const { recruiterAlert } = require('../services/recruiter-alerts');
const { checkForDuplicate } = require('../services/duplicate-detection');
const { searchKnowledgeBase } = require('../services/knowledge-base');
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
        // The chatbot caches ALL active jobs so it can always discuss/serve the
        // roles that exist — ad campaigns must NOT gate visibility (a job with
        // no ad_tracking row was previously invisible, which made the bot tell
        // every ad visitor "no active jobs"). `has_active_ad` is returned as
        // metadata (for attribution/ranking), not as a filter.
        const jobsSQL = isMySQL
            ? `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available, j.location, j.description,
                      j.is_urgent, j.required_fields_schema, j.created_at, j.updated_at,
                      p.id as project_id, p.countries, p.benefits, p.salary_info,
                      p.interview_date, p.start_date, p.title as project_title,
                      EXISTS (SELECT 1 FROM ad_tracking at
                               WHERE at.job_id = j.id AND at.is_active = 1) AS has_active_ad
               FROM jobs j
               LEFT JOIN projects p ON j.project_id = p.id
               WHERE j.status = 'active'
               ORDER BY j.created_at DESC`
            : `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available, j.location, j.description,
                      j.is_urgent, j.required_fields_schema, j.created_at, j.updated_at,
                      p.id as project_id, p.countries, p.benefits, p.salary_info,
                      p.interview_date, p.start_date, p.title as project_title,
                      EXISTS (SELECT 1 FROM ad_tracking at
                               WHERE at.job_id = j.id AND at.is_active = TRUE) AS has_active_ad
               FROM jobs j
               LEFT JOIN projects p ON j.project_id = p.id
               WHERE j.status = 'active'
               ORDER BY j.created_at DESC`;

        const result = await query(jobsSQL, []);
        const _parseJsonSafe = (v, fallback) => {
            if (!v) return fallback;
            if (typeof v === 'object') return v;
            try { return JSON.parse(v); } catch { return fallback; }
        };

        const jobs = result.rows.map(job => {
            const requirements = _parseJsonSafe(job.requirements, {});
            return {
                job_id: job.id,
                title: job.title,
                category: job.category,
                status: job.status,
                salary_range: job.salary_range,
                positions_available: job.positions_available,
                location: job.location || '',
                description: job.description || '',
                project_id: job.project_id,
                requirements,
                countries:      _parseJsonSafe(job.countries, []),
                benefits:       _parseJsonSafe(job.benefits, {}),
                salary_info:    _parseJsonSafe(job.salary_info, {}),
                start_date:     job.start_date     || null,
                interview_date: job.interview_date || null,
                project_title:  job.project_title  || null,
                is_urgent:      Boolean(job.is_urgent),
                required_fields_schema: _parseJsonSafe(job.required_fields_schema, {}),
                has_active_ad:  Boolean(job.has_active_ad),
                created_at:     job.created_at || null,
                updated_at:     job.updated_at || null,
            };
        });

        logger.info(`Chatbot jobs fetch: returned ${jobs.length} active advertised jobs`);
        return res.json({ jobs });
    } catch (error) {
        logger.error('Chatbot jobs fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch jobs', detail: error.message });
    }
});

// Tokenize a string into lowercase alphanumeric words for slug/title matching.
function _slugTokens(s) {
    return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Resolve a slug/title key (e.g. "security-officer-female-dubai") to the best
// matching job row by token overlap. The key may carry extra tokens (country),
// so we score by how much of the JOB TITLE is covered by the key's tokens.
function _resolveJobBySlug(key, rows) {
    const keyTokens = new Set(_slugTokens(key));
    if (keyTokens.size === 0) return null;
    let best = null;
    let bestScore = 0;
    for (const row of rows) {
        const titleTokens = _slugTokens(row.title);
        if (titleTokens.length === 0) continue;
        const matched = titleTokens.filter(t => keyTokens.has(t)).length;
        const score = matched / titleTokens.length;
        if (score > bestScore) { bestScore = score; best = row; }
    }
    // Require a solid majority of the title's words to appear in the key.
    return bestScore >= 0.6 ? best : null;
}

const JOB_INFO_SELECT = `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available, j.location, j.description,
                      j.is_urgent, j.required_fields_schema, j.created_at, j.updated_at,
                      p.id as project_id, p.countries, p.benefits, p.salary_info,
                      p.interview_date, p.start_date, p.title as project_title
                 FROM jobs j
                 LEFT JOIN projects p ON j.project_id = p.id`;

// ── GET /api/chatbot/job-info/:job_id ────────────────────────────────────────
// Live lookup for a single job by UUID *or* slug/title. The chatbot may pass a
// slugified title (the lookup_job_info tool), so we never blindly cast the key
// to uuid (that 500'd on every slug). UUIDs hit the row directly; everything
// else is fuzzy-matched against active jobs by title token overlap.
router.get('/job-info/:job_id', authenticateChatbot, async (req, res) => {
    const { job_id } = req.params;
    if (!job_id || job_id.length > 120) {
        return res.status(400).json({ error: 'Invalid job_id' });
    }
    try {
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        let job = null;
        if (UUID_RE.test(job_id)) {
            const sql = isMySQL
                ? `${JOB_INFO_SELECT} WHERE j.id = ?`
                : `${JOB_INFO_SELECT} WHERE j.id = $1::uuid`;
            const result = await query(sql, [job_id]);
            job = result.rows[0] || null;
        } else {
            const result = await query(`${JOB_INFO_SELECT} WHERE j.status = 'active'`, []);
            job = _resolveJobBySlug(job_id, result.rows);
        }
        if (!job) {
            return res.status(404).json({ error: 'Job not found', job_id });
        }
        const _parseJsonSafe = (v, fallback) => {
            if (!v) return fallback;
            if (typeof v === 'object') return v;
            try { return JSON.parse(v); } catch { return fallback; }
        };
        return res.json({
            job_id: job.id,
            title: job.title,
            category: job.category,
            status: job.status,
            salary_range: job.salary_range,
            positions_available: job.positions_available,
            location: job.location || '',
            description: job.description || '',
            project_id: job.project_id,
            requirements:           _parseJsonSafe(job.requirements, {}),
            countries:              _parseJsonSafe(job.countries, []),
            benefits:               _parseJsonSafe(job.benefits, {}),
            salary_info:            _parseJsonSafe(job.salary_info, {}),
            start_date:             job.start_date     || null,
            interview_date:         job.interview_date || null,
            project_title:          job.project_title  || null,
            is_urgent:              Boolean(job.is_urgent),
            required_fields_schema: _parseJsonSafe(job.required_fields_schema, {}),
            created_at:             job.created_at || null,
            updated_at:             job.updated_at || null,
        });
    } catch (error) {
        logger.error(`Chatbot job-info fetch error for ${job_id}:`, error);
        return res.status(500).json({ error: 'Failed to fetch job', detail: error.message });
    }
});

// ── GET /api/chatbot/general-info?q=... ──────────────────────────────────────
// Live lookup for non-job questions (registration fees, office hours, address,
// hotline, application process etc.). Searches the knowledge_base table and
// returns up to 3 multilingual results. When q is empty/missing, returns a
// small default packet (company address + hotline + registration fee) so the
// AI always has a fallback for "what is your office" style questions.
router.get('/general-info', authenticateChatbot, async (req, res) => {
    try {
        const raw = (req.query.q || '').toString().trim();
        const lang = ['en', 'si', 'ta'].includes(req.query.lang) ? req.query.lang : 'en';

        if (!raw) {
            // Default packet — fixed, non-hallucinated company facts.
            return res.json({
                query: '',
                language: lang,
                results: [
                    {
                        id: 'default_address',
                        category: 'company',
                        question: 'Where is your office?',
                        answer: process.env.DEWAN_OFFICE_ADDRESS
                            || 'Dewan Consultants, Colombo, Sri Lanka. See https://wa.me/94727533155 to reach us.'
                    },
                    {
                        id: 'default_hotline',
                        category: 'company',
                        question: 'What is your hotline?',
                        answer: process.env.DEWAN_HOTLINE || '+94 72 753 3155 (WhatsApp)'
                    },
                    {
                        id: 'default_fee',
                        category: 'application_process',
                        question: 'Is there a registration fee?',
                        answer: process.env.DEWAN_REGISTRATION_FEE
                            || 'There is no registration fee to apply through Dewan Consultants.'
                    }
                ]
            });
        }

        const kbHits = await searchKnowledgeBase(raw, lang, null, 3);
        const results = (kbHits || []).map(row => ({
            id: row.id,
            category: row.category,
            question: row[`question_${lang}`] || row.question_en,
            answer:   row[`answer_${lang}`]   || row.answer_en
        }));

        return res.json({ query: raw, language: lang, results });
    } catch (error) {
        logger.error('Chatbot general-info fetch error:', error);
        return res.status(500).json({ error: 'Failed to search general info', detail: error.message });
    }
});

// ── POST /api/chatbot/media-upload ───────────────────────────────────────────
// Re-hosts WhatsApp media (voice notes, images) the chatbot downloaded, so the
// conversation panel can play/show them. WhatsApp's own media URLs are
// auth-gated and not browser-playable, so the bot sends us the bytes (base64)
// and we return a public GCS URL to store as the message's media_url.
router.post('/media-upload', chatbotLimiter, authenticateChatbot, async (req, res) => {
    try {
        const { base64, filename = 'voice.ogg', phone = '', mime_type = 'audio/ogg' } = req.body || {};
        if (!base64 || typeof base64 !== 'string') {
            return res.status(400).json({ error: 'base64 is required' });
        }
        const safePhone = (phone || 'unknown').toString().replace(/[^0-9]/g, '') || 'unknown';
        const safeName = filename.toString().replace(/[^a-zA-Z0-9._-]/g, '_');
        const destPath = `voice/${safePhone}/${Date.now()}_${safeName}`;
        const buffer = Buffer.from(base64, 'base64');
        const url = await uploadToGCS(buffer, destPath, mime_type);
        if (!url) {
            return res.status(502).json({ error: 'media storage unavailable' });
        }
        return res.json({ url });
    } catch (error) {
        logger.error('Chatbot media-upload error:', error);
        return res.status(500).json({ error: 'Failed to store media', detail: error.message });
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

function isDuplicateConstraintError(error) {
    const msg = String(error?.message || '').toLowerCase();
    return error?.code === 'ER_DUP_ENTRY' || msg.includes('duplicate') || msg.includes('unique constraint');
}

function isMissingColumnError(error) {
    const msg = String(error?.message || '').toLowerCase();
    return (
        msg.includes('column') && msg.includes('does not exist')
    ) || msg.includes('unknown column');
}

function mapConversationStage(chatbotState, messageType, direction) {
    if (String(messageType || '').toLowerCase() === 'document') return 'cv_sent';

    const state = String(chatbotState || '').toUpperCase();
    if (state.includes('COMPLETED') || state.includes('DONE') || state.includes('FINAL')) return 'completed';
    if (state.includes('DROP') || state.includes('ABANDON')) return 'dropped';
    if (state.includes('CV') || state.includes('RESUME')) return 'cv_sent';
    if (direction === 'outbound') return 'responding';
    return 'new';
}

function isGenericCandidateName(value) {
    const v = String(value || '').trim().toLowerCase();
    if (!v) return true;
    return ['unknown', 'unknown candidate', 'candidate', 'n/a', 'na'].includes(v) || v.startsWith('whatsapp ');
}

function resolvePreferredCandidateName({ providedName, parsedData, fallbackPhone }) {
    const parsedName = String(parsedData?.name || parsedData?.full_name || '').trim();
    const typedName = String(providedName || '').trim();

    if (parsedName && !isGenericCandidateName(parsedName)) return parsedName;
    if (typedName && !isGenericCandidateName(typedName)) return typedName;
    return String(fallbackPhone || '').trim();
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

// Classify an uploaded document into cv / passport / certificate / photo using
// the extractor's document_type hint when present, else the shape of the
// parsed data (CVs carry work history / skills / experience; passports carry a
// passport number but no CV shape; certificates carry certifications only).
function classifyDocument(baseCategory, fileName, parsedData) {
    const pd = (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) ? parsedData : {};
    const dt = String(pd.document_type || '').toLowerCase();
    if (['cv', 'resume'].includes(dt)) return 'cv';
    if (['passport', 'id', 'nic'].includes(dt)) return 'passport';
    if (['certificate', 'license', 'licence', 'diploma'].includes(dt)) return 'certificate';
    if (dt === 'photo') return 'photo';

    const hasCvShape = (Array.isArray(pd.work_history) && pd.work_history.length > 0)
        || (Array.isArray(pd.technical_skills) && pd.technical_skills.length > 0)
        || (pd.total_experience_years != null && Number(pd.total_experience_years) > 0)
        || Boolean(pd.current_job_title)
        || Boolean(pd.highest_qualification);
    if (hasCvShape) return 'cv';
    if (pd.passport_number) return 'passport';
    if (Array.isArray(pd.certifications) && pd.certifications.length > 0) return 'certificate';
    const name = String(fileName || '').toLowerCase();
    if (/passport/.test(name)) return 'passport';
    if (/(certificate|cert|licen|diploma)/.test(name)) return 'certificate';
    return baseCategory;
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
 *   is_general_pool    boolean optional  (route candidate to general pool instead of strict applications)
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
            is_general_pool,
            chatbot_candidate_id,
            remarks,
            preferences_log
        } = req.body;

        const isGeneralPool = (
            is_general_pool === true ||
            String(is_general_pool || '').toLowerCase() === 'true'
        );

        const multipartCvFile = req.files?.cv_file?.[0] || null;
        const multipartAdditionalFiles = Array.isArray(req.files?.additional_files)
            ? req.files.additional_files
            : [];

        const hasMultipartCV = Boolean(multipartCvFile && multipartCvFile.buffer);
        const additionalDocumentsFromPayload = parseAdditionalDocuments(additional_documents);
        // CV is NOT required by default: the chatbot saves partial leads as soon
        // as a name is known (CV optional, unknown-job → general pool). Requiring
        // a CV here would 422-reject every name-only / general-pool sync. Opt in
        // with CHATBOT_REQUIRE_CV='true' only if a CV-gated flow is ever needed.
        const requireCvForChatbot = process.env.CHATBOT_REQUIRE_CV === 'true';
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
        const resolvedCandidateName = resolvePreferredCandidateName({
            providedName: name,
            parsedData: cv_parsed_data,
            fallbackPhone: normalizedPhone,
        });

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

            // Be permissive about payload shape: the chatbot has shipped at
            // least three different envelope conventions over time. Accept
            // each field at the top level OR nested inside cv_parsed_data,
            // preferring the more-structured CV-parsed value when both exist.
            const topLevel = req.body || {};
            const parsed = cv_parsed_data || {};

            const firstDefined = (...vals) => {
                for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
                return undefined;
            };

            // Numeric coercion that tolerates strings like "27" / "175cm".
            const toIntOrNull = (v) => {
                if (v === undefined || v === null || v === '') return null;
                const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
                return Number.isFinite(n) ? n : null;
            };

            // Diagnostic log — keys only, NOT values, so PII stays out of the
            // logs. Helps trace which envelope the chatbot is currently
            // sending when CV manager rows look incomplete.
            logger.info(
                `Chatbot intake payload keys=${Object.keys(topLevel).join(',')} ` +
                `parsedKeys=${Object.keys(parsed || {}).join(',')}`
            );

            let metadataUpdates = {};

            // Age: cv_parsed_data.age || top-level age (some chatbot builds)
            const ageVal = toIntOrNull(firstDefined(parsed.age, topLevel.age, parsed.age_years));
            if (ageVal != null) metadataUpdates.age = ageVal;

            // Height: try cm-specific first, fall back to a generic "height".
            const heightVal = toIntOrNull(
                firstDefined(parsed.height_cm, topLevel.height_cm, parsed.height, topLevel.height)
            );
            if (heightVal != null) metadataUpdates.height_cm = heightVal;

            // Gender — normalised to male/female so the auto-assign matcher can
            // use it as a hard filter (B013). Tolerates m/f and word variants.
            const rawGender = firstDefined(parsed.gender, topLevel.gender);
            if (rawGender != null) {
                const g = String(rawGender).trim().toLowerCase();
                if (['m', 'male', 'man', 'boy'].includes(g)) metadataUpdates.gender = 'male';
                else if (['f', 'female', 'woman', 'girl'].includes(g)) metadataUpdates.gender = 'female';
            }

            // Mismatches — only ever nested under cv_parsed_data.
            if (parsed.mismatches) metadataUpdates.mismatches = parsed.mismatches;

            // Language register (singlish/tanglish/si/ta/en).
            if (parsed.language_register) {
                metadataUpdates.language_register = parsed.language_register;
            } else if (language_register) {
                metadataUpdates.language_register = language_register;
            }

            // Experience years — multiple aliases observed in the wild.
            const cvExp = toIntOrNull(firstDefined(
                parsed.total_experience_years,
                parsed.experience_years,
                topLevel.experience_years,
            ));
            if (cvExp != null) metadataUpdates.experience_years = cvExp;

            // Skills — top-level wins, then technical_skills, then skills array.
            if (!skills) {
                const skillsSource = firstDefined(parsed.technical_skills, parsed.skills, topLevel.skills_list);
                if (skillsSource) {
                    skills = Array.isArray(skillsSource) ? skillsSource.join(', ') : String(skillsSource);
                }
            }

            // Always store the candidate's stated job interest and destination in metadata
            // so recruiters can see it in the CV Manager even when no job_id is matched
            if (job_interest) {
                metadataUpdates.job_interest_stated = job_interest.trim();
            }
            if (destination_country) {
                metadataUpdates.destination_country = destination_country.trim();
            }

            if (isGeneralPool) {
                metadataUpdates.is_general_pool = true;
            }

            // Propagate future_pool flag set by the chatbot (unmatched job role)
            if (cv_parsed_data && cv_parsed_data.future_pool) {
                metadataUpdates.future_pool = true;
                metadataUpdates.future_pool_role = cv_parsed_data.future_pool_role || job_interest || '';
            }

            // Per-job collected fields the chatbot's ad-flow now forwards
            // (passport, NIC, DOB, English proficiency, alternate phone,
            // licences, previous employer). Stored on candidates.metadata so
            // recruiters can see the full profile in CV Manager without
            // schema migrations. Accept both top-level and cv_parsed_data
            // envelopes — the chatbot ships them in both places.
            const PER_JOB_META_FIELDS = [
                'passport_number',
                'nic',
                'date_of_birth',
                'dob',
                'english_proficiency',
                'phone_alternative',
                'licenses',
                'previous_employer',
            ];
            for (const field of PER_JOB_META_FIELDS) {
                const val = firstDefined(parsed[field], topLevel[field]);
                if (val !== undefined) {
                    metadataUpdates[field] = val;
                }
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

                // remarks: COALESCE preserves prior remarks if the new payload omits it
                // preferences_log: append-only — if the new payload sends an array, we
                //   merge with the existing log via JSONB concatenation in Postgres so
                //   recruiters can see the full timeline of declared preferences.
                const preferencesLogJson = Array.isArray(preferences_log) && preferences_log.length > 0
                    ? JSON.stringify(preferences_log)
                    : null;

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
                        remarks              = COALESCE(?, remarks),
                        preferences_log      = COALESCE(JSON_MERGE_PRESERVE(preferences_log, ?), preferences_log),
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
                        remarks              = COALESCE($11, remarks),
                        preferences_log      = COALESCE(preferences_log, '[]'::jsonb) || COALESCE($12::jsonb, '[]'::jsonb),
                        last_contact_at      = NOW(),
                        updated_at           = NOW()
                       WHERE id = $13`;

                await query(updateSQL, [
                    resolvedCandidateName || null,
                    email?.trim() || null,
                    preferred_language,
                    skills || null,
                    (experience_years != null && !isNaN(parseInt(experience_years, 10))) ? parseInt(experience_years, 10) : null,
                    highest_qualification || null,
                    normalizedPhone,
                    chatbot_candidate_id ? String(chatbot_candidate_id) : null,
                    ad_ref || null,
                    metadataJson,   // unified JSON string or null — no double-stringify
                    remarks || null,
                    preferencesLogJson,
                    candidateId
                ]);

                logger.info(`Chatbot intake: UPDATED candidate ${candidateId} (${normalizedPhone})`);
            } else {
                // ── Step 2b: INSERT new candidate ──────────────────────────
                responseStatus = 'created';
                candidateId = generateUUID();

                const preferencesLogInsertJson = Array.isArray(preferences_log) && preferences_log.length > 0
                    ? JSON.stringify(preferences_log)
                    : '[]';

                const insertSQL = isMySQL
                    ? `INSERT INTO candidates
                        (id, phone, whatsapp_phone, name, email, source, preferred_language,
                         skills, experience_years, highest_qualification,
                         chatbot_ref, ad_ref, metadata, remarks, preferences_log, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NOW(), NOW())`
                    : `INSERT INTO candidates
                        (id, phone, whatsapp_phone, name, email, source, preferred_language,
                         skills, experience_years, highest_qualification,
                         chatbot_ref, ad_ref, metadata, remarks, preferences_log, status)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, 'new')`;

                await query(insertSQL, [
                    candidateId,
                    normalizedPhone,
                    normalizedPhone,
                    resolvedCandidateName,
                    email?.trim() || null,
                    source || 'whatsapp',
                    preferred_language,
                    skills || null,
                    (experience_years != null && !isNaN(parseInt(experience_years, 10))) ? parseInt(experience_years, 10) : null,
                    highest_qualification || null,
                    chatbot_candidate_id ? String(chatbot_candidate_id) : null,
                    ad_ref || null,
                    metadataJson,    // unified JSON string or null — no double-stringify
                    remarks || null,
                    preferencesLogInsertJson
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

                const refinedCategory = classifyDocument(category, savedFileName, inputParsedData);
                const documentParsedData = withDocumentCategory(inputParsedData, refinedCategory);
                const detectedFileType = inferFileType(savedFileName);
                const isPrimary = refinedCategory === 'cv';

                // Dedup TRUE duplicates only: same candidate + same file name.
                // Per-turn re-syncs and pending-sync retries re-send the SAME
                // file (stable name) → update in place. DISTINCT documents (CV,
                // passport, certificate) have different names → each gets its own
                // row, so multi-document candidates aren't collapsed.
                {
                    const existingCvSQL = isMySQL
                        ? 'SELECT id FROM cv_files WHERE candidate_id = ? AND file_name = ? ORDER BY uploaded_at DESC LIMIT 1'
                        : 'SELECT id FROM cv_files WHERE candidate_id = $1 AND file_name = $2 ORDER BY uploaded_at DESC LIMIT 1';
                    const existingCv = await query(existingCvSQL, [candidateId, savedFileName]);
                    if (existingCv.rows && existingCv.rows.length > 0) {
                        const existingId = existingCv.rows[0].id;
                        if (hasPhysicalPayload) {
                            // A new file arrived — replace file + parsed data.
                            const upSQL = isMySQL
                                ? "UPDATE cv_files SET file_url=?, file_name=?, file_type=?, ocr_status='completed', ocr_text=COALESCE(?, ocr_text), parsed_data=? WHERE id=?"
                                : "UPDATE cv_files SET file_url=$1, file_name=$2, file_type=$3, ocr_status='completed', ocr_text=COALESCE($4, ocr_text), parsed_data=$5 WHERE id=$6";
                            await query(upSQL, [savedFileUrl, savedFileName, detectedFileType, inputRawText || null, JSON.stringify(documentParsedData), existingId]);
                        } else {
                            // Only fresh parsed text/data — enrich without touching the file.
                            const upSQL = isMySQL
                                ? "UPDATE cv_files SET ocr_text=COALESCE(?, ocr_text), parsed_data=? WHERE id=?"
                                : "UPDATE cv_files SET ocr_text=COALESCE($1, ocr_text), parsed_data=$2 WHERE id=$3";
                            await query(upSQL, [inputRawText || null, JSON.stringify(documentParsedData), existingId]);
                        }
                        logger.info(`Chatbot intake: updated existing primary CV ${existingId} for ${candidateId}`);
                        return existingId;
                    }
                }

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

            // Only create/refresh a CV row when an ACTUAL document is present
            // (multipart file, base64, a retrievable URL, or extracted raw
            // text). cv_parsed_data alone is NOT a document — the chatbot ships
            // it on every turn-sync, and its fields already flow into
            // candidates.metadata above; creating a row for it spawned phantom
            // CVs with null file_url on each turn.
            if (cv_file_path || cv_raw_text || cv_base64 || hasMultipartCV) {
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

            // UUID fallback: ad_ref may itself be a job UUID (marketing pasted
            // the raw job UUID into the wa.me link instead of using a short
            // ad_tracking code). Mirror the public job-context endpoint so the
            // application row still gets created.
            if (!resolvedJobId && ad_ref && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ad_ref)) {
                const uuidSQL = isMySQL
                    ? `SELECT id FROM jobs WHERE id = ? AND status = 'active' LIMIT 1`
                    : `SELECT id FROM jobs WHERE id = $1::uuid AND status = 'active' LIMIT 1`;
                const uuidResult = await query(uuidSQL, [ad_ref]);
                if (uuidResult.rows.length > 0) {
                    resolvedJobId = uuidResult.rows[0].id;
                    logger.info(`Chatbot intake: resolved ad_ref UUID → job ${resolvedJobId}`);
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

            // ── Step 5: Create application record (strict) OR general pool entry ─────────────────────────
            let applicationId = null;
            if (isGeneralPool) {
                const poolMeta = {
                    source: 'whatsapp_chatbot',
                    ad_ref: ad_ref || null,
                    destination_country: destination_country || null,
                    job_interest_stated: job_interest || null,
                    cv_file_id: cvFileId,
                    additional_document_ids: additionalDocumentIds,
                    routed_by: 'agentic_state_machine',
                    // Surface the chatbot's free-text remarks + preference history
                    // here so recruiters reviewing the general pool see the WHY
                    // alongside the WHAT.
                    remarks: remarks || null,
                    preferences_log: Array.isArray(preferences_log) ? preferences_log : []
                };

                const existingPoolSQL = isMySQL
                    ? 'SELECT id FROM general_pool WHERE candidate_id = ? LIMIT 1'
                    : 'SELECT id FROM general_pool WHERE candidate_id = $1 LIMIT 1';
                const existingPoolResult = await query(existingPoolSQL, [candidateId]);

                if (existingPoolResult.rows.length > 0) {
                    const poolId = existingPoolResult.rows[0].id;
                    const updatePoolSQL = isMySQL
                        ? 'UPDATE general_pool SET source = ?, metadata = ?, updated_at = NOW() WHERE id = ?'
                        : 'UPDATE general_pool SET source = $1, metadata = $2, updated_at = NOW() WHERE id = $3';
                    await query(updatePoolSQL, [
                        'whatsapp_chatbot',
                        JSON.stringify(poolMeta),
                        poolId
                    ]);
                } else {
                    const insertPoolSQL = isMySQL
                        ? `INSERT INTO general_pool (id, candidate_id, source, metadata, created_at, updated_at)
                           VALUES (?, ?, ?, ?, NOW(), NOW())`
                        : `INSERT INTO general_pool (id, candidate_id, source, metadata)
                           VALUES ($1, $2, $3, $4)`;
                    await query(insertPoolSQL, [
                        generateUUID(),
                        candidateId,
                        'whatsapp_chatbot',
                        JSON.stringify(poolMeta)
                    ]);
                }

                const setFuturePoolSQL = isMySQL
                    ? `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = ?`
                    : `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1`;
                await query(setFuturePoolSQL, [candidateId]).catch(err =>
                    logger.warn(`Failed to set future_pool status for general-pool candidate ${candidateId}: ${err.message}`)
                );

                logger.info(`Chatbot intake: candidate ${candidateId} routed to general_pool`);
            } else if (resolvedJobId) {
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
    const {
        phone,
        direction,
        content,
        message_type = 'text',
        media_url = '',
        language = 'en',
        chatbot_state = '',
        pipeline_stage,
        whatsapp_message_id,
    } = req.body;

    if (!phone || !direction || !content) {
        return res.status(400).json({ error: 'phone, direction, and content are required' });
    }
    if (!['inbound', 'outbound'].includes(direction)) {
        return res.status(400).json({ error: 'direction must be "inbound" or "outbound"' });
    }

    const normalizedPhone = normalizePhone(phone);
    const safeContent = typeof content === 'string' ? content : JSON.stringify(content);
    const LANG_NORMALISE_MAP = { singlish: 'si', tanglish: 'ta' };
    const preferredLanguage = LANG_NORMALISE_MAP[String(language || 'en').toLowerCase()] || (language || 'en');
    const conversationStage = pipeline_stage || mapConversationStage(chatbot_state, message_type, direction);

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
        } else {
            // Keep chat sync resilient: create a lightweight candidate shell if missing.
            candidateId = generateUUID();
            candidateName = normalizedPhone;

            const insertCandidateSQL = isMySQL
                ? `INSERT INTO candidates
                   (id, phone, whatsapp_phone, name, source, preferred_language, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'whatsapp', ?, 'new', NOW(), NOW())`
                : `INSERT INTO candidates
                   (id, phone, whatsapp_phone, name, source, preferred_language, status)
                   VALUES ($1, $2, $3, $4, 'whatsapp', $5, 'new')`;

            try {
                await query(insertCandidateSQL, [
                    candidateId,
                    normalizedPhone,
                    normalizedPhone,
                    candidateName,
                    preferredLanguage,
                ]);
                logger.info(`sync-message: auto-created candidate ${candidateId} (${normalizedPhone})`);
            } catch (insertErr) {
                // Another request may have created the candidate first.
                if (!isDuplicateConstraintError(insertErr)) {
                    throw insertErr;
                }

                const existingResult = await query(
                    isMySQL
                        ? 'SELECT id, name FROM candidates WHERE phone = ? OR whatsapp_phone = ? LIMIT 1'
                        : 'SELECT id, name FROM candidates WHERE phone = $1 OR whatsapp_phone = $2 LIMIT 1',
                    [normalizedPhone, normalizedPhone]
                );

                if (!existingResult.rows.length) {
                    throw insertErr;
                }

                candidateId = existingResult.rows[0].id;
                candidateName = existingResult.rows[0].name;
                logger.info(`sync-message: candidate existed after race ${candidateId} (${normalizedPhone})`);
            }
        }

        // Insert into communications
        const commId = generateUUID();
        const senderType = direction === 'inbound' ? 'candidate' : 'bot';
        const metadataJson = JSON.stringify({
            sender_type: senderType,
            chatbot_state: chatbot_state || null,
            detected_language: language || null,
            // media_url lives in metadata so voice/image/document messages are
            // playable/openable in the conversation panel without a schema change.
            media_url: media_url || null,
        });

        const insertWithMessageIdSQL = isMySQL
            ? `INSERT INTO communications
               (id, candidate_id, channel, direction, message_type, content, metadata, sender_type, whatsapp_message_id)
               VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?)`
            : `INSERT INTO communications
               (id, candidate_id, channel, direction, message_type, content, metadata, sender_type, whatsapp_message_id)
               VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8)`;

        try {
            await query(insertWithMessageIdSQL, [
                commId,
                candidateId,
                direction,
                message_type,
                safeContent.slice(0, 4000),
                metadataJson,
                senderType,
                whatsapp_message_id || null,
            ]);
        } catch (insertErr) {
            if (!isMissingColumnError(insertErr)) {
                throw insertErr;
            }
            const fallbackInsertSQL = isMySQL
                ? `INSERT INTO communications
                   (id, candidate_id, channel, direction, message_type, content, metadata)
                   VALUES (?, ?, 'whatsapp', ?, ?, ?, ?)`
                : `INSERT INTO communications
                   (id, candidate_id, channel, direction, message_type, content, metadata)
                   VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6)`;
            await query(fallbackInsertSQL, [
                commId,
                candidateId,
                direction,
                message_type,
                safeContent.slice(0, 4000),
                metadataJson,
            ]);
        }

        // Best-effort candidate activity updates (schema can vary by deployment).
        const primaryCandidateUpdateSQL = isMySQL
            ? `UPDATE candidates
               SET preferred_language = ?, conversation_stage = ?, last_interaction = NOW(), updated_at = NOW()
               WHERE id = ?`
            : `UPDATE candidates
               SET preferred_language = $1, conversation_stage = $2, last_interaction = NOW(), updated_at = NOW()
               WHERE id = $3`;

        try {
            await query(primaryCandidateUpdateSQL, [preferredLanguage, conversationStage, candidateId]);
        } catch (candidateUpdateErr) {
            if (!isMissingColumnError(candidateUpdateErr)) {
                throw candidateUpdateErr;
            }

            const fallbackCandidateUpdateSQL = isMySQL
                ? `UPDATE candidates
                   SET preferred_language = ?, last_contact_at = NOW(), updated_at = NOW()
                   WHERE id = ?`
                : `UPDATE candidates
                   SET preferred_language = $1, updated_at = NOW()
                   WHERE id = $2`;

            const fallbackParams = isMySQL
                ? [preferredLanguage, candidateId]
                : [preferredLanguage, candidateId];
            await query(fallbackCandidateUpdateSQL, fallbackParams);
        }

        if (String(message_type || '').toLowerCase() === 'document') {
            const cvFlagSQL = isMySQL
                ? 'UPDATE candidates SET cv_uploaded = TRUE, cv_status = ?, updated_at = NOW() WHERE id = ?'
                : 'UPDATE candidates SET cv_uploaded = TRUE, cv_status = $1, updated_at = NOW() WHERE id = $2';
            try {
                const cvStatus = conversationStage === 'cv_parsed' ? 'parsed' : 'uploaded';
                await query(cvFlagSQL, [cvStatus, candidateId]);
            } catch (cvFlagErr) {
                // Some environments may not have this column yet.
                if (!isMissingColumnError(cvFlagErr)) {
                    throw cvFlagErr;
                }
            }
        }

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
                    content: safeContent.slice(0, 4000),
                    media_url: media_url || null,
                    metadata: { media_url: media_url || null },
                    sender_type: senderType,
                    chatbot_state: chatbot_state || null,
                    detected_language: language || null,
                    whatsapp_message_id: whatsapp_message_id || null,
                    sent_at: new Date().toISOString(),
                });
                io.to(`candidate:${candidateId}`).emit('receive_message', {
                    id: commId,
                    candidate_id: candidateId,
                    phone: normalizedPhone,
                    sender: senderType,
                    text: safeContent.slice(0, 4000),
                    timestamp: new Date().toISOString(),
                    message_type,
                    direction,
                });
                // Also notify the global chat list that this candidate has new activity
                io.emit('chat_activity', {
                    candidate_id: candidateId,
                    candidate_name: candidateName,
                    phone: normalizedPhone,
                    last_message: safeContent.slice(0, 80),
                    direction,
                    chatbot_state: chatbot_state || null,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            // WebSocket emit failure is non-critical
            logger.debug(`sync-message: WebSocket emit skipped — ${wsErr.message}`);
        }

        return res.status(201).json({ id: commId, candidate_id: candidateId, conversation_stage: conversationStage });
    } catch (error) {
        const errorDetail = error?.message || (typeof error === 'string' ? error : JSON.stringify(error));
        logger.error(`sync-message error: ${errorDetail}`);
        return res.status(500).json({ error: 'Failed to store message', detail: errorDetail });
    }
});

module.exports = router;
