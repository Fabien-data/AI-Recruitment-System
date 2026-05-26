/**
 * Admin API Routes  (admin-only)
 *
 * GET    /api/admin/stats                       — System-wide KPI counts
 * GET    /api/admin/users                       — List all users
 * POST   /api/admin/users                       — Create user (optionally with section_permissions)
 * PUT    /api/admin/users/:id                   — Update role / active status / profile
 * DELETE /api/admin/users/:id                   — Deactivate (soft-delete)
 * GET    /api/admin/audit-logs                  — Recent audit log entries
 *
 * Migration 021 additions:
 * GET    /api/admin/sections                    — Section catalogue (for permission matrix)
 * GET    /api/admin/users/:id/permissions       — Effective section permissions for one user
 * PUT    /api/admin/users/:id/permissions       — Replace section permissions for one user
 * GET    /api/admin/users/:id/activity          — Paginated audit log for one user
 * GET    /api/admin/users/:id/sessions          — Login session history for one user
 * GET    /api/admin/users/:id/kpi               — Computed KPI metrics (4 categories)
 * GET    /api/admin/activity                    — Global activity feed (all users)
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const { loadPerms } = require('../middleware/sections');
const { computeUserKpi } = require('../services/kpi');
const logger = require('../utils/logger');

const ADMIN_ONLY = [authenticate, authorize(ROLES.ADMIN)];

const VALID_PERM_KEYS = ['can_view', 'can_create', 'can_edit', 'can_delete'];

// ── System Stats ──────────────────────────────────────────────────────────────
router.get('/stats', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const [
            candidatesRes,
            jobsRes,
            projectsRes,
            hiredRes,
            openInterventionsRes,
            notifRes,
            usersRes,
        ] = await Promise.all([
            pool.query("SELECT COUNT(*) AS total FROM candidates"),
            pool.query("SELECT COUNT(*) AS total FROM jobs WHERE status = 'active'"),
            pool.query("SELECT COUNT(*) AS total FROM projects WHERE status IN ('planning','active')"),
            pool.query(
                `SELECT COUNT(*) AS total FROM applications
                 WHERE status IN ('selected','placed')
                   AND applied_at >= NOW() - INTERVAL '30 days'`
            ),
            pool.query(
                "SELECT COUNT(*) AS total FROM candidates WHERE intervention_needed = true"
            ),
            pool.query(
                `SELECT
                     COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                     COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
                     COUNT(*) FILTER (WHERE status = 'failed')  AS failed
                 FROM notification_queue`
            ),
            pool.query(
                `SELECT COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE is_active = true) AS active
                 FROM users`
            ),
        ]);

        res.json({
            candidates_total:    parseInt(candidatesRes.rows[0].total),
            jobs_active:         parseInt(jobsRes.rows[0].total),
            projects_active:     parseInt(projectsRes.rows[0].total),
            hired_last_30_days:  parseInt(hiredRes.rows[0].total),
            open_interventions:  parseInt(openInterventionsRes.rows[0].total),
            notifications: {
                pending: parseInt(notifRes.rows[0]?.pending || 0),
                sent:    parseInt(notifRes.rows[0]?.sent    || 0),
                failed:  parseInt(notifRes.rows[0]?.failed  || 0),
            },
            users_total:  parseInt(usersRes.rows[0].total),
            users_active: parseInt(usersRes.rows[0].active),
        });
    } catch (error) {
        next(error);
    }
});

// ── List Users ────────────────────────────────────────────────────────────────
router.get('/users', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const { page = 1, limit = 50, search } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (search) {
            params.push(`%${search}%`);
            whereClause += ` AND (full_name ILIKE $${params.length} OR email ILIKE $${params.length})`;
        }

        const countRes = await pool.query(
            `SELECT COUNT(*) AS total FROM users ${whereClause}`,
            params
        );

        params.push(parseInt(limit), offset);
        const usersRes = await pool.query(
            `SELECT id, email, full_name, role, phone, is_active, created_at, last_login_at
             FROM users ${whereClause}
             ORDER BY created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({
            data: usersRes.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: parseInt(countRes.rows[0].total),
            },
        });
    } catch (error) {
        next(error);
    }
});

// ── Create User ───────────────────────────────────────────────────────────────
// Optional body field `section_permissions`: an array of
// { section_key, can_view, can_create, can_edit, can_delete } applied in the
// same transaction as the user insert. When omitted the user falls back to the
// role-default permission set defined in middleware/sections.js.
router.post('/users', ...ADMIN_ONLY, async (req, res, next) => {
    const client = await pool.connect();
    try {
        const {
            email, password, full_name, role = ROLES.PROJECT_HANDLER, phone,
            section_permissions,
        } = req.body;

        if (!email || !password || !full_name) {
            return res.status(400).json({ error: 'email, password and full_name are required' });
        }

        const validRoles = Object.values(ROLES);
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
        }

        const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User with this email already exists' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO users (email, password_hash, full_name, role, phone)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, email, full_name, role, phone, is_active, created_at`,
            [email, password_hash, full_name, role, phone || null]
        );
        const newUser = result.rows[0];

        if (Array.isArray(section_permissions) && section_permissions.length > 0) {
            for (const p of section_permissions) {
                if (!p?.section_key) continue;
                await client.query(
                    `INSERT INTO user_section_permissions
                        (user_id, section_key, can_view, can_create, can_edit, can_delete)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (user_id, section_key) DO UPDATE SET
                        can_view   = EXCLUDED.can_view,
                        can_create = EXCLUDED.can_create,
                        can_edit   = EXCLUDED.can_edit,
                        can_delete = EXCLUDED.can_delete,
                        updated_at = NOW()`,
                    [newUser.id, p.section_key, !!p.can_view, !!p.can_create, !!p.can_edit, !!p.can_delete]
                );
            }
        }

        await client.query('COMMIT');

        logger.info(`Admin ${req.user.email} created user ${email} with role ${role}`);
        res.status(201).json(newUser);
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        next(error);
    } finally {
        client.release();
    }
});

// ── Update User ───────────────────────────────────────────────────────────────
router.put('/users/:id', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { role, is_active, full_name, phone } = req.body;

        // Prevent admin from deactivating themselves
        if (id === req.user.id && is_active === false) {
            return res.status(400).json({ error: 'Cannot deactivate your own account' });
        }

        if (role) {
            const validRoles = Object.values(ROLES);
            if (!validRoles.includes(role)) {
                return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
            }
        }

        const setClauses = [];
        const params = [];

        if (role !== undefined) {
            params.push(role);
            setClauses.push(`role = $${params.length}`);
        }
        if (is_active !== undefined) {
            params.push(is_active);
            setClauses.push(`is_active = $${params.length}`);
        }
        if (full_name !== undefined) {
            params.push(full_name);
            setClauses.push(`full_name = $${params.length}`);
        }
        if (phone !== undefined) {
            params.push(phone);
            setClauses.push(`phone = $${params.length}`);
        }

        if (setClauses.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        params.push(id);
        const result = await pool.query(
            `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${params.length}
             RETURNING id, email, full_name, role, phone, is_active, created_at, last_login_at`,
            params
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        logger.info(`Admin ${req.user.email} updated user ${id}`);
        res.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
});

// ── Deactivate User (soft-delete) ─────────────────────────────────────────────
router.delete('/users/:id', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const { id } = req.params;

        if (id === req.user.id) {
            return res.status(400).json({ error: 'Cannot deactivate your own account' });
        }

        const result = await pool.query(
            `UPDATE users SET is_active = false WHERE id = $1
             RETURNING id, email, full_name, is_active`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        logger.info(`Admin ${req.user.email} deactivated user ${id}`);
        res.json({ message: 'User deactivated', user: result.rows[0] });
    } catch (error) {
        next(error);
    }
});

// ── Audit Logs ────────────────────────────────────────────────────────────────
router.get('/audit-logs', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const { limit = 100, entity_type, action } = req.query;

        let whereClause = 'WHERE 1=1';
        const params = [];

        if (entity_type) {
            params.push(entity_type);
            whereClause += ` AND a.entity_type = $${params.length}`;
        }
        if (action) {
            params.push(action);
            whereClause += ` AND a.action = $${params.length}`;
        }

        params.push(parseInt(limit));
        const result = await pool.query(
            `SELECT a.*,
                    u.full_name AS user_name,
                    u.email     AS user_email,
                    u.full_name AS actor_name,
                    u.email     AS actor_email
             FROM audit_logs a
             LEFT JOIN users u ON a.user_id = u.id
             ${whereClause}
             ORDER BY a.created_at DESC
             LIMIT $${params.length}`,
            params
        );

        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ── Sections catalogue ────────────────────────────────────────────────────────
router.get('/sections', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const result = await pool.query(
            'SELECT key, name, icon, description, sort_order FROM sections ORDER BY sort_order, name'
        );
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ── User Section Permissions: read effective ─────────────────────────────────
router.get('/users/:id/permissions', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const userRes = await pool.query('SELECT id, role, full_name, email FROM users WHERE id = $1', [req.params.id]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = userRes.rows[0];
        const permissions = await loadPerms(user.id, user.role);
        res.json({ user, permissions });
    } catch (error) {
        next(error);
    }
});

// ── User Section Permissions: write ──────────────────────────────────────────
router.put('/users/:id/permissions', ...ADMIN_ONLY, async (req, res, next) => {
    const client = await pool.connect();
    try {
        const { permissions } = req.body;
        if (!Array.isArray(permissions)) {
            return res.status(400).json({ error: 'permissions must be an array' });
        }

        const userRes = await client.query('SELECT id, role FROM users WHERE id = $1', [req.params.id]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = userRes.rows[0];

        await client.query('BEGIN');
        // Replace strategy: delete then re-insert the supplied rows.
        await client.query('DELETE FROM user_section_permissions WHERE user_id = $1', [user.id]);
        for (const p of permissions) {
            if (!p?.section_key) continue;
            const hasAny = VALID_PERM_KEYS.some(k => !!p[k]);
            if (!hasAny) continue; // skip "all-false" rows — they're equivalent to NO row
            await client.query(
                `INSERT INTO user_section_permissions
                    (user_id, section_key, can_view, can_create, can_edit, can_delete)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [user.id, p.section_key, !!p.can_view, !!p.can_create, !!p.can_edit, !!p.can_delete]
            );
        }
        // Audit the change so it shows up in activity feeds.
        await client.query(
            `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes, ip_address, user_agent, session_id, section_key)
             VALUES ($1, 'update', 'user_permissions', $2, $3, $4, $5, $6, 'dashboard')`,
            [
                req.user.id,
                user.id,
                JSON.stringify({ target_user_id: user.id, permissions }),
                req.ip || null,
                req.headers['user-agent'] || null,
                req.user.session_id || null,
            ]
        );
        await client.query('COMMIT');

        const effective = await loadPerms(user.id, user.role);
        res.json({ user, permissions: effective });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        next(error);
    } finally {
        client.release();
    }
});

// ── Per-user Activity feed ───────────────────────────────────────────────────
router.get('/users/:id/activity', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const {
            from, to, entity, action, section,
            page = 1, limit = 50,
        } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(500, Math.max(1, parseInt(limit) || 50));
        const offset = (pageNum - 1) * limitNum;

        const where = ['a.user_id = $1'];
        const params = [req.params.id];

        if (from)    { params.push(from);    where.push(`a.created_at >= $${params.length}`); }
        if (to)      { params.push(to);      where.push(`a.created_at <= $${params.length}`); }
        if (entity)  { params.push(entity);  where.push(`a.entity_type = $${params.length}`); }
        if (action)  { params.push(action);  where.push(`a.action = $${params.length}`); }
        if (section) { params.push(section); where.push(`a.section_key = $${params.length}`); }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM audit_logs a ${whereSql}`, params);

        params.push(limitNum, offset);
        const rowsRes = await pool.query(
            `SELECT a.*, u.full_name AS user_name, u.email AS user_email
             FROM audit_logs a
             LEFT JOIN users u ON a.user_id = u.id
             ${whereSql}
             ORDER BY a.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({
            data: rowsRes.rows,
            pagination: { page: pageNum, limit: limitNum, total: countRes.rows[0].total },
        });
    } catch (error) {
        next(error);
    }
});

// ── Per-user Sessions ────────────────────────────────────────────────────────
router.get('/users/:id/sessions', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const limit = Math.min(200, parseInt(req.query.limit) || 50);
        const result = await pool.query(
            `SELECT id, login_at, logout_at,
                    COALESCE(duration_ms, EXTRACT(EPOCH FROM (COALESCE(logout_at, NOW()) - login_at)) * 1000)::bigint AS duration_ms,
                    logout_at IS NULL AS is_open,
                    ip_address, user_agent
             FROM user_sessions
             WHERE user_id = $1
             ORDER BY login_at DESC
             LIMIT $2`,
            [req.params.id, limit]
        );
        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

// ── Per-user KPI ─────────────────────────────────────────────────────────────
router.get('/users/:id/kpi', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const userRes = await pool.query(
            'SELECT id, email, full_name, role, created_at, last_login_at, is_active FROM users WHERE id = $1',
            [req.params.id]
        );
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        const user = userRes.rows[0];

        // Default window: last 30 days. Clamp future dates so charts don't extend
        // past today, which would confuse the timeseries view.
        const now = new Date();
        const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const from = req.query.from ? new Date(req.query.from) : defaultFrom;
        const to   = req.query.to   ? new Date(req.query.to)   : now;

        const kpi = await computeUserKpi(user.id, from, to);
        res.json({ user, kpi });
    } catch (error) {
        next(error);
    }
});

// ── Global Activity feed (cross-user) ────────────────────────────────────────
router.get('/activity', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const {
            user_id, from, to, entity, action, section,
            page = 1, limit = 50,
        } = req.query;
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(500, Math.max(1, parseInt(limit) || 50));
        const offset = (pageNum - 1) * limitNum;

        const where = ['1=1'];
        const params = [];

        if (user_id) { params.push(user_id); where.push(`a.user_id = $${params.length}`); }
        if (from)    { params.push(from);    where.push(`a.created_at >= $${params.length}`); }
        if (to)      { params.push(to);      where.push(`a.created_at <= $${params.length}`); }
        if (entity)  { params.push(entity);  where.push(`a.entity_type = $${params.length}`); }
        if (action)  { params.push(action);  where.push(`a.action = $${params.length}`); }
        if (section) { params.push(section); where.push(`a.section_key = $${params.length}`); }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM audit_logs a ${whereSql}`, params);

        params.push(limitNum, offset);
        const rowsRes = await pool.query(
            `SELECT a.*, u.full_name AS user_name, u.email AS user_email
             FROM audit_logs a
             LEFT JOIN users u ON a.user_id = u.id
             ${whereSql}
             ORDER BY a.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        res.json({
            data: rowsRes.rows,
            pagination: { page: pageNum, limit: limitNum, total: countRes.rows[0].total },
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
