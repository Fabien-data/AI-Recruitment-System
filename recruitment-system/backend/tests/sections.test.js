// Unit tests for the role-based access matrix (UPGRADES.md #2). Pure functions —
// no DB. Verifies the role baseline and the OVERRIDE model (a custom row wins
// verbatim — it can grant above OR revoke below the baseline; dashboard view is
// a universal floor).

jest.mock('../src/config/database', () => ({ pool: { query: jest.fn() } }));

const {
    roleDefault,
    effectiveSectionPerms,
    ROLE_BASELINE,
} = require('../src/middleware/sections');

describe('roleDefault — mandatory baseline matrix', () => {
    test('admin has full CRUD on every section', () => {
        for (const section of Object.keys(ROLE_BASELINE.project_handler)) {
            expect(roleDefault('admin', section)).toEqual({
                can_view: true, can_create: true, can_edit: true, can_delete: true,
            });
        }
    });

    test('marketing_agent: jobs is VIEW-ONLY (locked decision b)', () => {
        const p = roleDefault('marketing_agent', 'jobs');
        expect(p.can_view).toBe(true);
        expect(p.can_create).toBe(false);
        expect(p.can_edit).toBe(false);
        expect(p.can_delete).toBe(false);
    });

    test('marketing_agent: candidates view-only, cv_manager VCE, communications VE', () => {
        expect(roleDefault('marketing_agent', 'candidates')).toMatchObject({ can_view: true, can_edit: false });
        expect(roleDefault('marketing_agent', 'cv_manager')).toMatchObject({ can_view: true, can_create: true, can_edit: true });
        expect(roleDefault('marketing_agent', 'communications')).toMatchObject({ can_view: true, can_edit: true, can_create: false });
        // marketing has no projects / applications / interviews / analytics
        expect(roleDefault('marketing_agent', 'projects').can_view).toBe(false);
        expect(roleDefault('marketing_agent', 'applications').can_view).toBe(false);
        expect(roleDefault('marketing_agent', 'analytics').can_view).toBe(false);
    });

    test('project_handler: applications V+E (no create), jobs view-only, no delete anywhere', () => {
        expect(roleDefault('project_handler', 'applications')).toMatchObject({ can_view: true, can_edit: true, can_create: false });
        expect(roleDefault('project_handler', 'jobs')).toMatchObject({ can_view: true, can_create: false, can_edit: false });
        expect(roleDefault('project_handler', 'cv_manager')).toMatchObject({ can_view: true, can_create: true, can_edit: true });
        expect(roleDefault('project_handler', 'knowledge_base').can_view).toBe(false);
    });

    test('sourcing_department: full ops (incl. delete) except no admin panel concept', () => {
        for (const section of ['projects', 'applications', 'candidates', 'jobs', 'knowledge_base', 'general_pool']) {
            expect(roleDefault('sourcing_department', section)).toMatchObject({
                can_view: true, can_create: true, can_edit: true, can_delete: true,
            });
        }
    });

    test('dashboard stays at least viewable for every role', () => {
        for (const role of ['project_handler', 'marketing_agent', 'sourcing_department']) {
            expect(roleDefault(role, 'dashboard').can_view).toBe(true);
        }
    });

    test('unknown section for a role is denied', () => {
        expect(roleDefault('project_handler', 'nonexistent_section')).toEqual({
            can_view: false, can_create: false, can_edit: false, can_delete: false,
        });
    });
});

describe('effectiveSectionPerms — override model (custom row wins verbatim)', () => {
    test('no custom row → role baseline', () => {
        expect(effectiveSectionPerms('marketing_agent', 'jobs', null))
            .toMatchObject({ can_view: true, can_create: false });
    });

    test('custom grant adds above baseline (jobs create for marketing)', () => {
        const eff = effectiveSectionPerms('marketing_agent', 'jobs',
            { can_view: true, can_create: true, can_edit: false, can_delete: false });
        expect(eff.can_view).toBe(true);
        expect(eff.can_create).toBe(true); // granted by the override
    });

    test('custom row CAN revoke below the baseline (override wins)', () => {
        // marketing baseline jobs = view-only; an all-false override now removes
        // even the view (the old additive model couldn't do this).
        const eff = effectiveSectionPerms('marketing_agent', 'jobs',
            { can_view: false, can_create: false, can_edit: false, can_delete: false });
        expect(eff.can_view).toBe(false); // override wins — access revoked
    });

    test('dashboard view is a universal floor even with an all-false override', () => {
        const eff = effectiveSectionPerms('project_handler', 'dashboard',
            { can_view: false, can_create: false, can_edit: false, can_delete: false });
        expect(eff.can_view).toBe(true); // dashboard can never be fully revoked
    });

    test('admin always resolves to full CRUD regardless of any custom row', () => {
        const eff = effectiveSectionPerms('admin', 'jobs',
            { can_view: false, can_create: false, can_edit: false, can_delete: false });
        expect(eff).toEqual({ can_view: true, can_create: true, can_edit: true, can_delete: true });
    });
});
