/**
 * Chatbot Knowledge Payload Builders
 * ==================================
 * Pure functions that turn a CRM row (job / project / FAQ) into the exact
 * JSON body POSTed to the chatbot's /api/knowledge/upsert endpoint.
 *
 * Kept here (not in chatbot-sync.js) so chatbot-outbox.js and chatbot-sync.js
 * can both consume them without circular imports.
 */

function _parseJson(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return null; }
}

function _toArray(v) {
    const parsed = _parseJson(v);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(v)) return v;
    return [];
}

function _toObject(v) {
    const parsed = _parseJson(v);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

/* ───────────────────────────────── JOBS ───────────────────────────────────── */

function _domainLabel(domain) {
    if (domain === 'middle_east') return 'Middle East';
    if (domain === 'europe') return 'Europe';
    return null;
}

function _urgencyLabel(level) {
    if (level === 'top_urgent') return 'Top Urgent';
    if (level === 'urgent') return 'Urgent';
    if (level === 'situational') return 'Situational';
    return null;
}

function _computePositionsRemaining(job) {
    if (job.positions_remaining != null && Number.isFinite(Number(job.positions_remaining))) {
        return Math.max(0, Number(job.positions_remaining));
    }
    const available = Number(job.positions_available) || 0;
    const filled = Number(job.positions_filled) || 0;
    return Math.max(0, available - filled);
}

function _buildJobContent(job) {
    const requirements = typeof job.requirements === 'string'
        ? job.requirements
        : JSON.stringify(job.requirements || {}, null, 2);
    const countries  = _toArray(job.countries);
    const benefits   = _toObject(job.benefits);
    const salaryInfo = _toObject(job.salary_info);
    const urgencyLabel = _urgencyLabel(job.urgency_level);
    const domainLabel  = _domainLabel(job.domain);
    const positionsRemaining = _computePositionsRemaining(job);
    return [
        job.title ? `Title: ${job.title}` : null,
        job.description || null,
        requirements && requirements !== '{}' ? `Requirements: ${requirements}` : null,
        job.salary_range ? `Salary: ${job.salary_range}` : null,
        Object.keys(salaryInfo).length ? `Salary info: ${JSON.stringify(salaryInfo)}` : null,
        job.location ? `Location: ${job.location}` : null,
        job.country ? `Country: ${job.country}` : null,
        domainLabel ? `Region: ${domainLabel}` : null,
        urgencyLabel ? `Urgency: ${urgencyLabel}` : null,
        positionsRemaining > 0 ? `Open positions: ${positionsRemaining}` : null,
        countries.length ? `Countries: ${countries.join(', ')}` : null,
        Object.keys(benefits).length ? `Benefits: ${JSON.stringify(benefits)}` : null,
        job.start_date ? `Start Date: ${job.start_date}` : null,
        job.interview_date ? `Interview Date: ${job.interview_date}` : null,
        job.project_title ? `Project: ${job.project_title}` : null,
    ].filter(Boolean).join('\n\n');
}

/**
 * Build the upsert payload for a job. Expects the joined row returned by the
 * standard `SELECT j.*, p.countries, p.benefits, ... FROM jobs j LEFT JOIN projects p`.
 */
function buildJobPayload(job) {
    const positionsRemaining = _computePositionsRemaining(job);
    const urgency_level = job.urgency_level || 'normal';
    return {
        doc_id: `job_${job.id}`,
        doc_type: 'job_desc',
        title: job.title || 'Job',
        content: _buildJobContent(job),
        metadata: {
            job_id: job.id,
            project_id: job.project_id,
            category: job.category,
            status: job.status,
            requirements: job.requirements,
            salary_range: job.salary_range,
            location: job.location,
            description: job.description,
            positions_available: job.positions_available,
            positions_filled: Number(job.positions_filled) || 0,
            positions_remaining: positionsRemaining,
            // Geographic + urgency targeting
            country: job.country || null,
            country_code: job.country_code || null,
            domain: job.domain || null,
            urgency_level,
            // DEPRECATED: kept so chatbot Pinecone filters still match until
            // the bot is redeployed to read urgency_level. Derived strictly
            // from urgency_level so it cannot drift.
            is_urgent: urgency_level === 'urgent' || urgency_level === 'top_urgent',
            countries:       _toArray(job.countries),
            benefits:        _toObject(job.benefits),
            salary_info:     _toObject(job.salary_info),
            start_date:      job.start_date     || null,
            interview_date:  job.interview_date || null,
            project_title:   job.project_title  || null,
        },
    };
}

/* ─────────────────────────────── PROJECTS ─────────────────────────────────── */

function _buildProjectContent(p) {
    const countries  = _toArray(p.countries);
    const benefits   = _toObject(p.benefits);
    const salaryInfo = _toObject(p.salary_info);
    const contact    = _toObject(p.contact_info);
    return [
        p.title ? `Project: ${p.title}` : null,
        p.client_name ? `Client: ${p.client_name}` : null,
        p.industry_type ? `Industry: ${p.industry_type}` : null,
        p.description || null,
        countries.length ? `Countries: ${countries.join(', ')}` : null,
        Object.keys(benefits).length ? `Benefits: ${JSON.stringify(benefits)}` : null,
        Object.keys(salaryInfo).length ? `Salary info: ${JSON.stringify(salaryInfo)}` : null,
        p.start_date ? `Start Date: ${p.start_date}` : null,
        p.interview_date ? `Interview Date: ${p.interview_date}` : null,
        p.end_date ? `End Date: ${p.end_date}` : null,
        Object.keys(contact).length ? `Contact: ${JSON.stringify(contact)}` : null,
    ].filter(Boolean).join('\n\n');
}

function buildProjectPayload(project) {
    return {
        doc_id: `project_${project.id}`,
        doc_type: 'project_desc',
        title: project.title || 'Project',
        content: _buildProjectContent(project),
        metadata: {
            project_id: project.id,
            client_name: project.client_name,
            industry_type: project.industry_type,
            status: project.status,
            priority: project.priority,
            countries:      _toArray(project.countries),
            benefits:       _toObject(project.benefits),
            salary_info:    _toObject(project.salary_info),
            contact_info:   _toObject(project.contact_info),
            start_date:     project.start_date     || null,
            interview_date: project.interview_date || null,
            end_date:       project.end_date       || null,
        },
    };
}

/* ───────────────────────────────── FAQS ───────────────────────────────────── */

function _buildFaqContent(e) {
    const parts = [];
    if (e.question_en && e.answer_en) parts.push(`Q (EN): ${e.question_en}\nA (EN): ${e.answer_en}`);
    if (e.question_si && e.answer_si) parts.push(`Q (SI): ${e.question_si}\nA (SI): ${e.answer_si}`);
    if (e.question_ta && e.answer_ta) parts.push(`Q (TA): ${e.question_ta}\nA (TA): ${e.answer_ta}`);
    return parts.join('\n\n');
}

function buildFaqPayload(entry) {
    const languages = ['en'];
    if (entry.question_si) languages.push('si');
    if (entry.question_ta) languages.push('ta');

    return {
        doc_id: `faq_${entry.id}`,
        doc_type: 'faq',
        title: entry.question_en || entry.question_si || entry.question_ta || 'FAQ',
        content: _buildFaqContent(entry),
        metadata: {
            faq_id: entry.id,
            category: entry.category || null,
            keywords: _toArray(entry.keywords),
            priority: entry.priority || 0,
            languages,
            question_en: entry.question_en || null,
            answer_en:   entry.answer_en   || null,
            question_si: entry.question_si || null,
            answer_si:   entry.answer_si   || null,
            question_ta: entry.question_ta || null,
            answer_ta:   entry.answer_ta   || null,
        },
    };
}

module.exports = {
    buildJobPayload,
    buildProjectPayload,
    buildFaqPayload,
};
