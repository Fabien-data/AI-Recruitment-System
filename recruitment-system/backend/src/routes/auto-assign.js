/**
 * Auto-Assign Routes
 * Handles automatic CV assignment to jobs based on skill matching
 */
const express = require('express');
const router = express.Router();
const { pool, withTransaction } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * Skill matching configuration
 */
const SKILL_WEIGHTS = {
    exact_match: 1.0,
    partial_match: 0.6,
    related_match: 0.3
};

// Related skills mapping for fuzzy matching
const RELATED_SKILLS = {
    'security': ['guard', 'surveillance', 'protection', 'safety', 'cctv', 'patrol'],
    'driving': ['driver', 'chauffeur', 'transport', 'vehicle', 'logistics'],
    'hospitality': ['hotel', 'restaurant', 'customer service', 'front desk', 'reception'],
    'cleaning': ['housekeeping', 'janitor', 'maintenance', 'sanitation'],
    'warehouse': ['logistics', 'inventory', 'forklift', 'storage', 'shipping'],
    'construction': ['building', 'labor', 'mason', 'carpenter', 'plumber', 'electrician'],
    'cooking': ['chef', 'kitchen', 'culinary', 'food preparation', 'catering']
};

/**
 * Calculate match score between candidate and job
 */
function calculateMatchScore(candidate, job) {
    const candidateSkills = (candidate.tags || candidate.skills || []).map(s => s.toLowerCase());
    const candidateMetadata = typeof candidate.metadata === 'string'
        ? JSON.parse(candidate.metadata || '{}')
        : (candidate.metadata || {});

    const jobRequirements = typeof job.requirements === 'string'
        ? JSON.parse(job.requirements || '{}')
        : (job.requirements || {});

    const requiredSkills = (jobRequirements.required_skills || []).map(s => s.toLowerCase());

    let scoreFactors = [];
    let totalScore = 0;
    let maxScore = 0;

    // 1. Skill matching (40% weight)
    if (requiredSkills.length > 0) {
        maxScore += 40;
        let skillScore = 0;
        let matchedSkills = [];
        let missingSkills = [];

        for (const reqSkill of requiredSkills) {
            // Exact match
            if (candidateSkills.some(cs => cs.includes(reqSkill) || reqSkill.includes(cs))) {
                skillScore += SKILL_WEIGHTS.exact_match;
                matchedSkills.push(reqSkill);
            }
            // Related match
            else if (Object.entries(RELATED_SKILLS).some(([key, related]) => {
                return (reqSkill.includes(key) || key.includes(reqSkill)) &&
                    candidateSkills.some(cs => related.some(r => cs.includes(r)));
            })) {
                skillScore += SKILL_WEIGHTS.related_match;
                matchedSkills.push(`${reqSkill} (related)`);
            }
            else {
                missingSkills.push(reqSkill);
            }
        }

        const normalizedSkillScore = (skillScore / requiredSkills.length) * 40;
        totalScore += normalizedSkillScore;
        scoreFactors.push({
            factor: 'skills',
            score: normalizedSkillScore.toFixed(1),
            matched: matchedSkills,
            missing: missingSkills
        });
    }

    // 2. Experience matching (20% weight)
    const reqMinExp = jobRequirements.min_experience_years || 0;
    const candidateExp = candidateMetadata.experience_years || 0;
    maxScore += 20;

    if (candidateExp >= reqMinExp) {
        totalScore += 20;
        scoreFactors.push({ factor: 'experience', score: 20, detail: `${candidateExp} years (required: ${reqMinExp})` });
    } else if (candidateExp >= reqMinExp - 1) {
        totalScore += 10;
        scoreFactors.push({ factor: 'experience', score: 10, detail: `${candidateExp} years (slightly below ${reqMinExp})` });
    } else {
        scoreFactors.push({ factor: 'experience', score: 0, detail: `${candidateExp} years (required: ${reqMinExp})` });
    }

    // 3. Height matching (15% weight) - if applicable
    if (jobRequirements.min_height_cm) {
        maxScore += 15;
        const candidateHeight = candidateMetadata.height_cm || 0;
        const tolerance = (job.wiggle_room?.height_tolerance_cm) || 5;

        if (candidateHeight >= jobRequirements.min_height_cm) {
            totalScore += 15;
            scoreFactors.push({ factor: 'height', score: 15, detail: `${candidateHeight}cm (required: ${jobRequirements.min_height_cm}cm)` });
        } else if (candidateHeight >= jobRequirements.min_height_cm - tolerance) {
            totalScore += 8;
            scoreFactors.push({ factor: 'height', score: 8, detail: `${candidateHeight}cm (within tolerance of ${jobRequirements.min_height_cm}cm)` });
        } else {
            scoreFactors.push({ factor: 'height', score: 0, detail: `${candidateHeight}cm (required: ${jobRequirements.min_height_cm}cm)` });
        }
    }

    // 4. Age matching (15% weight) - if applicable
    if (jobRequirements.min_age || jobRequirements.max_age) {
        maxScore += 15;
        const candidateAge = candidateMetadata.age || 0;
        const minAge = jobRequirements.min_age || 18;
        const maxAge = jobRequirements.max_age || 60;
        const tolerance = (job.wiggle_room?.age_tolerance_years) || 2;

        if (candidateAge >= minAge && candidateAge <= maxAge) {
            totalScore += 15;
            scoreFactors.push({ factor: 'age', score: 15, detail: `${candidateAge} years (range: ${minAge}-${maxAge})` });
        } else if (candidateAge >= minAge - tolerance && candidateAge <= maxAge + tolerance) {
            totalScore += 8;
            scoreFactors.push({ factor: 'age', score: 8, detail: `${candidateAge} years (within tolerance)` });
        } else {
            scoreFactors.push({ factor: 'age', score: 0, detail: `${candidateAge} years (outside range: ${minAge}-${maxAge})` });
        }
    }

    // 5. Language matching (10% weight)
    const requiredLanguages = (jobRequirements.required_languages || []).map(l => l.toLowerCase());
    if (requiredLanguages.length > 0) {
        maxScore += 10;
        const candidateLanguages = (candidate.languages || candidateMetadata.languages || []).map(l => l.toLowerCase());
        const matchedLangs = requiredLanguages.filter(rl =>
            candidateLanguages.some(cl => cl.includes(rl) || rl.includes(cl))
        );
        const langScore = (matchedLangs.length / requiredLanguages.length) * 10;
        totalScore += langScore;
        scoreFactors.push({
            factor: 'languages',
            score: langScore.toFixed(1),
            detail: `${matchedLangs.length}/${requiredLanguages.length} languages`
        });
    }

    // Calculate final percentage
    const finalScore = maxScore > 0 ? (totalScore / maxScore) * 100 : 0;

    return {
        score: Math.round(finalScore),
        factors: scoreFactors,
        is_qualified: finalScore >= 50, // At least 50% match
        is_excellent: finalScore >= 80   // Excellent match
    };
}

