const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { generateToken, authenticate, JWT_SECRET } = require('../middleware/auth');
const { loadPerms } = require('../middleware/sections');
const logger = require('../utils/logger');

function getIp(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.connection?.remoteAddress ||
        req.ip ||
        null
    );
}

async function recordAudit({ userId, sessionId, action, sectionKey = null, changes = null, ip = null, userAgent = null }) {
    try {
        await pool.query(
            `INSERT INTO audit_logs
                (user_id, action, entity_type, entity_id, changes, ip_address, user_agent, session_id, section_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [userId, action, 'session', null, changes ? JSON.stringify(changes) : null, ip, userAgent, sessionId, sectionKey]
        );
    } catch (err) {
        logger.warn(`auth audit write failed (${action}):`, err.message);
    }
}

/**
 * User registration (admin only in production)
 */
router.post('/register', async (req, res, next) => {
    try {
        const { email, password, full_name, role = 'project_handler' } = req.body;

        if (!email || !password || !full_name) {
            return res.status(400).json({ error: 'Email, password, and full name are required' });
        }

        const existingUser = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );

        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'User with this email already exists' });
        }

        const password_hash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, full_name, role, created_at`,
            [email, password_hash, full_name, role]
        );

        const user = result.rows[0];
        const token = generateToken(user.id);

        res.status(201).json({
            user,
            token
        });
    } catch (error) {
        next(error);
    }
});

/**
 * User login — opens a session row, embeds session_id in JWT and returns the
 * caller's effective section_permissions so the SPA can render the right nav.
 */
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND is_active = true',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = result.rows[0];
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const ip = getIp(req);
        const userAgent = req.headers['user-agent'] || null;

        // Open a session row first so its id is available for the JWT payload
        // and the login audit row.
        const sessionRes = await pool.query(
            `INSERT INTO user_sessions (user_id, ip_address, user_agent)
             VALUES ($1, $2, $3)
             RETURNING id`,
            [user.id, ip, userAgent]
        );
        const sessionId = sessionRes.rows[0].id;

        await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

        const token = generateToken(user.id, '7d', sessionId);

        // Record the login event so KPI session/throughput calculations can
        // anchor on it. Fire-and-forget (table write only) — no need to await.
        recordAudit({
            userId: user.id, sessionId, action: 'login', ip, userAgent,
            changes: { email: user.email },
        });

        // Look up effective section permissions for this user. Falls back to
        // role defaults when no custom rows exist.
        let section_permissions = [];
        try {
            section_permissions = await loadPerms(user.id, user.role);
        } catch (err) {
            // Sections table may not exist yet in environments mid-migration —
            // ship the user in with empty perms; the frontend falls back to role.
            logger.warn('loadPerms failed during login:', err.message);
        }

        delete user.password_hash;
        res.json({ user, token, section_permissions });
    } catch (error) {
        next(error);
    }
});

/**
 * Logout — closes the active session row and records an audit event.
 * Best-effort: always returns 200 even if the session row is missing so
 * client-side cleanup can proceed unconditionally.
 */
router.post('/logout', authenticate, async (req, res) => {
    const sessionId = req.user?.session_id;
    const userId = req.user?.id;
    const ip = getIp(req);
    const userAgent = req.headers['user-agent'] || null;

    if (sessionId) {
        try {
            await pool.query(
                `UPDATE user_sessions
                 SET logout_at = NOW(),
                     duration_ms = EXTRACT(EPOCH FROM (NOW() - login_at)) * 1000
                 WHERE id = $1 AND logout_at IS NULL`,
                [sessionId]
            );
        } catch (err) {
            logger.warn('logout: session close failed —', err.message);
        }
    }
    recordAudit({ userId, sessionId, action: 'logout', ip, userAgent });
    res.json({ ok: true });
});

/**
 * Get current user profile — also returns effective section permissions so the
 * SPA can refresh its nav after a permission change without re-logging-in.
 */
router.get('/me', async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');

        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        const result = await pool.query(
            'SELECT id, email, full_name, role, phone, created_at, last_login_at FROM users WHERE id = $1 AND is_active = true',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const user = result.rows[0];
        let section_permissions = [];
        try {
            section_permissions = await loadPerms(user.id, user.role);
        } catch (err) {
            logger.warn('loadPerms failed during /me:', err.message);
        }

        res.json({ ...user, section_permissions });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
