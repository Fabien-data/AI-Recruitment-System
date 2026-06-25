/**
 * Per-user workspace preferences
 * ==============================
 * Cross-device persistence of a user's UI state (the persistent Messages
 * workspace in UPGRADES.md #3.0, future saved-views, etc.). Stored as a
 * free-form JSON blob namespaced by feature in the `user_preferences` table
 * (migration 034) — a dedicated table because `users` is postgres-owned and
 * can't be ALTERed by recruitment_user.
 *
 *   GET /api/preferences          → { ...prefs }   (always 200, {} if none)
 *   PUT /api/preferences          → shallow-merge the body's top-level keys
 *                                    into the saved blob, returns the merged set
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

router.use(authenticate);

// GET current user's preferences (never throws to the client — empty on any issue).
router.get('/', async (req, res) => {
    try {
        const r = await query(
            adaptQuery('SELECT prefs FROM user_preferences WHERE user_id = $1'),
            [req.user.id],
        );
        const prefs = r.rows[0]?.prefs || {};
        res.json(typeof prefs === 'string' ? JSON.parse(prefs) : prefs);
    } catch (err) {
        logger.warn(`preferences GET failed for ${req.user.id}: ${err.message}`);
        res.json({}); // degrade gracefully — UI falls back to localStorage/defaults
    }
});

// PUT: shallow-merge the supplied top-level namespaces into the saved blob
// (so saving { communications: {...} } never clobbers other namespaces).
router.put('/', async (req, res, next) => {
    try {
        const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const cur = await query(
            adaptQuery('SELECT prefs FROM user_preferences WHERE user_id = $1'),
            [req.user.id],
        );
        const existing = cur.rows[0]?.prefs
            ? (typeof cur.rows[0].prefs === 'string' ? JSON.parse(cur.rows[0].prefs) : cur.rows[0].prefs)
            : {};
        const merged = { ...existing, ...patch };

        await query(
            adaptQuery(`
                INSERT INTO user_preferences (user_id, prefs, updated_at)
                VALUES ($1, $2, NOW())
                ON CONFLICT (user_id) DO UPDATE SET prefs = $2, updated_at = NOW()
            `),
            [req.user.id, JSON.stringify(merged)],
        );
        res.json(merged);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
