const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { openai } = require('../config/openai');
const { withTransaction, generateUUID } = require('../config/database');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { resolveCountry } = require('../utils/countries');
const logger = require('../utils/logger');
const { syncJobAsync } = require('../routes/chatbot-sync');

const visionClient = process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.VISION_API_ENABLED === 'true'
    ? new ImageAnnotatorClient()
    : null;

const LIVE_CONFIDENCE_THRESHOLD = 0.8;

const systemPrompt = `
You extract structured hiring data from recruitment flyers, screenshots, and social posts.
Return ONLY valid JSON and do not wrap the answer in markdown.

Schema:
{
  "project": {
    "name": "Client or company name",
    "title": "Human readable project title",
    "industry_type": "Industry or sector",
    "description": "Short project summary",
    "countries": ["Country names inferred from the flyer if present"]
  },
  "jobs": [
    {
      "title": "Exact job title",
      "category": "Job category",
      "department": "Department or team",
      "location": "Specific city or facility",
      "country": "Full English country name (e.g. 'United Arab Emirates', 'Romania')",
      "country_code": "ISO 3166-1 alpha-2 country code if confident, else null",
      "domain": "'middle_east' if the country is in the Gulf/Levant/Arabian peninsula, 'europe' if EU/UK/EFTA/Balkans, else null",
      "type": "Full-time, contract, part-time, etc.",
      "description": "Role summary",
      "requirements_text": "A readable summary of all requirements and bullet points",
      "requirements": {
        "required_skills": ["skill names"],
        "required_languages": ["language names"],
        "min_experience_years": 0,
        "min_age": null,
        "max_age": null,
        "min_height_cm": null,
        "max_height_cm": null,
        "education": ["education requirements"]
      },
      "salary_range": "Salary text or 'Not specified'",
      "positions_available": 1,
      "urgency_level": "'top_urgent' | 'urgent' | 'situational' | 'normal' — infer from words like 'immediate', 'urgent', 'asap', 'walk-in tomorrow'; default 'normal'",
      "confidence_score": 0.0
    }
  ],
  "confidence_score": 0.0
}

Guidelines:
- Always return jobs as an array. If the flyer contains one role, return a one-item array.
- If a detail is missing, use null (or "Not specified" for salary_range only).
- Keep requirements structured so downstream matching works reliably.
- Use confidence_score (0-1) to reflect how trustworthy the extraction is.
- DO NOT invent a country if the flyer is ambiguous — leave country/country_code/domain null.
`;

function stripCodeFences(text) {
    return String(text || '')
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();
}

function safeParseJson(text) {
    try {
        return JSON.parse(stripCodeFences(text));
    } catch (error) {
        const firstBrace = String(text || '').indexOf('{');
        const lastBrace = String(text || '').lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            return JSON.parse(String(text).slice(firstBrace, lastBrace + 1));
        }
        throw error;
    }
}

async function runTransactionQuery(conn, sql, params = []) {
    const adaptedSql = adaptQuery(sql);

    if (isMySQL && typeof conn.execute === 'function') {
        const [rows] = await conn.execute(adaptedSql, params);
        if (Array.isArray(rows)) {
            return { rows, rowCount: rows.length };
        }
        return { rows: [], rowCount: rows.affectedRows || 0, insertId: rows.insertId };
    }

    return conn.query(adaptedSql, params);
}

function normalizeArray(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean).map(item => String(item).trim()).filter(Boolean);
    if (typeof value === 'string') {
        return value
            .split(/[,\n;•-]+/)
            .map(item => item.trim())
            .filter(Boolean);
    }
    return [];
}

function inferCategory(title = '', department = '', type = '') {
    const haystack = `${title} ${department} ${type}`.toLowerCase();
    const categoryMap = [
        ['security', 'security'],
        ['guard', 'security'],
        ['chef', 'hospitality'],
        ['cook', 'hospitality'],
        ['waiter', 'hospitality'],
        ['housekeeping', 'hospitality'],
        ['driver', 'logistics'],
        ['delivery', 'logistics'],
        ['warehouse', 'logistics'],
        ['nurse', 'healthcare'],
        ['caregiver', 'healthcare'],
        ['doctor', 'healthcare'],
        ['technician', 'manufacturing'],
        ['operator', 'manufacturing'],
        ['sales', 'retail'],
        ['cashier', 'retail'],
        ['admin', 'administration']
    ];

    for (const [needle, category] of categoryMap) {
        if (haystack.includes(needle)) {
            return category;
        }
    }

    return department || 'general';
}

function inferProjectCountryList(project, jobs) {
    const projectCountries = normalizeArray(project.countries);
    if (projectCountries.length > 0) {
        return projectCountries;
    }

    const jobLocations = jobs
        .map(job => job.location)
        .filter(Boolean)
        .map(value => String(value).trim());

    if (jobLocations.length === 0) {
        return [];
    }

    return [jobLocations[0]];
}

