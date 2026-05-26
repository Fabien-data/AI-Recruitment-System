const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Canonical role names
const ROLES = {
    ADMIN: 'admin',
    PROJECT_HANDLER: 'project_handler',
    SOURCING_DEPARTMENT: 'sourcing_department',
    MARKETING_AGENT: 'marketing_agent',
};

// Backwards-compat alias map (old DB values → new values)
const ROLE_ALIAS = {
    recruiter: ROLES.PROJECT_HANDLER,
    supervisor: ROLES.SOURCING_DEPARTMENT,
};

/**
 * Authentication middleware
 */
async function authenticate(req, res, next) {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Get user from database
        const result = await pool.query(
            'SELECT id, email, full_name, role FROM users WHERE id = $1 AND is_active = true',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid token' });
        }

        const u = result.rows[0];
        // Normalise legacy role values so old rows still work
        u.role = ROLE_ALIAS[u.role] || u.role;
        req.user = u;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        next(error);
    }
}

/**
 * Authorization middleware - check if user has required role
 */
function authorize(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        next();
    };
}

/**
 * Generate JWT token
 */
function generateToken(userId, expiresIn = '7d') {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn });
}

module.exports = {
    authenticate,
    authorize,
    generateToken,
    JWT_SECRET,
    ROLES,
};