/**
 * Auto-assign a single candidate to matching jobs
 */
router.post('/candidate/:candidateId', authenticate, async (req, res, next) => {
    try {
        const { candidateId } = req.params;
        const { threshold = 50 } = req.body; // Minimum match score to assign

        // Get candidate
        const candidateResult = await pool.query(
            'SELECT * FROM candidates WHERE id = $1',
            [candidateId]
        );

        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        const candidate = candidateResult.rows[0];

        // Get all active jobs
        const jobsResult = await pool.query(
            `SELECT * FROM jobs WHERE status = 'active' AND (positions_available - COALESCE(positions_filled, 0)) > 0`
        );

        // Get existing applications for this candidate
        const existingAppsResult = await pool.query(
            'SELECT job_id FROM applications WHERE candidate_id = $1',
            [candidateId]
        );
        const existingJobIds = existingAppsResult.rows.map(a => a.job_id);

        const assignments = [];
        const rejectedJobs = [];

        for (const job of jobsResult.rows) {
            // Skip if already applied
            if (existingJobIds.includes(job.id)) continue;

            const matchResult = calculateMatchScore(candidate, job);

            if (matchResult.score >= threshold) {
                // Create application
                const appResult = await pool.query(
                    `INSERT INTO applications (candidate_id, job_id, status, match_score, screening_details)
                     VALUES ($1, $2, 'auto_assigned', $3, $4)
                     RETURNING *`,
                    [candidateId, job.id, matchResult.score / 100, JSON.stringify(matchResult)]
                );

                assignments.push({
                    job_id: job.id,
                    job_title: job.title,
                    job_category: job.category,
                    match_score: matchResult.score,
                    match_details: matchResult.factors,
                    application: appResult.rows[0]
                });
            } else {
                rejectedJobs.push({
                    job_id: job.id,
                    job_title: job.title,
                    match_score: matchResult.score,
                    reasons: matchResult.factors.filter(f => parseFloat(f.score) === 0)
                });
            }
        }

        // If no jobs matched, move to future pool
        if (assignments.length === 0 && candidate.status !== 'future_pool') {
            await pool.query(
                `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1`,
                [candidateId]
            );

            logger.info(`Candidate ${candidateId} moved to future pool - no matching jobs`);
        }

        res.json({
            candidate_id: candidateId,
            candidate_name: candidate.name,
            assignments,
            rejected_jobs: rejectedJobs.slice(0, 5), // Top 5 rejected
            moved_to_pool: assignments.length === 0,
            message: assignments.length > 0
                ? `Assigned to ${assignments.length} jobs`
                : 'No matching jobs found - moved to future pool'
        });

    } catch (error) {
        logger.error('Auto-assign error:', error);
        next(error);
    }
});