const VALID_URGENCY = new Set(['top_urgent', 'urgent', 'situational', 'normal']);

function normalizeUrgency(value) {
    const lower = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (lower === 'top_urgent' || lower === 'topurgent' || lower === 'critical') return 'top_urgent';
    if (lower === 'urgent') return 'urgent';
    if (lower === 'situational') return 'situational';
    return VALID_URGENCY.has(lower) ? lower : 'normal';
}

function normalizeJobPayload(job, extractedConfidence = 0, options = {}) {
    const { forceReview = false } = options;
    const rawConfidence = Number(job.confidence_score ?? extractedConfidence ?? 0);
    const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0;

    const requirements = job.requirements && typeof job.requirements === 'object'
        ? job.requirements
        : {};

    const requirementsText = job.requirements_text || job.requirements_summary || '';
    const category = job.category || inferCategory(job.title, job.department, job.type);
    // forceReview is set by the new /extract path so agent review is mandatory.
    // Legacy /magic-create path keeps the confidence-threshold gating.
    const status = forceReview
        ? 'pending_review'
        : (confidence > 0 && confidence < LIVE_CONFIDENCE_THRESHOLD
            ? 'pending_review'
            : (job.status || 'active'));

    const urgency_level = normalizeUrgency(job.urgency_level);
    const geo = resolveCountry({
        name: job.country,
        code: job.country_code,
        domain: job.domain,
    });

    return {
        title: job.title || 'Untitled role',
        category,
        department: job.department || category,
        location: job.location || 'Not specified',
        country: geo.country,
        country_code: geo.country_code,
        domain: geo.domain,
        urgency_level,
        type: job.type || 'Full-time',
        description: job.description || requirementsText || '',
        requirements: {
            required_skills: normalizeArray(requirements.required_skills),
            required_languages: normalizeArray(requirements.required_languages),
            min_experience_years: Number.isFinite(Number(requirements.min_experience_years))
                ? Number(requirements.min_experience_years)
                : 0,
            min_age: requirements.min_age ?? null,
            max_age: requirements.max_age ?? null,
            min_height_cm: requirements.min_height_cm ?? null,
            max_height_cm: requirements.max_height_cm ?? null,
            education: normalizeArray(requirements.education),
        },
        requirementsText,
        salary_range: job.salary_range || 'Not specified',
        positions_available: Number.isFinite(Number(job.positions_available))
            ? Number(job.positions_available)
            : 1,
        confidence_score: confidence,
        status,
    };
}

function normalizeExtractionPayload(payload, options = {}) {
    const projectInput = payload?.project || {};
    const jobsInput = Array.isArray(payload?.jobs)
        ? payload.jobs
        : payload?.job
            ? [payload.job]
            : [];

    const jobs = jobsInput.map(job => normalizeJobPayload(job, payload?.confidence_score, options));
    const confidence_score = Number.isFinite(Number(payload?.confidence_score))
        ? Number(payload.confidence_score)
        : (jobs.length > 0
            ? jobs.reduce((sum, job) => sum + (job.confidence_score || 0), 0) / jobs.length
            : 0);

    return {
        project: {
            name: projectInput.name || projectInput.client_name || 'Confidential Client',
            title: projectInput.title || `${projectInput.name || projectInput.client_name || 'Hiring'} Recruitment`,
            industry_type: projectInput.industry_type || 'General',
            description: projectInput.description || '',
            countries: inferProjectCountryList(projectInput, jobs),
        },
        jobs,
        confidence_score,
    };
}

