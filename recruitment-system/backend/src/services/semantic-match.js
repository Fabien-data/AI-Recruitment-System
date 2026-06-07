/**
 * Semantic matching + auto-shortlist (UPGRADES.md #4a)
 * ====================================================
 * Embedding-based candidate↔job matching. CV text and job text are embedded with
 * OpenAI text-embedding-3-small (1536 dims) and stored as JSONB on candidates /
 * jobs (migration 036) with a content hash to detect staleness. Cosine similarity
 * is computed in JS at shortlist time — at this scale (~900 CVs, ~14 jobs) that's
 * a few ms and avoids needing the pgvector extension (which requires a privilege
 * recruitment_user doesn't have).
 *
 * Rule-based scoring (auto-assign.js) stays as the assignment gate; this adds a
 * ranked "smart shortlist" with a lightweight, deterministic "why matched".
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { openai } = require('../config/openai');
const logger = require('../utils/logger');

const EMBED_MODEL = 'text-embedding-3-small';
const MAX_TEXT = 6000; // keep token cost bounded per item

function sha256(text) {
    return crypto.createHash('sha256').update(text || '').digest('hex');
}

function parseEmbedding(v) {
    if (!v) return null;
    if (Array.isArray(v)) return v;
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
}

/** Embed an array of texts in one call. Returns array of vectors (or nulls). */
async function embedTexts(texts) {
    const clean = texts.map((t) => String(t || '').slice(0, MAX_TEXT).trim() || ' ');
    if (process.env.ENABLE_MOCK_AI === 'true') return texts.map(() => null);
    try {
        const res = await openai.embeddings.create({ model: EMBED_MODEL, input: clean });
        // OpenAI returns data in input order.
        return res.data.map((d) => d.embedding);
    } catch (err) {
        logger.warn(`semantic-match: embedTexts failed (${texts.length}): ${err.message}`);
        return texts.map(() => null);
    }
}

async function embedText(text) {
    const [v] = await embedTexts([text]);
    return v || null;
}

function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function buildJobText(j) {
    let reqs = j.requirements;
    if (reqs && typeof reqs === 'object') {
        reqs = Object.entries(reqs).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ');
    }
    return [
        j.title && `Role: ${j.title}`,
        j.category && `Category: ${j.category}`,
        (j.country || j.domain) && `Location/Domain: ${j.country || ''} ${j.domain || ''}`.trim(),
        j.description && `Description: ${j.description}`,
        reqs && `Requirements: ${reqs}`,
    ].filter(Boolean).join('\n');
}

function buildCandidateText(c) {
    return [
        c.name && `Name: ${c.name}`,
        c.skills && `Skills: ${Array.isArray(c.skills) ? c.skills.join(', ') : c.skills}`,
        c.experience_years != null && `Experience: ${c.experience_years} years`,
        c.highest_qualification && `Qualification: ${c.highest_qualification}`,
        c.cv_text && `CV: ${c.cv_text}`,
    ].filter(Boolean).join('\n');
}