/**
 * Auto-assign all new candidates
 */
router.post('/batch', authenticate, async (req, res, next) => {
    try {
        const { threshold = 50, status = 'new' } = req.body;

        // Get candidates to process
        const candidatesResult = await pool.query(
            `SELECT * FROM candidates WHERE status = $1 LIMIT 50`,
            [status]
        );

        const results = {
            processed: 0,
            assigned: 0,
            to_pool: 0,
            details: []
        };

        for (const candidate of candidatesResult.rows) {
            // Get active jobs with positions
            const jobsResult = await pool.query(
                `SELECT * FROM jobs WHERE status = 'active' AND (positions_available - COALESCE(positions_filled, 0)) > 0`
            );

            // Get existing applications
            const existingAppsResult = await pool.query(
                'SELECT job_id FROM applications WHERE candidate_id = $1',
                [candidate.id]
            );
            const existingJobIds = existingAppsResult.rows.map(a => a.job_id);

            let assignedCount = 0;

            for (const job of jobsResult.rows) {
                if (existingJobIds.includes(job.id)) continue;

                const matchResult = calculateMatchScore(candidate, job);

                if (matchResult.score >= threshold) {
                    await pool.query(
                        `INSERT INTO applications (candidate_id, job_id, status, match_score, screening_details)
                         VALUES ($1, $2, 'auto_assigned', $3, $4)`,
                        [candidate.id, job.id, matchResult.score / 100, JSON.stringify(matchResult)]
                    );
                    assignedCount++;
                }
            }

            if (assignedCount === 0) {
                await pool.query(
                    `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1`,
                    [candidate.id]
                );
                results.to_pool++;
            } else {
                await pool.query(
                    `UPDATE candidates SET status = 'screening', updated_at = NOW() WHERE id = $1`,
                    [candidate.id]
                );
                results.assigned++;
            }

            results.processed++;
            results.details.push({
                candidate_id: candidate.id,
                name: candidate.name,
                jobs_assigned: assignedCount,
                moved_to_pool: assignedCount === 0
            });
        }

        res.json(results);

    } catch (error) {
        logger.error('Batch auto-assign error:', error);
        next(error);
    }
});

/**
 * Get candidates assigned to a job with match details
 */
