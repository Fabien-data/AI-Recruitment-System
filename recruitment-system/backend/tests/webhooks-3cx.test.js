const express = require('express');
const request = require('supertest');

// Unit-test the 3CX webhook in isolation: the DB layer is mocked so we drive the
// query() call sequence by hand and assert on the SQL/params the route builds.
jest.mock('../src/config/database', () => ({
    query: jest.fn(),
    generateUUID: jest.fn(() => 'log-uuid'),
}));

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn(),
}));

// Socket layer is irrelevant here — emit() should no-op when getIO() is null.
jest.mock('../src/utils/websocket', () => ({ getIO: jest.fn(() => null) }));

const { query } = require('../src/config/database');
const threecxRouter = require('../src/routes/webhooks-3cx');

const TOKEN = 'test-3cx-secret';

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/webhooks/3cx', threecxRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    return app;
}

// The INSERT INTO call_logs query call (or undefined if none was made).
function callLogInsert() {
    return query.mock.calls.find(([sql]) => /INSERT INTO call_logs/i.test(sql));
}
function candidateLookup() {
    return query.mock.calls.find(([sql]) => /FROM candidates\b/i.test(sql) && /phone = ANY/i.test(sql));
}

describe('3CX webhook — /webhooks/3cx', () => {
    let app;

    beforeEach(() => {
        app = createApp();
        jest.clearAllMocks();
        process.env.THREECX_WEBHOOK_TOKEN = TOKEN;
        delete process.env.THREECX_ALLOWED_IPS;
    });

    test('logs a call to call_logs on call-end, attributed to the extension owner', async () => {
        query
            .mockResolvedValueOnce({ rows: [{ id: 'cand-1', name: 'Nuwan', status: 'screening', claimed_by: null }] }) // candidate match
            .mockResolvedValueOnce({ rows: [{ id: 'agent-7', full_name: 'Agent Bob' }] }) // extension → user
            .mockResolvedValueOnce({ rows: [] }) // lead_call_events audit insert
            .mockResolvedValueOnce({ rows: [] }) // call_logs existing-check (none)
            .mockResolvedValueOnce({ rows: [] }) // getOpenClaimSessionId (agent doesn't hold claim)
            .mockResolvedValueOnce({ rows: [] }) // call_logs insert
            .mockResolvedValueOnce({ rows: [] }); // candidates last_contacted bump

        const res = await request(app)
            .post('/webhooks/3cx/call-event')
            .set('X-3cx-Token', TOKEN)
            .send({ call_id: 'C1', event_type: 'ended', caller_number: '94771234567', agent_extension: '101', duration_seconds: 42, status: 'answered' })
            .expect(202);

        expect(res.body).toMatchObject({ ok: true, candidate_id: 'cand-1', agent_id: 'agent-7', logged: true, duplicate: false });

        // phoneVariants matched across +94 / 94 / 0 forms
        const [, candParams] = candidateLookup();
        expect(candParams[0]).toEqual(expect.arrayContaining(['+94771234567', '94771234567', '0771234567']));

        // call_logs row carries the right attribution + 3CX provenance
        const insert = callLogInsert();
        expect(insert).toBeTruthy();
        const [sql, params] = insert;
        expect(sql).toMatch(/'3cx'/);
        expect(params).toEqual(expect.arrayContaining(['log-uuid', 'cand-1', 'agent-7', 'answered', 42, 'C1']));
    });

    test('is idempotent — a duplicate external_call_id does not insert a second row', async () => {
        query
            .mockResolvedValueOnce({ rows: [{ id: 'cand-1', name: 'Nuwan', status: 'screening', claimed_by: null }] })
            .mockResolvedValueOnce({ rows: [{ id: 'agent-7' }] })
            .mockResolvedValueOnce({ rows: [] }) // audit insert
            .mockResolvedValueOnce({ rows: [{ id: 'existing-log' }] }); // call_logs already has this call

        const res = await request(app)
            .post('/webhooks/3cx/call-event')
            .set('X-3cx-Token', TOKEN)
            .send({ call_id: 'C1', event_type: 'ended', caller_number: '94771234567', agent_extension: '101', duration_seconds: 42 })
            .expect(202);

        expect(res.body).toMatchObject({ logged: false, duplicate: true });
        expect(callLogInsert()).toBeUndefined();
    });

    test('unmatched caller → audit only, no call_logs row', async () => {
        query
            .mockResolvedValueOnce({ rows: [] }) // no candidate
            .mockResolvedValueOnce({ rows: [] }) // no agent for extension
            .mockResolvedValueOnce({ rows: [] }); // audit insert

        const res = await request(app)
            .post('/webhooks/3cx/call-event')
            .set('X-3cx-Token', TOKEN)
            .send({ call_id: 'C9', event_type: 'ended', caller_number: '94770000000', agent_extension: '999' })
            .expect(202);

        expect(res.body).toMatchObject({ candidate_id: null, logged: false });
        expect(callLogInsert()).toBeUndefined();
    });

    test('candidate matched but extension unmapped → logs with NULL agent (no claim lookup)', async () => {
        query
            .mockResolvedValueOnce({ rows: [{ id: 'cand-1', name: 'Nuwan', status: 'new', claimed_by: null }] })
            .mockResolvedValueOnce({ rows: [] }) // extension → no user
            .mockResolvedValueOnce({ rows: [] }) // audit insert
            .mockResolvedValueOnce({ rows: [] }) // call_logs existing-check
            .mockResolvedValueOnce({ rows: [] }) // call_logs insert
            .mockResolvedValueOnce({ rows: [] }); // last_contacted bump

        const res = await request(app)
            .post('/webhooks/3cx/call-event')
            .set('X-3cx-Token', TOKEN)
            .send({ call_id: 'C2', event_type: 'hangup', caller_number: '0771234567', agent_extension: '101', duration_seconds: 0 })
            .expect(202);

        expect(res.body).toMatchObject({ agent_id: null, logged: true });
        const [, params] = callLogInsert();
        expect(params[2]).toBeNull(); // agent_id
        expect(params[3]).toBe('no_answer'); // duration 0 → no_answer
        // No claim_sessions lookup must have happened (agentId was null)
        const claimLookup = query.mock.calls.find(([sql]) => /FROM claim_sessions/i.test(sql));
        expect(claimLookup).toBeUndefined();
    });

    test('rejects a bad token with 401 and never touches the DB', async () => {
        await request(app)
            .post('/webhooks/3cx/call-event')
            .set('X-3cx-Token', 'wrong')
            .send({ call_id: 'C3', event_type: 'ended' })
            .expect(401);
        expect(query).not.toHaveBeenCalled();
    });

    test('returns 503 when the webhook token is not configured', async () => {
        delete process.env.THREECX_WEBHOOK_TOKEN;
        await request(app)
            .post('/webhooks/3cx/call-event')
            .send({ call_id: 'C4', event_type: 'ended' })
            .expect(503);
    });

    test('contact-lookup returns the matched candidate for caller ID', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'cand-1', name: 'Nuwan', status: 'screening', claimed_by: null }] });
        const res = await request(app)
            .get('/webhooks/3cx/contact-lookup')
            .query({ number: '+94771234567' })
            .set('X-3cx-Token', TOKEN)
            .expect(200);
        expect(res.body).toEqual({ candidate_id: 'cand-1', name: 'Nuwan', stage: 'screening' });
    });

    test('contact-lookup 404s when no candidate matches', async () => {
        query.mockResolvedValueOnce({ rows: [] });
        await request(app)
            .get('/webhooks/3cx/contact-lookup')
            .query({ number: '+94770000000' })
            .set('X-3cx-Token', TOKEN)
            .expect(404);
    });
});
