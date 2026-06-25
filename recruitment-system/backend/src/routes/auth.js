const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { generateToken, authenticate, JWT_SECRET } = require('../middleware/auth');
const { loadPerms } = require('../middleware/sections');
const { insertAuditRow } = require('../utils/audit-writer');
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
    // Tolerant writer: falls back to the legacy column set when the prod
    // audit_logs table is missing the Migration 021 columns, so login/logout
    // rows are never silently lost.
    await insertAuditRow({
        userId,
        sessionId,
        action,
        entityType: 'session',
        sectionKey,
        changes,
        ip,
        userAgent,
    }).catch((err) => {
        logger.warn(`auth audit write failed (${action}):`, err?.message);
    });
}

/**
 * Self-registration.
 *
 * SECURITY: the request body's `role` is IGNORED — letting a sign-up pick its
 * own role allowed anyone to register as admin. New accounts are created
 * pending (approved=false, is_active=false) with the least-privileged role; an
 * admin approves them and assigns the real role before they can log in.
 *
 * Bootstrap exception: if the system has NO users yet (fresh install), the first
 * registration becomes an active admin so the instance can be set up.
 */
router.post('/register', async (req, res, next) => {
    try {
        const { email, password, full_name, phone } = req.body;

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

        // Fresh-install bootstrap: the very first account becomes the admin.
        const userCount = await pool.query('SELECT COUNT(*)::int AS n FROM users');
        const isBootstrap = (userCount.rows[0]?.n || 0) === 0;

        const password_hash = await bcrypt.hash(password, 10);
        const role = isBootstrap ? 'admin' : 'marketing_agent'; // least-privileged default; admin reassigns on approval
        const isActive = isBootstrap;
        const approved = isBootstrap;

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, phone, role, is_active, approved)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, email, full_name, role, created_at`,
            [email, password_hash, full_name, phone || null, role, isActive, approved]
        );
        const user = result.rows[0];

        if (isBootstrap) {
            // Auto-login the first admin.
            const token = generateToken(user.id);
            return res.status(201).json({ user, token, bootstrap: true });
        }

        // Pending approval — no token, cannot log in until an admin approves.
        logger.info(`New registration pending approval: ${email}`);
        return res.status(201).json({
            pending: true,
            message: 'Your account has been created and is awaiting administrator approval. You will be able to sign in once an admin approves your access.',
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

        // Look the user up by email first so we can distinguish a wrong password
        // from a pending/deactivated account and give an honest message.
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
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

        // Pending admin approval, or deactivated — block with a clear reason.
        if (user.approved === false) {
            return res.status(403).json({ error: 'Your account is awaiting administrator approval.' });
        }
        if (user.is_active === false) {
            return res.status(403).json({ error: 'Your account has been deactivated. Contact an administrator.' });
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