router.get('/job/:jobId/candidates', authenticate, async (req, res, next) => {
    try {
        const { jobId } = req.params;
        const { status } = req.query;

        let query = `
            SELECT 
                a.id as application_id,
                a.status as application_status,
                a.match_score,
                a.screening_details,
                a.applied_at,
                a.certified_at,
                a.certified_by,
                a.certification_notes,
                c.id as candidate_id,
                c.name,
                c.phone,
                c.email,
                c.source,
                c.tags,
                c.metadata,
                c.notes as candidate_notes,
                c.preferred_language,
                cv.storage_url as cv_url,
                cv.file_name as cv_filename
            FROM applications a
            JOIN candidates c ON a.candidate_id = c.id
            LEFT JOIN cv_files cv ON c.id = cv.candidate_id AND cv.is_latest = true
            WHERE a.job_id = $1
        `;

        const params = [jobId];

        if (status) {
            query += ` AND a.status = $2`;
            params.push(status);
        }

        query += ` ORDER BY a.match_score DESC, a.applied_at DESC`;

        const result = await pool.query(query, params);

        // Get job details
        const jobResult = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);

        if (jobResult.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const job = jobResult.rows[0];

        // Enhance each candidate with recalculated match if needed
        const candidates = result.rows.map(row => {
            const screeningDetails = typeof row.screening_details === 'string'
                ? JSON.parse(row.screening_details || '{}')
                : (row.screening_details || {});

            return {
                application_id: row.application_id,
                application_status: row.application_status,
                match_score: Math.round((row.match_score || 0) * 100),
                match_details: screeningDetails.factors || [],
                applied_at: row.applied_at,
                certified_at: row.certified_at,
                certified_by: row.certified_by,
                certification_notes: row.certification_notes,
                candidate: {
                    id: row.candidate_id,
                    name: row.name,
                    phone: row.phone,
                    email: row.email,
                    source: row.source,
                    tags: row.tags,
                    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : (row.metadata || {}),
                    notes: row.candidate_notes,
                    preferred_language: row.preferred_language,
                    cv_url: row.cv_url,
                    cv_filename: row.cv_filename
                }
            };
        });

        res.json({
            job: {
                id: job.id,
                title: job.title,
                category: job.category,
                status: job.status,
                positions_available: job.positions_available,
                positions_filled: job.positions_filled || 0,
                requirements: job.requirements
            },
            total_candidates: candidates.length,
            candidates,
            stats: {
                excellent: candidates.filter(c => c.match_score >= 80).length,
                good: candidates.filter(c => c.match_score >= 60 && c.match_score < 80).length,
                fair: candidates.filter(c => c.match_score >= 50 && c.match_score < 60).length,
                certified: candidates.filter(c => c.application_status === 'certified').length,
                pending: candidates.filter(c => ['auto_assigned', 'applied', 'reviewing'].includes(c.application_status)).length
            }
        });

    } catch (error) {
        logger.error('Get job candidates error:', error);
        next(error);
    }
});

/**
 * Get future pool candidates
 */
router.get('/pool', authenticate, async (req, res, next) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        const result = await pool.query(
            `SELECT c.*, cv.storage_url as cv_url
             FROM candidates c
             LEFT JOIN cv_files cv ON c.id = cv.candidate_id AND cv.is_latest = true
             WHERE c.status = 'future_pool'
             ORDER BY c.updated_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const countResult = await pool.query(
            `SELECT COUNT(*) FROM candidates WHERE status = 'future_pool'`
        );

        res.json({
            data: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(countResult.rows[0].count),
                totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit)
            }
        });

    } catch (error) {
        next(error);
    }
});

/**
 * Get alternative jobs for a candidate (excluding current job)
 * GET /api/auto-assign/candidate/:id/alternatives?threshold=40
 */
router.get('/candidate/:id/alternatives', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { threshold = 40 } = req.query;

        const candidateResult = await pool.query('SELECT * FROM candidates WHERE id = $1', [id]);
        if (candidateResult.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });
        const candidate = candidateResult.rows[0];

        // Active jobs the candidate has NOT already applied to
        const existingApps = await pool.query('SELECT job_id FROM applications WHERE candidate_id = $1', [id]);
        const existingJobIds = existingApps.rows.map(a => a.job_id);

        const jobsResult = await pool.query(
            `SELECT j.*, p.title as project_name FROM jobs j
             LEFT JOIN projects p ON j.project_id = p.id
             WHERE j.status = 'active' AND (j.positions_available - COALESCE(j.positions_filled, 0)) > 0`
        );

        const scored = jobsResult.rows
            .filter(j => !existingJobIds.includes(j.id))
            .map(j => {
                const matchResult = calculateMatchScore(candidate, j);
                // Build a short human-readable reason string
                const topFactors = (matchResult.factors || [])
                    .filter(f => parseFloat(f.score) > 0)
                    .map(f => f.factor)
                    .slice(0, 3);
                const reason = topFactors.length
                    ? `Matches on: ${topFactors.join(', ')}`
                    : null;
                return {
                    job_id: j.id,
                    job_title: j.title,
                    project_name: j.project_name || null,
                    match_score: matchResult.score,
                    reason
                };
            })
            .filter(j => j.match_score >= parseInt(threshold))
            .sort((a, b) => b.match_score - a.match_score)
            .slice(0, 3);

        res.json({ alternatives: scored });
    } catch (error) {
        logger.error('Get alternatives error:', error);
        next(error);
    }
});

module.exports = router;
