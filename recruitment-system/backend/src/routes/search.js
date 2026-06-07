/**
 * Global search — powers the ⌘K command palette (UPGRADES.md #3.0)
 * ================================================================
 * One call returns matching candidates / jobs / projects so an agent can jump
 * anywhere. Permission-aware: each result type is only searched if the user's
 * role baseline grants `view` on that section (admin sees all), so the palette
 * never surfaces records the user can't open.
 *
 *   GET /api/search?q=<term>
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { effectiveSectionPerms } = require('../middleware/sections');

router.get('/', authenticate, async (req, res, next) => {
    try {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.json({ candidates: [], jobs: [], projects: [] });

        const like = `%${q}%`;
        const digits = q.replace(/[^0-9]/g, '');
        const role = req.user.role;
        const can = (section) => effectiveSectionPerms(role, section).can_view;
        const out = { candidates: [], jobs: [], projects: [] };

        if (can('candidates')) {
            const params = digits ? [like, `%${digits}%`] : [like];
            const r = await query(adaptQuery(`
                SELECT id, name, phone, status, photo_url FROM candidates
                WHERE name ILIKE $1 OR phone ILIKE $1 OR email ILIKE $1
                  ${digits ? "OR regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE $2" : ''}
                ORDER BY updated_at DESC NULLS LAST
                LIMIT 8
            `), params);
            out.candidates = r.rows;
        }
        if (can('jobs')) {
            const r = await query(adaptQuery(`
                SELECT id, title, category, status FROM jobs
                WHERE title ILIKE $1 OR category ILIKE $1
                ORDER BY created_at DESC
                LIMIT 8
            `), [like]);
            out.jobs = r.rows;
        }
        if (can('projects')) {
            const r = await query(adaptQuery(`
                SELECT id, title, status FROM projects
                WHERE title ILIKE $1 OR COALESCE(description, '') ILIKE $1
                ORDER BY created_at DESC
                LIMIT 8
            `), [like]);
            out.projects = r.rows;
        }
        res.json(out);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