// ── Deterministic "why matched" — overlapping meaningful terms ────────────────
const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'are', 'our', 'all', 'will', 'have', 'this', 'that', 'job', 'role', 'work', 'years', 'year', 'experience', 'requirements', 'description', 'location', 'category', 'domain', 'name', 'skills', 'qualification']);
function terms(text) {
    return new Set(String(text || '').toLowerCase().match(/[a-z][a-z+#.]{2,}/g)?.filter((w) => !STOP.has(w)) || []);
}
function whyMatched(candidateText, jobText, limit = 6) {
    const ct = terms(candidateText);
    const jt = terms(jobText);
    const overlap = [...jt].filter((w) => ct.has(w));
    // Prefer longer/more-specific terms first.
    overlap.sort((a, b) => b.length - a.length);
    return overlap.slice(0, limit);
}

// ── Ensure / refresh stored embeddings ───────────────────────────────────────
async function ensureJobEmbedding(jobId) {
    const r = await query(adaptQuery(
        'SELECT id, title, category, country, domain, description, requirements, embedding, embedding_hash FROM jobs WHERE id = $1'
    ), [jobId]);
    if (!r.rows.length) return null;
    const job = r.rows[0];
    const text = buildJobText(job);
    const hash = sha256(text);
    const existing = parseEmbedding(job.embedding);
    if (existing && job.embedding_hash === hash) return existing;
    const vec = await embedText(text);
    if (!vec) return existing; // embedding unavailable → keep whatever we had
    await query(adaptQuery(
        'UPDATE jobs SET embedding = $1, embedding_hash = $2, embedding_at = NOW() WHERE id = $3'
    ), [JSON.stringify(vec), hash, jobId]);
    return vec;
}

const CANDIDATE_SELECT = `
    SELECT c.id, c.name, c.skills, c.experience_years, c.highest_qualification,
           c.cv_embedding, c.cv_embedding_hash,
           (SELECT f.ocr_text FROM cv_files f WHERE f.candidate_id = c.id
            ORDER BY f.is_primary DESC NULLS LAST, f.uploaded_at DESC LIMIT 1) AS cv_text
    FROM candidates c`;

async function ensureCandidateEmbedding(candidateRow) {
    const c = candidateRow;
    const text = buildCandidateText({ ...c, cv_text: c.cv_text });
    const hash = sha256(text);
    const existing = parseEmbedding(c.cv_embedding);
    if (existing && c.cv_embedding_hash === hash) return existing;
    const vec = await embedText(text);
    if (!vec) return existing;
    await query(adaptQuery(
        'UPDATE candidates SET cv_embedding = $1, cv_embedding_hash = $2, cv_embedding_at = NOW() WHERE id = $3'
    ), [JSON.stringify(vec), hash, c.id]);
    return vec;
}

/**
 * Ranked smart shortlist for a job. Uses stored candidate embeddings (run the
 * backfill to populate them); only CV-present candidates are considered, and
 * candidates already on a terminal/placed status are excluded.
 */
async function shortlistForJob(jobId, { limit = 20 } = {}) {
    const jobVec = await ensureJobEmbedding(jobId);
    const jobR = await query(adaptQuery('SELECT id, title, category, country, domain, description, requirements FROM jobs WHERE id = $1'), [jobId]);
    if (!jobR.rows.length) return { error: 'job_not_found' };
    const jobText = buildJobText(jobR.rows[0]);
    if (!jobVec) return { error: 'embedding_unavailable', candidates: [] };

    // CV-present, non-terminal candidates that already have an embedding.
    const r = await query(adaptQuery(`
        SELECT c.id, c.name, c.phone, c.status, c.photo_url, c.skills,
               c.experience_years, c.highest_qualification, c.cv_embedding
        FROM candidates c
        WHERE c.status NOT IN ('hired','merged')
          AND c.cv_embedding IS NOT NULL
          AND (c.cv_uploaded IS TRUE OR EXISTS (SELECT 1 FROM cv_files f WHERE f.candidate_id = c.id))
    `), []);

    const scored = [];
    for (const c of r.rows) {
        const vec = parseEmbedding(c.cv_embedding);
        if (!vec) continue;
        const score = cosineSim(jobVec, vec);
        const candidateText = buildCandidateText(c);
        scored.push({
            id: c.id, name: c.name, phone: c.phone, status: c.status, photo_url: c.photo_url,
            score: Math.round(score * 1000) / 1000,
            match_percent: Math.round(score * 100),
            why_matched: whyMatched(candidateText, jobText),
        });
    }
    scored.sort((a, b) => b.score - a.score);
    return { job_id: jobId, total_considered: scored.length, candidates: scored.slice(0, limit) };
}

/**
 * Backfill / refresh embeddings for jobs + CV-present candidates that are missing
 * or stale. Idempotent + bounded. Returns counts.
 */
async function backfillEmbeddings({ limit = 1000 } = {}) {
    let jobsEmbedded = 0, candidatesEmbedded = 0;

    // Jobs
    const jobs = await query(adaptQuery('SELECT id FROM jobs'), []);
    for (const j of jobs.rows) {
        const v = await ensureJobEmbedding(j.id);
        if (v) jobsEmbedded++;
    }

    // Candidates (CV-present, missing/stale embedding), batched for throughput.
    const cands = await query(adaptQuery(`
        ${CANDIDATE_SELECT}
        WHERE (c.cv_uploaded IS TRUE OR EXISTS (SELECT 1 FROM cv_files f WHERE f.candidate_id = c.id))
          AND c.status NOT IN ('merged')
        ORDER BY c.updated_at DESC NULLS LAST
        LIMIT ${Math.max(1, Math.min(parseInt(limit, 10) || 1000, 5000))}
    `), []);

    const BATCH = 64;
    const pending = [];
    for (const c of cands.rows) {
        const text = buildCandidateText({ ...c, cv_text: c.cv_text });
        const hash = sha256(text);
        if (parseEmbedding(c.cv_embedding) && c.cv_embedding_hash === hash) continue; // up to date
        pending.push({ id: c.id, text, hash });
    }
    for (let i = 0; i < pending.length; i += BATCH) {
        const slice = pending.slice(i, i + BATCH);
        const vecs = await embedTexts(slice.map((p) => p.text));
        for (let k = 0; k < slice.length; k++) {
            const vec = vecs[k];
            if (!vec) continue;
            await query(adaptQuery(
                'UPDATE candidates SET cv_embedding = $1, cv_embedding_hash = $2, cv_embedding_at = NOW() WHERE id = $3'
            ), [JSON.stringify(vec), slice[k].hash, slice[k].id]);
            candidatesEmbedded++;
        }
    }

    return { jobs_embedded: jobsEmbedded, candidates_embedded: candidatesEmbedded, candidates_scanned: cands.rows.length };
}

module.exports = {
    embedText, embedTexts, cosineSim, sha256,
    buildJobText, buildCandidateText, whyMatched,
    ensureJobEmbedding, ensureCandidateEmbedding,
    shortlistForJob, backfillEmbeddings,
    CANDIDATE_SELECT,
};
