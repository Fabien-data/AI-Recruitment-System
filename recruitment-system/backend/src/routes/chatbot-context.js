/**
 * Chatbot Context Route (Public)
 * ==============================
 * Called by the Python chatbot when it detects a "START:ad_ref" message.
 * Returns rich job + project context so the chatbot can have an
 * intelligent, personalised conversation about the specific role.
 *
 * Auth: x-chatbot-api-key header (same shared secret as intake endpoint)
 *
 * GET /api/public/job-context/:ad_ref
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { isMySQL } = require('../utils/query-adapter');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

// ── Rate limit for public chatbot endpoint ────────────────────────────────────
const contextLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { error: 'Too many requests' },
    validate: { xForwardedForHeader: false }, // trust proxy is set at app level
});

// ── Optional API Key check (same key as intake) ───────────────────────────────
function authenticateChatbot(req, res, next) {
    const apiKey = req.headers['x-chatbot-api-key'];
    const expectedKey = process.env.CHATBOT_API_KEY;

    if (expectedKey && apiKey !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized: invalid chatbot API key' });
    }
    next();
}

// ── Build structured requirements for chatbot from raw JSON ───────────────────
function parseRequirements(rawReqs) {
    if (!rawReqs) return {};
    if (typeof rawReqs === 'string') {
        try { rawReqs = JSON.parse(rawReqs); } catch { return {}; }
    }
    return rawReqs;
}

// ── Infer which fields chatbot must ask for based on job requirements ─────────
function inferRequiredFields(requirements, category) {
    const always = ['name', 'phone', 'experience_years'];
    const extras = [];

    if (requirements.min_height_cm || requirements.max_height_cm) {
        extras.push('height_cm');
    }
    if (requirements.licenses || requirements.required_licenses) {
        extras.push('licenses');
    }
    if (requirements.min_age || requirements.max_age) {
        extras.push('date_of_birth');
    }
    if (category === 'security') {
        extras.push('nic_no', 'police_clearance');
    }
    if (category === 'hospitality') {
        extras.push('english_proficiency');
    }
    if (requirements.experience_years || requirements.min_experience) {
        extras.push('previous_employer');
    }

    return [...always, ...extras];
}

// ── Build FAQ list from project/job data ──────────────────────────────────────
function generateFAQs(job, project) {
    const faqs = [];

    if (job.salary_range) {
        faqs.push({ q: 'What is the salary?', a: job.salary_range });
    }

    const benefits = parseRequirements(project.benefits);
    if (benefits.accommodation) {
        faqs.push({ q: 'Is accommodation provided?', a: 'Yes, accommodation is provided.' });
    }
    if (benefits.food) {
        faqs.push({ q: 'Is food provided?', a: 'Yes, meals are provided.' });
    }
    if (benefits.flight) {
        faqs.push({ q: 'Is the flight ticket covered?', a: 'Yes, flight tickets are provided.' });
    }
    if (benefits.medical) {
        faqs.push({ q: 'Is medical covered?', a: 'Yes, medical insurance is included.' });
    }

    if (project.interview_date) {
        const d = new Date(project.interview_date);
        const formatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        faqs.push({ q: 'When is the interview?', a: `The interview is scheduled for ${formatted}.` });
    }

    if (project.start_date) {
        const d = new Date(project.start_date);
        const formatted = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
        faqs.push({ q: 'When does the job start?', a: `The expected start date is ${formatted}.` });
    }

    if (job.location) {
        faqs.push({ q: 'Where is the job located?', a: job.location });
    }

    const reqs = parseRequirements(job.requirements);
    if (reqs.min_age && reqs.max_age) {
        faqs.push({
            q: 'What is the age requirement?',
            a: `Candidates must be between ${reqs.min_age} and ${reqs.max_age} years old.`
        });
    }
    if (reqs.min_height_cm) {
        const maxStr = reqs.max_height_cm ? ` to ${reqs.max_height_cm}cm` : '+';
        faqs.push({
            q: 'What is the height requirement?',
            a: `Minimum height is ${reqs.min_height_cm}cm${maxStr}.`
        });
    }
    if (reqs.required_languages) {
        faqs.push({
            q: 'What language skills are required?',
            a: `Required languages: ${Array.isArray(reqs.required_languages)
                ? reqs.required_languages.join(', ')
                : reqs.required_languages}`
        });
    }

    return faqs;
}

// ── GET /api/public/job-context/:ad_ref ───────────────────────────────────────
router.get('/:ad_ref', contextLimiter, authenticateChatbot, async (req, res) => {
    const { ad_ref } = req.params;

    if (!ad_ref || ad_ref.length > 100) {
        return res.status(400).json({ error: 'Invalid ad_ref' });
    }

    try {
        // Fetch ad link + job + project in one query
        const contextSQL = isMySQL
            ? `SELECT
                   at.id        AS tracking_id,
                   at.ad_ref,
                   at.campaign_name,
                   at.is_active,
                   j.id         AS job_id,
                   j.title      AS job_title,
                   j.category   AS job_category,
                   j.description AS job_description,
                   j.requirements,
                   j.salary_range,
                   j.location,
                   j.positions_available,
                   j.deadline,
                   p.id         AS project_id,
                   p.title      AS project_title,
                   p.client_name,
                   p.industry_type,
                   p.description AS project_description,
                   p.countries,
                   p.benefits,
                   p.salary_info,
                   p.contact_info,
                   p.interview_date,
                   p.start_date,
                   p.priority,
                   p.status     AS project_status
               FROM ad_tracking at
               JOIN jobs j     ON at.job_id     = j.id
               JOIN projects p ON at.project_id = p.id
               WHERE at.ad_ref = ? AND at.is_active = 1`
            : `SELECT
                   at.id        AS tracking_id,
                   at.ad_ref,
                   at.campaign_name,
                   at.is_active,
                   j.id         AS job_id,
                   j.title      AS job_title,
                   j.category   AS job_category,
                   j.description AS job_description,
                   j.requirements,
                   j.salary_range,
                   j.location,
                   j.positions_available,
                   j.deadline,
                   p.id         AS project_id,
                   p.title      AS project_title,
                   p.client_name,
                   p.industry_type,
                   p.description AS project_description,
                   p.countries,
                   p.benefits,
                   p.salary_info,
                   p.contact_info,
                   p.interview_date,
                   p.start_date,
                   p.priority,
                   p.status     AS project_status
               FROM ad_tracking at
               JOIN jobs j     ON at.job_id::uuid     = j.id
               JOIN projects p ON at.project_id::uuid = p.id
               WHERE at.ad_ref = $1 AND at.is_active = TRUE`;

        const result = await query(contextSQL, [ad_ref]);

        if (result.rows.length === 0) {
            // Log invalid/inactive ref attempts
            logger.warn(`Chatbot context: ad_ref not found or inactive: ${ad_ref}`);
            return res.status(404).json({
                error: 'Ad reference not found or no longer active',
                ad_ref
            });
        }

        const row = result.rows[0];

        // Parse JSON fields safely
        const requirements = parseRequirements(row.requirements);
        const benefits = parseRequirements(row.benefits);
        const countries = typeof row.countries === 'string'
            ? (() => { try { return JSON.parse(row.countries); } catch { return []; } })()
            : (Array.isArray(row.countries) ? row.countries : []);
        const salaryInfo = parseRequirements(row.salary_info);
        const contactInfo = parseRequirements(row.contact_info);

        // Build contextual fields for the chatbot
        const requiredFields = inferRequiredFields(requirements, row.job_category);
        const faqs = generateFAQs(
            { ...row, requirements },
            { ...row, countries, benefits }
        );

        // Greeting override — personalised for this specific ad
        const countryStr = countries.length > 0 ? `in ${countries[0]}` : '';
        const greetingOverride = `Hi! 👋 I see you're interested in our *${row.job_title}* position ${countryStr}!\n\nI'm here to help you apply. This will only take a few minutes. 😊`;

        // Increment click counter (fire-and-forget, don't block response)
        const clickSQL = isMySQL
            ? 'UPDATE ad_tracking SET clicks = clicks + 1, updated_at = NOW() WHERE ad_ref = ?'
            : 'UPDATE ad_tracking SET clicks = clicks + 1, updated_at = NOW() WHERE ad_ref = $1';
        query(clickSQL, [ad_ref]).catch(err =>
            logger.warn(`Failed to increment click for ${ad_ref}: ${err.message}`)
        );

        // Build and return the full context object
        return res.json({
            ad_ref: row.ad_ref,
            campaign_name: row.campaign_name,

            job: {
                id: row.job_id,
                title: row.job_title,
                category: row.job_category,
                description: row.job_description,
                requirements,
                salary_range: row.salary_range,
                location: row.location,
                positions_available: row.positions_available,
                deadline: row.deadline
            },

            project: {
                id: row.project_id,
                title: row.project_title,
                client_name: row.client_name,
                industry_type: row.industry_type,
                countries,
                benefits,
                salary_info: salaryInfo,
                contact_info: contactInfo,
                interview_date: row.interview_date,
                start_date: row.start_date,
                priority: row.priority,
                status: row.project_status
            },

            chatbot_config: {
                required_fields: requiredFields,
                faqs,
                greeting_override: greetingOverride,
                skip_states: ['AWAITING_JOB_INTEREST', 'AWAITING_DESTINATION'],
                prefilled: {
                    job_interest: row.job_title,
                    destination_country: countries[0] || null,
                    ad_job_id: row.job_id,
                    ad_project_id: row.project_id
                }
            }
        });

    } catch (error) {
        logger.error('Chatbot context fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch job context' });
    }
});

module.exports = router;