async function extractWithOpenAI(buffer, mimeType) {
    const response = await openai.chat.completions.create({
        model: process.env.AUTO_INGEST_MODEL || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Extract the recruitment information from this flyer.' },
                    {
                        type: 'image_url',
                        image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${buffer.toString('base64')}` },
                    },
                ],
            },
        ],
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('OpenAI returned an empty extraction response');
    }

    return safeParseJson(content);
}

async function extractTextWithVision(buffer) {
    if (!visionClient) {
        return null;
    }

    const [result] = await visionClient.textDetection({
        image: { content: buffer },
    });

    return result.fullTextAnnotation?.text || result.textAnnotations?.[0]?.description || null;
}

async function extractWithFallback(buffer, mimeType) {
    try {
        return await extractWithOpenAI(buffer, mimeType);
    } catch (error) {
        logger.warn(`Auto ingest AI extraction failed, attempting OCR fallback: ${error.message}`);
    }

    const ocrText = await extractTextWithVision(buffer);
    if (!ocrText) {
        throw new Error('Unable to read flyer image with AI or OCR fallback');
    }

    const response = await openai.chat.completions.create({
        model: process.env.AUTO_INGEST_MODEL || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: systemPrompt },
            {
                role: 'user',
                content: `OCR text extracted from the flyer:\n\n${ocrText}`,
            },
        ],
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('OpenAI returned an empty OCR extraction response');
    }

    return safeParseJson(content);
}

async function findOrCreateProject(conn, project, jobs) {
    const countryList = project.countries.length > 0 ? project.countries : ['Unknown'];
    const description = project.description || jobs.map(job => job.description).filter(Boolean).join('\n\n').slice(0, 500) || 'Auto-created from flyer ingestion';

    const existingSql = adaptQuery(`
        SELECT id
        FROM projects
        WHERE LOWER(client_name) = LOWER($1)
           OR LOWER(title) = LOWER($2)
        LIMIT 1
    `);
    const existingResult = await runTransactionQuery(conn, existingSql, [project.name, project.title]);

    if (existingResult.rows.length > 0) {
        return existingResult.rows[0].id;
    }

    const projectId = generateUUID();
    const insertSql = adaptQuery(`
        INSERT INTO projects
            (id, title, client_name, industry_type, description, countries, status, priority,
             total_positions, start_date, interview_date, end_date, benefits, salary_info, contact_info,
             requirements, metadata, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    `);

    await runTransactionQuery(conn, insertSql, [
        projectId,
        project.title,
        project.name,
        project.industry_type,
        description,
        JSON.stringify(countryList),
        'active',
        'normal',
        jobs.length || 1,
        null,
        null,
        null,
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify({}),
        JSON.stringify({ source: 'auto_ingest' }),
        null,
    ]);

    return projectId;
}

async function insertJob(conn, projectId, job) {
    const jobId = generateUUID();
    const insertSql = adaptQuery(`
        INSERT INTO jobs
            (id, title, category, description, requirements, wiggle_room, positions_available,
             salary_range, location, deadline, project_id, created_by, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
        RETURNING *
    `);

    const result = await runTransactionQuery(conn, insertSql, [
        jobId,
        job.title,
        job.category,
        job.description,
        JSON.stringify(job.requirements),
        JSON.stringify({}),
        job.positions_available,
        job.salary_range,
        job.location,
        null,
        projectId,
        null,
        job.status,
    ]);

    return isMySQL ? { id: jobId, ...job, project_id: projectId } : result.rows[0];
}

async function syncCreatedJobs(createdJobs) {
    const syncResults = [];

    for (const job of createdJobs) {
        if (!job || job.status !== 'active') {
            syncResults.push({ job_id: job?.id, synced: false, reason: 'not_active' });
            continue;
        }

        try {
            await syncJobAsync(job.id);
            syncResults.push({ job_id: job.id, synced: true });
        } catch (error) {
            logger.warn(`Auto ingest sync failed for job ${job.id}: ${error.message}`);
            syncResults.push({ job_id: job.id, synced: false, reason: error.message });
        }
    }

    return syncResults;
}

async function processJobFlyer(imageBuffer, mimeType = 'image/jpeg') {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw new Error('A valid flyer image buffer is required');
    }

    const rawExtraction = await extractWithFallback(imageBuffer, mimeType);
    const normalized = normalizeExtractionPayload(rawExtraction);

    if (normalized.jobs.length === 0) {
        throw new Error('No jobs were detected in the uploaded flyer');
    }

    const result = await withTransaction(async (conn) => {
        const projectId = await findOrCreateProject(conn, normalized.project, normalized.jobs);
        const createdJobs = [];

        for (const job of normalized.jobs) {
            const createdJob = await insertJob(conn, projectId, job);
            createdJobs.push(createdJob);
        }

        return {
            project_id: projectId,
            jobs: createdJobs,
        };
    });

    const syncResults = await syncCreatedJobs(result.jobs);

    return {
        success: true,
        confidence_score: normalized.confidence_score,
        project: normalized.project,
        jobs: result.jobs,
        sync_results: syncResults,
        extraction: normalized,
    };
}

/**
 * Extract structured job data from a flyer WITHOUT writing to the database.
 *
 * Used by POST /api/jobs/extract — the per-file review queue calls this for
 * each upload, shows the agent an editable form, and saves via the regular
 * POST /api/jobs (with project picker) only after every required field is
 * filled. This is what replaces the auto-saving behaviour of magic-create.
 *
 * The returned `jobs` array has every job pinned to status='pending_review'
 * regardless of confidence — the agent decides whether to promote to active.
 */
async function extractJobFlyer(imageBuffer, mimeType = 'image/jpeg') {
    if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        throw new Error('A valid flyer image buffer is required');
    }

    const rawExtraction = await extractWithFallback(imageBuffer, mimeType);
    const normalized = normalizeExtractionPayload(rawExtraction, { forceReview: true });

    if (normalized.jobs.length === 0) {
        throw new Error('No jobs were detected in the uploaded flyer');
    }

    return {
        confidence_score: normalized.confidence_score,
        project: normalized.project,
        jobs: normalized.jobs,
    };
}

module.exports = {
    processJobFlyer,
    extractJobFlyer,
};