const express = require('express');
const router = express.Router();
const { query, generateUUID, withTransaction } = require('../config/database');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate, authorize } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const { syncJobAsync, syncJobDeleteAsync } = require('./chatbot-sync');
const chatbotOutbox = require('../services/chatbot-outbox');
const { buildProjectPayload } = require('../services/chatbot-payloads');
const logger = require('../utils/logger');

async function _enqueueProjectUpsert(projectId) {
    if (!projectId) return;
    try {
        const result = await query(
            isMySQL ? 'SELECT * FROM projects WHERE id = ?' : 'SELECT * FROM projects WHERE id = $1',
            [projectId]
        );
        const row = result.rows && result.rows[0];
        if (!row) return;
        await chatbotOutbox.enqueue({
            doc_id: `project_${row.id}`,
            doc_type: 'project_desc',
            operation: 'upsert',
            payload: buildProjectPayload(row),
        });
    } catch (err) {
        logger.warn(`Project outbox enqueue failed for ${projectId}: ${err.message}`);
    }
}

async function _enqueueProjectDelete(projectId) {
    if (!projectId) return;
    try {
        await chatbotOutbox.enqueue({
            doc_id: `project_${projectId}`,
            doc_type: 'project_desc',
            operation: 'delete',
            payload: { doc_id: `project_${projectId}` },
        });
    } catch (err) {
        logger.warn(`Project outbox delete enqueue failed for ${projectId}: ${err.message}`);
    }
}

// Date columns are DATE in Postgres, which rejects '' with "invalid input
// syntax for type date". The UI sends '' for un-filled optional dates, so map
// empty/blank strings to null before they reach the query.
function emptyToNull(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return value;
}

function normalizeProjectPayload(body = {}) {
    const countriesInput = body.countries || body.country_of_recruitment || [];
    const countries = Array.isArray(countriesInput) ? countriesInput : [];

    // Industries: prefer the new array column, fall back to single legacy field.
    let industry_types = [];
    if (Array.isArray(body.industry_types)) {
        industry_types = body.industry_types
            .map((s) => (typeof s === 'string' ? s.trim() : ''))
            .filter(Boolean);
    } else if (typeof body.industry_type === 'string' && body.industry_type.trim()) {
        industry_types = [body.industry_type.trim()];
    }
    // Derive the legacy single field from the first element so old readers
    // still see a sensible value. Empty string when nothing was provided.
    const industry_type = industry_types[0] || (typeof body.industry_type === 'string' ? body.industry_type : '');

    const salaryInfo = {
        ...(body.salary_info || {}),
    };
    if (body.currency && !salaryInfo.currency) {
        salaryInfo.currency = body.currency;
    }

    const mergedContactInfo = {
        ...(body.contact_info || {}),
    };

    if (body.client_details && typeof body.client_details === 'object') {
        if (body.client_details.mobile && !mergedContactInfo.mobile) mergedContactInfo.mobile = body.client_details.mobile;
        if (body.client_details.email && !mergedContactInfo.email) mergedContactInfo.email = body.client_details.email;
        if (body.client_details.address && !mergedContactInfo.address) mergedContactInfo.address = body.client_details.address;
        if (body.client_details.special_details && !mergedContactInfo.special_details) {
            mergedContactInfo.special_details = body.client_details.special_details;
        }
    }

    return {
        countries,
        industry_types,
        industry_type,
        salary_info: salaryInfo,
        contact_info: mergedContactInfo,
    };
}

/**
 * Get all projects with filters
 */
