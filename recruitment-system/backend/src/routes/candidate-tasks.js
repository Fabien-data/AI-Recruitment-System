/**
 * Candidate Tasks (agent callback / follow-up reminders)
 * ======================================================
 * Lets an agent schedule a "call back {candidate} on {due_at}" task and see all
 * tasks that are due. Recruitment-side equivalent of the Marketing Hub's
 * lead_follow_ups. Pure CRM bookkeeping — does not message the candidate.
 *
 *   POST   /api/candidate-tasks            — create a task
 *   GET    /api/candidate-tasks            — list (filters: status, assigned_to,
 *                                            candidate_id, overdue, due_before)
 *   GET    /api/candidate-tasks/due        — pending tasks due now (+ overdue)
 *   PATCH  /api/candidate-tasks/:id        — update status/outcome/note/due_at
 *   DELETE /api/candidate-tasks/:id        — cancel a task
 */

const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');

const VALID_STATUS = new Set(['pending', 'done', 'cancelled']);

const SELECT_WITH_JOINS = `
    SELECT t.*,
           c.name  AS candidate_name,
           c.phone AS candidate_phone,
           c.status AS candidate_status,
           u.full_name AS assigned_to_name,
           cu.full_name AS created_by_name
    FROM candidate_tasks t
    JOIN candidates c ON t.candidate_id = c.id
    LEFT JOIN users u  ON t.assigned_to = u.id
    LEFT JOIN users cu ON t.created_by  = cu.id`;

// ── Create a task ─────────────────────────────────────────────────────────────
router.post('/', authenticate, async (req, res, next) => {
    try {
        const { candidate_id, application_id, due_at, note, task_type, assigned_to } = req.body || {};
        if (!candidate_id || !due_at) {
            return res.status(400).json({ error: 'candidate_id and due_at are required' });
        }
        const id = generateUUID();
        await query(
            adaptQuery(`
                INSERT INTO candidate_tasks
                    (id, candidate_id, application_id, due_at, note, task_type, assigned_to, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `),
            [id, candidate_id, application_id || null, due_at, note || null,
             task_type || 'callback', assigned_to || req.user.id, req.user.id]
        );
        const created = await query(adaptQuery(`${SELECT_WITH_JOINS} WHERE t.id = $1`), [id]);
        res.status(201).json(created.rows[0]);
    } catch (err) { next(err); }
});

// ── List tasks ────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
    try {
        const { status, assigned_to, candidate_id, overdue, due_before, limit = 100, offset = 0 } = req.query;
        const params = [];
        const conds = ['1=1'];
        if (status)        { params.push(status);        conds.push(`t.status = $${params.length}`); }
        if (assigned_to)   { params.push(assigned_to);   conds.push(`t.assigned_to = $${params.length}`); }
        if (candidate_id)  { params.push(candidate_id);  conds.push(`t.candidate_id = $${params.length}`); }
        if (due_before)    { params.push(due_before);    conds.push(`t.due_at <= $${params.length}`); }
        if (overdue === 'true') { conds.push(`t.due_at < NOW() AND t.status = 'pending'`); }
        params.push(parseInt(limit, 10));
        params.push(parseInt(offset, 10));
        const sql = `${SELECT_WITH_JOINS}
            WHERE ${conds.join(' AND ')}
            ORDER BY t.due_at ASC
            LIMIT $${params.length - 1} OFFSET $${params.length}`;
        const result = await query(sql, params);
        res.json(result.rows);
    } catch (err) { next(err); }
});

// ── Due tasks (pending, due now or overdue) — agent dashboard ─────────────────
router.get('/due', authenticate, async (req, res, next) => {
    try {
        const { mine } = req.query;
        const params = [];
        let mineClause = '';
        if (mine === 'true') { params.push(req.user.id); mineClause = `AND t.assigned_to = $${params.length}`; }
        const sql = `${SELECT_WITH_JOINS}
            WHERE t.status = 'pending' AND t.due_at <= NOW() ${mineClause}
            ORDER BY t.due_at ASC
            LIMIT 200`;
        const result = await query(sql, params);
        res.json(result.rows);
    } catch (err) { next(err); }
});

// ── Update a task (complete / reschedule / annotate) ─────────────────────────
router.patch('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status, outcome, note, due_at, assigned_to } = req.body || {};
        if (status && !VALID_STATUS.has(status)) {
            return res.status(400).json({ error: `Invalid status. Allowed: ${[...VALID_STATUS].join(', ')}` });
        }
        const set = [];
        const values = [];
        const p = () => `$${values.length + 1}`;
        if (status)            { set.push(`status = ${p()}`);      values.push(status); }
        if (outcome != null)   { set.push(`outcome = ${p()}`);     values.push(outcome); }
        if (note != null)      { set.push(`note = ${p()}`);        values.push(note); }
        if (due_at)            { set.push(`due_at = ${p()}`);      values.push(due_at); }
        if (assigned_to)       { set.push(`assigned_to = ${p()}`); values.push(assigned_to); }
        if (status === 'done') { set.push('completed_at = NOW()'); }
        if (set.length === 0) return res.status(400).json({ error: 'No fields to update' });
        values.push(id);
        await query(`UPDATE candidate_tasks SET ${set.join(', ')} WHERE id = $${values.length}`, values);
        const updated = await query(adaptQuery(`${SELECT_WITH_JOINS} WHERE t.id = $1`), [id]);
        if (updated.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        res.json(updated.rows[0]);
    } catch (err) { next(err); }
});

// ── Cancel a task ─────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
    try {
        const result = await query(
            adaptQuery("UPDATE candidate_tasks SET status = 'cancelled' WHERE id = $1 RETURNING id"),
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
        res.json({ success: true, id: req.params.id });
    } catch (err) { next(err); }
});

module.exports = router;
