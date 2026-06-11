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
// CRUD shorthands for the mandatory matrix below.
const V    = VIEW_ONLY;                                                        // view
const VC   = { can_view: true, can_create: true,  can_edit: false, can_delete: false }; // view + create
const VE   = { can_view: true, can_create: false, can_edit: true,  can_delete: false }; // view + edit
const VCE  = { can_view: true, can_create: true,  can_edit: true,  can_delete: false }; // view + create + edit
const VCED = ALL_PERMS;                                                        // full CRUD

// The canonical section catalogue (matches the seeded `sections` table).
const SECTION_KEYS = [
    'dashboard', 'projects', 'applications', 'candidates', 'cv_manager',
    'communications', 'interviews', 'jobs', 'marketing_hub', 'analytics',
    'general_pool', 'knowledge_base', 'engagement', 'control_tower',
];

// Sections every authenticated user can at minimum see — keeps the app navigable
// even if no permissions are configured.
const UNIVERSAL_SECTIONS = ['dashboard'];

/**
 * MANDATORY ROLE BASELINE (UPGRADES.md #2 — the locked access matrix).
 * The single source of truth for what each role can do per section. Selecting a
 * role in the user form auto-applies + locks these rows; admins may grant EXTRAS
 * on top, but the baseline is a floor that cannot be removed (enforced by the
 * baseline-OR-custom logic in loadPerms/requireSection and by admin.js seeding).
 *
 * admin = full CRUD everywhere (handled by the bypass; listed for completeness).
 * sourcing_department = full operations except the admin panel (locked decision).
 * project_handler = pipeline ops, jobs view-only, no delete; candidates
 *                   view+create+edit (create powers Add-candidate in Messages).
 * marketing_agent = onboard-from-chat: jobs view-only, candidates view+create
 *                   (Add-candidate from the Messages panel is their core flow),
 *                   cv_manager + marketing_hub full, communications view+edit.
 */
const ROLE_BASELINE = {
    admin: {
        dashboard: VCED, projects: VCED, applications: VCED, candidates: VCED,
        cv_manager: VCED, communications: VCED, interviews: VCED, jobs: VCED,
        marketing_hub: VCED, analytics: VCED, general_pool: VCED, knowledge_base: VCED,
        engagement: VCED, control_tower: VCED,
    },
    project_handler: {
        dashboard: V, projects: VCE, applications: VE, candidates: VCE,
        cv_manager: VCE, communications: VE, interviews: VCE, jobs: V,
        marketing_hub: NONE, analytics: V, general_pool: V, knowledge_base: NONE,
        // engagement mirrors communications (VE); control_tower is read-only ops.
        engagement: VE, control_tower: V,
    },
    marketing_agent: {
        dashboard: V, projects: NONE, applications: NONE, candidates: VC,
        cv_manager: VCE, communications: VE, interviews: NONE, jobs: V,
        marketing_hub: VCE, analytics: NONE, general_pool: NONE, knowledge_base: NONE,
        // engagement mirrors communications (VE); no control_tower (no projects).
        engagement: VE, control_tower: NONE,
    },
    sourcing_department: {
        dashboard: V, projects: VCED, applications: VCED, candidates: VCED,
        cv_manager: VCED, communications: VCED, interviews: VCED, jobs: VCED,
        marketing_hub: VCED, analytics: VCED, general_pool: VCED, knowledge_base: VCED,
        engagement: VCED, control_tower: VCED,
    },
};

// Back-compat alias (older references) — same source of truth.
const ROLE_DEFAULTS = ROLE_BASELINE;

/**
 * The mandatory baseline permission set for (role, section). This is the floor
 * a user is guaranteed regardless of custom rows. Admin is full CRUD.
 */
function roleDefault(role, sectionKey) {
    if (role === 'admin') return ALL_PERMS;
    const roleMap = ROLE_BASELINE[role];
    const base = (roleMap && roleMap[sectionKey]) ? roleMap[sectionKey] : NONE;
    // Dashboard stays at least viewable for any authenticated role so the app
    // never traps a user with nowhere to land.
    if (UNIVERSAL_SECTIONS.includes(sectionKey) && !base.can_view) return VIEW_ONLY;
    return base;
}

/**
 * Effective permission = mandatory baseline OR per-user custom grant. Custom rows
 * can only ADD access on top of the baseline; they can never drop below it.
 */
function effectiveSectionPerms(role, sectionKey, customRow) {
    const base = roleDefault(role, sectionKey);
    if (!customRow) return base;
    return {
        can_view:   !!base.can_view   || !!customRow.can_view,
        can_create: !!base.can_create || !!customRow.can_create,
        can_edit:   !!base.can_edit   || !!customRow.can_edit,
        can_delete: !!base.can_delete || !!customRow.can_delete,
    };
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
        // Effective = mandatory baseline OR custom grant (custom can only add).
        const perms = effectiveSectionPerms(role, s.key, custom);
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
            // Effective = mandatory baseline OR custom grant (custom can only add).
            const row = effectiveSectionPerms(req.user.role, sectionKey, r.rows[0]);
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
    effectiveSectionPerms,
    ROLE_BASELINE,
    ROLE_DEFAULTS,
    SECTION_KEYS,
    UNIVERSAL_SECTIONS,
};
