/**
 * Admin API Routes  (admin-only)
 *
 * GET    /api/admin/stats           — System-wide KPI counts
 * GET    /api/admin/users           — List all users
 * POST   /api/admin/users           — Create user with role
 * PUT    /api/admin/users/:id       — Update role / active status
 * DELETE /api/admin/users/:id       — Deactivate (soft-delete)
 * GET    /api/admin/audit-logs      — Recent audit log entries
 */

const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const logger = require('../utils/logger');

const ADMIN_ONLY = [authenticate, authorize(ROLES.ADMIN)];

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
router.post('/users', ...ADMIN_ONLY, async (req, res, next) => {
    try {
        const { email, password, full_name, role = ROLES.PROJECT_HANDLER, phone } = req.body;

        if (!email || !password || !full_name) {
            return res.status(400).json({ error: 'email, password and full_name are required' });
        }

        const validRoles = Object.values(ROLES);
        if (!validRoles.includes(role)) {
            return res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
        }

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User with this email already exists' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, role, phone)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, email, full_name, role, phone, is_active, created_at`,
            [email, password_hash, full_name, role, phone || null]
        );

        logger.info(`Admin ${req.user.email} created user ${email} with role ${role}`);
        res.status(201).json(result.rows[0]);
    } catch (error) {
        next(error);
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
            `SELECT a.*, u.full_name AS actor_name, u.email AS actor_email
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

module.exports = router;