router.get('/', authenticate, requireSection('projects', 'view'), async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            country,
            industry_type,
            client_name,
            priority,
            search,
            start_date_from,
            start_date_to,
            interview_date_from,
            interview_date_to
        } = req.query;

        const offset = (page - 1) * limit;
        let whereClause = ' WHERE 1=1';
        const params = [];
        let paramCount = 1;

        if (status) {
            whereClause += isMySQL ? ' AND status = ?' : ` AND status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (industry_type) {
            // Match either the legacy single column OR the new JSONB array — so
            // projects created after the multi-industry migration are still
            // filterable by a single-value dropdown.
            if (isMySQL) {
                whereClause += ` AND (industry_type = ? OR JSON_CONTAINS(industry_types, JSON_QUOTE(?)))`;
                params.push(industry_type, industry_type);
                paramCount += 2;
            } else {
                whereClause += ` AND (industry_type = $${paramCount} OR industry_types @> $${paramCount + 1}::jsonb)`;
                params.push(industry_type, JSON.stringify([industry_type]));
                paramCount += 2;
            }
        }

        if (priority) {
            whereClause += isMySQL ? ' AND priority = ?' : ` AND priority = $${paramCount}`;
            params.push(priority);
            paramCount++;
        }

        if (client_name) {
            whereClause += isMySQL ? ' AND client_name LIKE ?' : ` AND client_name ILIKE $${paramCount}`;
            params.push(`%${client_name}%`);
            paramCount++;
        }

        if (search) {
            whereClause += isMySQL ? ' AND (title LIKE ? OR description LIKE ?)' : ` AND (title ILIKE $${paramCount} OR description ILIKE $${paramCount + 1})`;
            params.push(`%${search}%`, `%${search}%`);
            paramCount += 2;
        }

        if (country) {
            if (isMySQL) {
                whereClause += ` AND JSON_CONTAINS(countries, '"${country}"')`;
            } else {
                whereClause += ` AND countries @> $${paramCount}::jsonb`;
                params.push(JSON.stringify([country]));
                paramCount++;
            }
        }

        if (start_date_from) {
            whereClause += isMySQL ? ' AND start_date >= ?' : ` AND start_date >= $${paramCount}`;
            params.push(start_date_from);
            paramCount++;
        }

        if (start_date_to) {
            whereClause += isMySQL ? ' AND start_date <= ?' : ` AND start_date <= $${paramCount}`;
            params.push(start_date_to);
            paramCount++;
        }

        if (interview_date_from) {
            whereClause += isMySQL ? ' AND interview_date >= ?' : ` AND interview_date >= $${paramCount}`;
            params.push(interview_date_from);
            paramCount++;
        }

        if (interview_date_to) {
            whereClause += isMySQL ? ' AND interview_date <= ?' : ` AND interview_date <= $${paramCount}`;
            params.push(interview_date_to);
            paramCount++;
        }

        // Get total count
        const countResult = await query(
            `SELECT COUNT(*) as count FROM projects${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].count);

        // Get paginated results. Team/job counts AND the progress numbers are
        // derived LIVE here (one round-trip) instead of trusting the stale
        // projects.filled_positions column, which the app never writes:
        //   filled_positions     = hired applications across the project's jobs
        //   interviews_scheduled = rows in interview_schedules under the project
        //   total_positions stays the admin-set headcount target from p.*.
        // The derived count uses a DISTINCT alias (derived_filled) so it never
        // collides with the stale p.filled_positions column — the map below then
        // overwrites filled_positions with it explicitly (no column-order luck).
        const selectCols = `SELECT p.*,
                   (SELECT COUNT(DISTINCT pa.user_id) FROM project_assignments pa WHERE pa.project_id = p.id) AS team_count,
                   (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id) AS job_count,
                   (SELECT COUNT(*) FROM applications a JOIN jobs j ON a.job_id = j.id WHERE j.project_id = p.id AND a.status = 'hired') AS derived_filled,
                   (SELECT COUNT(*) FROM applications a JOIN jobs j ON a.job_id = j.id WHERE j.project_id = p.id) AS total_applications,
                   (SELECT COUNT(*) FROM applications a JOIN jobs j ON a.job_id = j.id WHERE j.project_id = p.id AND a.status = 'certified') AS certified_count,
                   (SELECT COUNT(*) FROM interview_schedules s JOIN applications a ON s.application_id = a.id JOIN jobs j ON a.job_id = j.id WHERE j.project_id = p.id) AS interviews_scheduled
               FROM projects p${whereClause}`;
        const listQuery = isMySQL
            ? `${selectCols} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
            : `${selectCols} ORDER BY p.created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;

        const listResult = await query(listQuery, [...params, parseInt(limit), parseInt(offset)]);

        const projectsWithCounts = listResult.rows.map((project) => ({
            ...project,
            team_count: parseInt(project.team_count, 10) || 0,
            job_count: parseInt(project.job_count, 10) || 0,
            filled_positions: parseInt(project.derived_filled, 10) || 0,
            total_applications: parseInt(project.total_applications, 10) || 0,
            certified_count: parseInt(project.certified_count, 10) || 0,
            interviews_scheduled: parseInt(project.interviews_scheduled, 10) || 0,
        }));

        res.json({
            data: projectsWithCounts,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Get project by ID with detailed information
 */
router.get('/:id', authenticate, requireSection('projects', 'view'), async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(
            isMySQL ? 'SELECT * FROM projects WHERE id = ?' : 'SELECT * FROM projects WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const project = result.rows[0];

        // Get team members
        const teamQuery = isMySQL
            ? `SELECT pa.*, u.full_name, u.email, u.role as user_role 
               FROM project_assignments pa 
               JOIN users u ON pa.user_id = u.id 
               WHERE pa.project_id = ? 
               ORDER BY pa.assigned_at DESC`
            : `SELECT pa.*, u.full_name, u.email, u.role as user_role 
               FROM project_assignments pa 
               JOIN users u ON pa.user_id = u.id 
               WHERE pa.project_id = $1 
               ORDER BY pa.assigned_at DESC`;

        const teamResult = await query(teamQuery, [id]);

        // Get jobs linked to this project
        const jobsQuery = isMySQL
            ? `SELECT j.*, COUNT(a.id) as candidate_count 
               FROM jobs j 
               LEFT JOIN applications a ON j.id = a.job_id 
               WHERE j.project_id = ? 
               GROUP BY j.id 
               ORDER BY j.created_at DESC`
            : `SELECT j.*, COUNT(a.id) as candidate_count 
               FROM jobs j 
               LEFT JOIN applications a ON j.id = a.job_id 
               WHERE j.project_id = $1 
               GROUP BY j.id 
               ORDER BY j.created_at DESC`;

        const jobsResult = await query(jobsQuery, [id]);

        // Get statistics
        const statsQuery = isMySQL
            ? `SELECT 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_scheduled,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM applications a
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = ?`
            : `SELECT 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_scheduled,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM applications a
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = $1`;

        const statsResult = await query(statsQuery, [id]);

        res.json({
            ...project,
            team: teamResult.rows,
            jobs: jobsResult.rows,
            stats: statsResult.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Create new project
 */
router.post('/', authenticate, requireSection('projects', 'create'), authorize('admin', 'sourcing_department', 'project_handler'), async (req, res, next) => {
    try {
        const {
            title,
            client_name,
            description,
            status = 'planning',
            priority = 'normal',
            total_positions = 0,
            start_date,
            interview_date,
            end_date,
            benefits,
            requirements,
            metadata
        } = req.body;

        const normalized = normalizeProjectPayload(req.body);

        // A "future project" is a pipeline project an agent can park candidates in
        // before it's officially active (shows in the transfer/assign pickers).
        // Future projects can be created lightweight (just a name) straight from
        // the Messages picker — the client/industry/country details get filled in
        // later when the project goes active, so default them here.
        const isFuture = req.body.is_future === true;
        const effClientName = client_name || (isFuture ? 'Pipeline (future)' : null);
        const effIndustryTypes = normalized.industry_types.length
            ? normalized.industry_types
            : (isFuture ? ['general'] : []);
        const effCountries = (normalized.countries && normalized.countries.length)
            ? normalized.countries
            : (isFuture ? ['Unspecified'] : []);
        const effIndustryType = effIndustryTypes[0] || normalized.industry_type || '';

        if (!title || !effClientName || effIndustryTypes.length === 0 || effCountries.length === 0) {
            return res.status(400).json({ error: 'Title, client name, at least one industry, and at least one country are required' });
        }

        // The create form leaves optional date fields as '' (empty string).
        // Postgres DATE columns reject '' ("invalid input syntax for type date"),
        // which would 500 and prevent the project from being created. Coerce to null.
        const startDate = emptyToNull(start_date);
        const interviewDate = emptyToNull(interview_date);
        const endDate = emptyToNull(end_date);

        const userId = req.user.id;
        const industryTypesJson = JSON.stringify(effIndustryTypes);
        const countriesJson = JSON.stringify(effCountries);

        if (isMySQL) {
            const id = generateUUID();
            await query(
                `INSERT INTO projects (id, title, client_name, industry_type, industry_types, description, countries, status, priority,
                 total_positions, start_date, interview_date, end_date, benefits, salary_info, contact_info,
                 requirements, metadata, is_future, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id, title, effClientName, effIndustryType, industryTypesJson, description,
                    countriesJson, status, priority, total_positions,
                    startDate, interviewDate, endDate,
                    JSON.stringify(benefits || {}),
                    JSON.stringify(normalized.salary_info),
                    JSON.stringify(normalized.contact_info),
                    JSON.stringify(requirements || {}),
                    JSON.stringify(metadata || {}),
                    isFuture,
                    userId
                ]
            );

            // Auto-assign creator as owner
            const assignmentId = generateUUID();
            await query(
                'INSERT INTO project_assignments (id, project_id, user_id, role, assigned_by) VALUES (?, ?, ?, ?, ?)',
                [assignmentId, id, userId, 'owner', userId]
            );

            const result = await query('SELECT * FROM projects WHERE id = ?', [id]);
            _enqueueProjectUpsert(id);
            res.status(201).json(result.rows[0]);
        } else {
            const result = await query(
                `INSERT INTO projects (title, client_name, industry_type, industry_types, description, countries, status, priority,
                 total_positions, start_date, interview_date, end_date, benefits, salary_info, contact_info,
                 requirements, metadata, is_future, created_by)
                 VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18, $19)
                 RETURNING *`,
                [
                    title, effClientName, effIndustryType, industryTypesJson, description,
                    countriesJson, status, priority, total_positions,
                    startDate, interviewDate, endDate,
                    JSON.stringify(benefits || {}),
                    JSON.stringify(normalized.salary_info),
                    JSON.stringify(normalized.contact_info),
                    JSON.stringify(requirements || {}),
                    JSON.stringify(metadata || {}),
                    isFuture,
                    userId
                ]
            );

            // Auto-assign creator as owner
            await query(
                'INSERT INTO project_assignments (project_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4)',
                [result.rows[0].id, userId, 'owner', userId]
            );

            _enqueueProjectUpsert(result.rows[0].id);
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Update project
 */
router.put('/:id', authenticate, requireSection('projects', 'edit'), authorize('admin', 'sourcing_department', 'project_handler'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = { ...req.body };

        if (updates.country_of_recruitment && !updates.countries) {
            updates.countries = updates.country_of_recruitment;
        }

        // Normalize multi-industry input. If the client sends an array, also
        // sync the legacy industry_type column to the first element.
        if (Array.isArray(updates.industry_types)) {
            updates.industry_types = updates.industry_types
                .map((s) => (typeof s === 'string' ? s.trim() : ''))
                .filter(Boolean);
            if (updates.industry_types.length > 0) {
                updates.industry_type = updates.industry_types[0];
            }
        } else if (typeof updates.industry_type === 'string' && updates.industry_type.trim()) {
            // If only the legacy field was sent, mirror it into the array.
            updates.industry_types = [updates.industry_type.trim()];
        }

        if (updates.currency) {
            updates.salary_info = {
                ...(updates.salary_info || {}),
                currency: updates.currency,
            };
        }

        if (updates.client_details && typeof updates.client_details === 'object') {
            updates.contact_info = {
                ...(updates.contact_info || {}),
                mobile: updates.client_details.mobile || updates.contact_info?.mobile,
                email: updates.client_details.email || updates.contact_info?.email,
                address: updates.client_details.address || updates.contact_info?.address,
                special_details: updates.client_details.special_details || updates.contact_info?.special_details,
            };
        }

        const allowedFields = [
            'title', 'client_name', 'industry_type', 'industry_types', 'description', 'countries',
            'status', 'priority', 'total_positions', 'filled_positions',
            'start_date', 'interview_date', 'end_date', 'benefits',
            'salary_info', 'contact_info', 'requirements', 'metadata', 'is_future'
        ];

        const setClause = [];
        const values = [];
        let paramCount = 1;

        Object.keys(updates).forEach(key => {
            if (allowedFields.includes(key)) {
                if (isMySQL) {
                    setClause.push(`${key} = ?`);
                } else {
                    setClause.push(`${key} = $${paramCount}`);
                    paramCount++;
                }

                // Stringify JSON fields (industry_types joins this group post-migration).
                if (['countries', 'industry_types', 'benefits', 'salary_info', 'contact_info', 'requirements', 'metadata'].includes(key)) {
                    values.push(JSON.stringify(updates[key]));
                } else if (['start_date', 'interview_date', 'end_date'].includes(key)) {
                    // '' would break the DATE column on update too — see emptyToNull.
                    values.push(emptyToNull(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        });

        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(id);

        const updateQuery = isMySQL
            ? `UPDATE projects SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
            : `UPDATE projects SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount} RETURNING *`;

        const result = await query(updateQuery, values);

        if (isMySQL) {
            const selectResult = await query('SELECT * FROM projects WHERE id = ?', [id]);
            if (selectResult.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            res.json(selectResult.rows[0]);
        } else {
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            res.json(result.rows[0]);
        }

        // Re-sync the project itself + cascade to all active jobs so the
        // chatbot picks up updated benefits, salary_info, interview_date, etc.
        // All paths go through the outbox — survives chatbot restarts.
        _enqueueProjectUpsert(id);
        setImmediate(async () => {
            try {
                const jobsSQL = isMySQL
                    ? `SELECT id FROM jobs WHERE project_id = ? AND status = 'active'`
                    : `SELECT id FROM jobs WHERE project_id = $1 AND status = 'active'`;
                const jobsResult = await query(jobsSQL, [id]);
                for (const job of jobsResult.rows) {
                    await syncJobAsync(job.id).catch(err =>
                        logger.warn(`Project update: outbox enqueue failed for job ${job.id}: ${err.message}`)
                    );
                }
                if (jobsResult.rows.length > 0) {
                    logger.info(`Project ${id} update: enqueued ${jobsResult.rows.length} jobs for chatbot resync`);
                }
            } catch (err) {
                logger.warn(`Project ${id} update: chatbot job re-sync failed: ${err.message}`);
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Delete project — UNLINK its jobs.
 *
 * Deleting a project DETACHES its jobs (jobs.project_id → NULL) and removes the
 * project; the jobs (and their applications / interviews) are preserved, just
 * unlinked. This needs jobs.project_id to be nullable with an ON DELETE SET NULL
 * FK (see migration 052) — it used to be NOT NULL + ON DELETE RESTRICT, which
 * 500'd the `UPDATE jobs SET project_id = NULL` below, so deleting any project
 * that had jobs always failed. Runs in one transaction so a failure can't leave
 * jobs half-detached. The frontend confirms "all related jobs will be unlinked".
 */
router.delete('/:id', authenticate, requireSection('projects', 'delete'), authorize('admin'), async (req, res, next) => {
    try {
        const { id } = req.params;

        // Snapshot affected jobs (read-only) so we can re-sync their now-detached
        // state to the bot AFTER a successful commit — never before (a rollback
        // must not desync the chatbot).
        const jobsSnap = await query(
            isMySQL ? 'SELECT id FROM jobs WHERE project_id = ?' : 'SELECT id FROM jobs WHERE project_id = $1',
            [id]
        );
        const affectedJobIds = (jobsSnap.rows || []).map((r) => r.id);

        const runUnlink = async (run) => {
            // Detach the jobs first (project_id is nullable; the FK is ON DELETE
            // SET NULL) so the project row can be removed without destroying its
            // jobs / applications / interviews.
            await run(
                isMySQL ? 'UPDATE jobs SET project_id = NULL WHERE project_id = ?' : 'UPDATE jobs SET project_id = NULL WHERE project_id = $1',
                [id]
            );
            // Deleting the project cascades project_assignments + project ad_tracking.
            return run(
                isMySQL ? 'DELETE FROM projects WHERE id = ?' : 'DELETE FROM projects WHERE id = $1 RETURNING *',
                [id]
            );
        };

        let result;
        if (typeof withTransaction === 'function') {
            // One transaction so the job-unlink and the project delete commit or
            // roll back together (no partial-detach window).
            result = await withTransaction((conn) => runUnlink((sql, p) => conn.query(sql, p)));
        } else {
            // Legacy fallback only if no transaction helper exists at all.
            result = await runUnlink((sql, p) => query(sql, p));
        }

        if (!isMySQL && result.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // After commit: drop the project from the bot and re-sync each now-orphaned
        // job so its cached project metadata is cleared (the jobs still exist).
        _enqueueProjectDelete(id);
        setImmediate(async () => {
            for (const jobId of affectedJobIds) {
                await syncJobAsync(jobId).catch(err =>
                    logger.warn(`Project delete: orphaned-job re-sync failed for ${jobId}: ${err.message}`)
                );
            }
        });

        if (isMySQL) {
            res.json({ message: 'Project deleted successfully', id, unlinked_jobs: affectedJobIds.length });
        } else {
            res.json({ message: 'Project deleted successfully', project: result.rows[0], unlinked_jobs: affectedJobIds.length });
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get jobs for a project
 */
router.get('/:id/jobs', authenticate, requireSection('projects', 'view'), async (req, res, next) => {
    try {
        const { id } = req.params;

        const jobsQuery = isMySQL
            ? `SELECT j.*,
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = ?
               GROUP BY j.id
               ORDER BY j.created_at DESC`
            : `SELECT j.*, 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = $1
               GROUP BY j.id
               ORDER BY j.created_at DESC`;

        const result = await query(jobsQuery, [id]);
        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Get candidates for a project (across all jobs)
 */
router.get('/:id/candidates', authenticate, requireSection('projects', 'view'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status, job_id } = req.query;

        let candidateQuery = isMySQL
            ? `SELECT c.*, a.status as application_status, a.match_score, a.applied_at,
                   j.id as job_id, j.title as job_title
               FROM candidates c
               JOIN applications a ON c.id = a.candidate_id
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = ?`
            : `SELECT c.*, a.status as application_status, a.match_score, a.applied_at,
                   j.id as job_id, j.title as job_title
               FROM candidates c
               JOIN applications a ON c.id = a.candidate_id
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = $1`;

        const params = [id];
        let paramCount = 2;

        if (status) {
            candidateQuery += isMySQL ? ' AND a.status = ?' : ` AND a.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (job_id) {
            candidateQuery += isMySQL ? ' AND j.id = ?' : ` AND j.id = $${paramCount}`;
            params.push(job_id);
            paramCount++;
        }

        candidateQuery += ' ORDER BY a.applied_at DESC';

        const result = await query(candidateQuery, params);
        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Assign team members to project
 */
router.post('/:id/assign-team', authenticate, requireSection('projects', 'edit'), authorize('admin', 'sourcing_department'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { user_id, role } = req.body;

        if (!user_id || !role) {
            return res.status(400).json({ error: 'User ID and role are required' });
        }

        if (!['owner', 'handler', 'agent', 'officer'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role. Must be: owner, handler, agent, or officer' });
        }

        // Check if project exists
        const projectResult = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectResult.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Check if user exists
        const userResult = await query(
            isMySQL ? 'SELECT id FROM users WHERE id = ?' : 'SELECT id FROM users WHERE id = $1',
            [user_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (isMySQL) {
            const assignmentId = generateUUID();
            await query(
                'INSERT INTO project_assignments (id, project_id, user_id, role, assigned_by) VALUES (?, ?, ?, ?, ?)',
                [assignmentId, id, user_id, role, req.user.id]
            );
            const result = await query('SELECT * FROM project_assignments WHERE id = ?', [assignmentId]);
            res.status(201).json(result.rows[0]);
        } else {
            const result = await query(
                'INSERT INTO project_assignments (project_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4) RETURNING *',
                [id, user_id, role, req.user.id]
            );
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        // Handle unique constraint violation
        if (error.code === '23505' || error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'User already assigned with this role' });
        }
        next(error);
    }
});

/**
 * Remove team member from project
 */
router.delete('/:id/team/:userId', authenticate, requireSection('projects', 'edit'), authorize('admin', 'sourcing_department'), async (req, res, next) => {
    try {
        const { id, userId } = req.params;

        const result = await query(
            isMySQL
                ? 'DELETE FROM project_assignments WHERE project_id = ? AND user_id = ?'
                : 'DELETE FROM project_assignments WHERE project_id = $1 AND user_id = $2 RETURNING *',
            [id, userId]
        );

        if (isMySQL) {
            res.json({ message: 'Team member removed successfully' });
        } else {
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Team member assignment not found' });
            }
            res.json({ message: 'Team member removed successfully' });
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get project statistics — full lifecycle breakdown.
 * One query, aggregates over all jobs in the project. Returns counts for
 * every status the UI cares about (applied / certified / pre_screened /
 * scheduled / selected / rejected) so the Project Detail progress panel
 * can render real-time numbers without per-status round-trips.
 */
router.get('/:id/stats', authenticate, requireSection('projects', 'view'), async (req, res, next) => {
    try {
        const { id } = req.params;

        // filled_positions is derived LIVE from hired applications (the stale
        // jobs.positions_filled column is never written). positions_capacity is
        // the sum of job headcounts; total_positions (the progress denominator)
        // is the admin-set project target, fetched separately so the detail page
        // matches the list's "X / target" bar.
        const statsBody = `SELECT
                   COUNT(DISTINCT j.id) as total_jobs,
                   COALESCE(SUM(j.positions_available), 0) as positions_capacity,
                   COUNT(DISTINCT CASE WHEN a.status = 'hired' THEN a.id END) as filled_positions,
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'screening' THEN a.id END) as applied_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'screening' THEN a.id END) as screening_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'certified' THEN a.id END) as certified_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'certified' THEN a.id END) as pre_screened_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interviewed_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'hired' THEN a.id END) as placed_count,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = `;
        const statsQuery = statsBody + (isMySQL ? '?' : '$1');

        // Interview schedules for this project (separate count, not via app.status)
        const interviewsCountQuery = isMySQL
            ? `SELECT COUNT(*) AS count FROM interview_schedules s
               JOIN applications a ON s.application_id = a.id
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = ?`
            : `SELECT COUNT(*)::int AS count FROM interview_schedules s
               JOIN applications a ON s.application_id = a.id
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = $1`;

        const targetQuery = isMySQL
            ? 'SELECT total_positions FROM projects WHERE id = ?'
            : 'SELECT total_positions FROM projects WHERE id = $1';

        const [statsResult, interviewsResult, targetResult] = await Promise.all([
            query(statsQuery, [id]),
            query(interviewsCountQuery, [id]).catch(() => ({ rows: [{ count: 0 }] })),
            query(targetQuery, [id]).catch(() => ({ rows: [] })),
        ]);

        const row = statsResult.rows[0] || {};
        const interviewsCount = parseInt(interviewsResult.rows[0]?.count, 10) || 0;
        const target = parseInt(targetResult.rows[0]?.total_positions, 10) || 0;

        res.json({
            ...row,
            total_positions: target,
            interviews_count: interviewsCount,
            interviews_scheduled: interviewsCount,
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Export project candidates/applications as CSV
 */
router.get('/:id/export/csv', authenticate, requireSection('projects', 'view'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status, job_id, date_from, date_to } = req.query;

        const projectExists = await query(
            isMySQL
                ? 'SELECT id, title FROM projects WHERE id = ?'
                : 'SELECT id, title FROM projects WHERE id = $1',
            [id]
        );

        if (projectExists.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const params = [id];
        let whereClause = isMySQL ? ' WHERE j.project_id = ?' : ' WHERE j.project_id = $1';

        const addFilter = (sqlMy, sqlPg, value) => {
            params.push(value);
            whereClause += isMySQL ? sqlMy : sqlPg.replace('IDX', String(params.length));
        };

        if (status) addFilter(' AND a.status = ?', ' AND a.status = $IDX', status);
        if (job_id) addFilter(' AND a.job_id = ?', ' AND a.job_id = $IDX', job_id);
        if (date_from) addFilter(' AND a.applied_at >= ?', ' AND a.applied_at >= $IDX', date_from);
        if (date_to) addFilter(' AND a.applied_at <= ?', ' AND a.applied_at <= $IDX', date_to);

        const exportQuery = `
            SELECT
                c.id AS candidate_id,
                c.name AS candidate_name,
                c.phone AS candidate_phone,
                c.email AS candidate_email,
                c.preferred_language,
                c.source AS candidate_source,
                p.id AS project_id,
                p.title AS project_title,
                p.client_name,
                j.id AS job_id,
                j.title AS job_title,
                a.id AS application_id,
                a.status AS application_status,
                a.match_score,
                a.applied_at,
                a.certified_at,
                COALESCE(
                    (SELECT iv.scheduled_datetime
                     FROM interview_schedules iv
                     WHERE iv.application_id = a.id
                     ORDER BY iv.scheduled_datetime DESC
                     LIMIT 1),
                    a.interview_datetime
                ) AS interview_datetime,
                COALESCE(
                    (SELECT iv.location
                     FROM interview_schedules iv
                     WHERE iv.application_id = a.id
                     ORDER BY iv.scheduled_datetime DESC
                     LIMIT 1),
                    a.interview_location
                ) AS interview_location,
                (SELECT iv.status
                 FROM interview_schedules iv
                 WHERE iv.application_id = a.id
                 ORDER BY iv.scheduled_datetime DESC
                 LIMIT 1) AS interview_status,
                (SELECT cv.file_url
                 FROM cv_files cv
                 WHERE cv.candidate_id = c.id
                 ORDER BY cv.is_primary DESC, cv.uploaded_at DESC
                 LIMIT 1) AS cv_link,
                (SELECT comm.channel
                 FROM communications comm
                 WHERE comm.candidate_id = c.id
                   AND comm.direction = 'outbound'
                 ORDER BY comm.sent_at DESC
                 LIMIT 1) AS last_communication_channel,
                (SELECT comm.sent_at
                 FROM communications comm
                 WHERE comm.candidate_id = c.id
                   AND comm.direction = 'outbound'
                 ORDER BY comm.sent_at DESC
                 LIMIT 1) AS last_communication_at,
                (SELECT CASE
                    WHEN comm.read_at IS NOT NULL THEN 'read'
                    WHEN comm.delivered_at IS NOT NULL THEN 'delivered'
                    WHEN comm.sent_at IS NOT NULL THEN 'sent'
                    ELSE 'none'
                 END
                 FROM communications comm
                 WHERE comm.candidate_id = c.id
                   AND comm.direction = 'outbound'
                 ORDER BY comm.sent_at DESC
                 LIMIT 1) AS communication_status
            FROM applications a
            JOIN candidates c ON c.id = a.candidate_id
            JOIN jobs j ON j.id = a.job_id
            JOIN projects p ON p.id = j.project_id
            ${whereClause}
            ORDER BY a.applied_at DESC
            LIMIT 10000
        `;

        const result = await query(exportQuery, params);
        const rows = result.rows || [];

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename=project_${projectExists.rows[0].id}_applications_export.csv`
        );

        if (rows.length === 0) {
            return res.send('No data found\n');
        }

        const headers = Object.keys(rows[0]);
        const escape = (value) => {
            if (value === null || value === undefined) return '';
            const str = String(value).replace(/"/g, '""');
            return /[",\n]/.test(str) ? `"${str}"` : str;
        };

        const csv = [
            headers.join(','),
            ...rows.map((row) => headers.map((header) => escape(row[header])).join(','))
        ].join('\n');

        return res.send(csv);
    } catch (error) {
        next(error);
    }
});

/**
 * Get all jobs for a specific project
 */
router.get('/:id/jobs', authenticate, requireSection('projects', 'view'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status } = req.query;

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        let jobsQuery;
        const params = [id];
        
        if (status) {
            jobsQuery = isMySQL
                ? `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = ? AND j.status = ?
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`
                : `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = $1 AND j.status = $2
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`;
            params.push(status);
        } else {
            jobsQuery = isMySQL
                ? `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = ? 
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`
                : `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = $1 
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`;
        }

        const result = await query(jobsQuery, params);

        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Create a new job for a specific project
 */
// Creating a job under a project is a JOBS create (matrix: jobs are view-only for
// project_handler), so gate on jobs.create — not projects.edit — to match POST /api/jobs.
router.post('/:id/jobs', authenticate, requireSection('jobs', 'create'), authorize('admin', 'sourcing_department'), async (req, res, next) => {
    try {
        const { id: project_id } = req.params;
        const {
            title,
            category,
            description,
            requirements,
            wiggle_room,
            positions_available,
            salary_range,
            location,
            deadline
        } = req.body;

        if (!title || !category || !requirements) {
            return res.status(400).json({ error: 'Title, category, and requirements are required' });
        }

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id, title FROM projects WHERE id = ?' : 'SELECT id, title FROM projects WHERE id = $1',
            [project_id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const jobId = generateUUID();
        const insertQuery = isMySQL
            ? `INSERT INTO jobs (id, title, category, description, requirements, wiggle_room, positions_available, salary_range, location, deadline, project_id, created_by, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`
            : `INSERT INTO jobs (title, category, description, requirements, wiggle_room, positions_available, salary_range, location, deadline, project_id, created_by, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
               RETURNING *`;

        const params = isMySQL
            ? [
                jobId,
                title,
                category,
                description,
                JSON.stringify(requirements),
                JSON.stringify(wiggle_room || {}),
                positions_available || 1,
                salary_range,
                location,
                deadline,
                project_id,
                req.user.id
            ]
            : [
                title,
                category,
                description,
                JSON.stringify(requirements),
                JSON.stringify(wiggle_room || {}),
                positions_available || 1,
                salary_range,
                location,
                deadline,
                project_id,
                req.user.id
            ];

        const result = await query(insertQuery, params);

        if (isMySQL) {
            const selectQuery = 'SELECT * FROM jobs WHERE id = ?';
            const selectResult = await query(selectQuery, [jobId]);
            const created = selectResult.rows[0];
            // Sync new job to chatbot KB — non-blocking
            syncJobAsync(created.id).catch(err =>
                logger.warn(`Project job create: chatbot sync failed for job ${created.id}: ${err.message}`)
            );
            res.status(201).json(created);
        } else {
            const created = result.rows[0];
            // Sync new job to chatbot KB — non-blocking
            syncJobAsync(created.id).catch(err =>
                logger.warn(`Project job create: chatbot sync failed for job ${created.id}: ${err.message}`)
            );
            res.status(201).json(created);
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get all candidates assigned to jobs in this project
 */
router.get('/:id/candidates', authenticate, requireSection('projects', 'view'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status } = req.query;

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        let candidatesQuery;
        const params = [id];
        
        if (status) {
            candidatesQuery = isMySQL
                ? `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = ? AND a.status = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = $1 AND a.status = $2
                   ORDER BY a.applied_at DESC`;
            params.push(status);
        } else {
            candidatesQuery = isMySQL
                ? `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = $1
                   ORDER BY a.applied_at DESC`;
        }

        const result = await query(candidatesQuery, params);

        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
