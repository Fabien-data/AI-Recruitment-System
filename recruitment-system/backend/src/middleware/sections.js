/**
 * Section Permission Middleware
 * =============================
 *
 * Layers per-section CRUD permissions on top of the existing 4-role model.
 * The legacy roles (admin / sourcing_department / project_handler /
 * marketing_agent) keep working via ROLE_DEFAULTS — only "custom" users with
 * rows in user_section_permissions get fine-grained control.
 *
 * Usage on a route:
 *   const { requireSection } = require('../middleware/sections');
 *   router.post('/api/candidates', authenticate, requireSection('candidates','create'), handler);
 *
 * The login flow calls loadPerms() and ships the result down to the frontend
 * so the sidebar/RoleGuard can hide inaccessible sections without an extra round-trip.
 */

const { pool } = require('../config/database');

const ALL_PERMS = { can_view: true, can_create: true, can_edit: true, can_delete: true };
const VIEW_ONLY = { can_view: true, can_create: false, can_edit: false, can_delete: false };
const NONE      = { can_view: false, can_create: false, can_edit: false, can_delete: false };

// Sections every authenticated user can at minimum see — keeps the app navigable
// even if no permissions are configured.
const UNIVERSAL_SECTIONS = ['dashboard'];

/**
 * Role-based defaults. Used when a user has NO rows in user_section_permissions
 * for a given section. Mirrors the historical Layout.jsx nav behaviour so existing
 * users keep the access they had before Migration 021.
 */
const ROLE_DEFAULTS = {
    admin: {
        // Everything, always.
        match: () => ALL_PERMS,
    },
    sourcing_department: {
        match: () => ALL_PERMS,
    },
    project_handler: {
        match: (key) => {
            const allowed = [
                'dashboard', 'candidates', 'jobs', 'projects', 'applications',
                'interviews', 'communications', 'analytics', 'general_pool',
            ];
            if (!allowed.includes(key)) return NONE;
            // Project handlers historically couldn't delete entities.
            return { can_view: true, can_create: true, can_edit: true, can_delete: false };
        },
    },
    marketing_agent: {
        match: (key) => {
            if (key === 'dashboard') return VIEW_ONLY;
            if (key === 'marketing_hub') return { can_view: true, can_create: true, can_edit: true, can_delete: false };
            return NONE;
        },
    },
};

function roleDefault(role, sectionKey) {
    if (UNIVERSAL_SECTIONS.includes(sectionKey)) return ALL_PERMS;
    const def = ROLE_DEFAULTS[role];
    if (!def) return NONE;
    return def.match(sectionKey);
}

/**
 * Resolve a user's effective permissions for every section.
 * Returns: [{section_key, can_view, can_create, can_edit, can_delete, source}, ...]
 * where source = 'role' | 'custom' so the UI can distinguish overridden rows.
 */
async function loadPerms(userId, role) {
    const sectionsRes = await pool.query(
        'SELECT key, name, icon, sort_order FROM sections ORDER BY sort_order, name'
    );
    const customRes = await pool.query(
        `SELECT section_key, can_view, can_create, can_edit, can_delete
         FROM user_section_permissions WHERE user_id = $1`,
        [userId]
    );
    const customByKey = new Map(customRes.rows.map(r => [r.section_key, r]));

    return sectionsRes.rows.map(s => {
        const custom = customByKey.get(s.key);
        const perms = custom || roleDefault(role, s.key);
        return {
            section_key: s.key,
            section_name: s.name,
            section_icon: s.icon,
            sort_order: s.sort_order,
            can_view:    !!perms.can_view,
            can_create:  !!perms.can_create,
            can_edit:    !!perms.can_edit,
            can_delete:  !!perms.can_delete,
            source: custom ? 'custom' : 'role',
        };
    });
}

/**
 * Middleware factory. Blocks the request unless the user has the requested
 * action on the section. Admin is unconditionally allowed.
 *
 * @param {string} sectionKey - e.g. 'candidates'
 * @param {'view'|'create'|'edit'|'delete'} action
 */
function requireSection(sectionKey, action) {
    if (!['view', 'create', 'edit', 'delete'].includes(action)) {
        throw new Error(`requireSection: invalid action "${action}"`);
    }
    return async (req, res, next) => {
        try {
            if (!req.user) return res.status(401).json({ error: 'Authentication required' });
            if (req.user.role === 'admin') return next();

            const r = await pool.query(
                `SELECT can_view, can_create, can_edit, can_delete
                 FROM user_section_permissions
                 WHERE user_id = $1 AND section_key = $2`,
                [req.user.id, sectionKey]
            );
            const row = r.rows[0] || roleDefault(req.user.role, sectionKey);
            if (!row || !row[`can_${action}`]) {
                return res.status(403).json({
                    error: 'Section access denied',
                    section: sectionKey,
                    action,
                });
            }
            next();
        } catch (err) {
            next(err);
        }
    };
}

module.exports = {
    requireSection,
    loadPerms,
    roleDefault,
    ROLE_DEFAULTS,
    UNIVERSAL_SECTIONS,
};
