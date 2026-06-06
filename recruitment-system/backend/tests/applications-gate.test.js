// Phase 0 (UPGRADES.md #5) — the CV eligibility gate on manual assignment.
// POST /api/applications must 422 (screening_gate) when the candidate has no CV,
// and create a 'screening' application when a CV is on file.

const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({
    query: jest.fn(),
    withTransaction: jest.fn(),
    generateUUID: jest.fn(() => 'app-uuid'),
}));
jest.mock('../src/utils/query-adapter', () => ({
    adaptQuery: (sql) => sql,
    isMySQL: false,
}));
jest.mock('../src/middleware/auth', () => ({
    authenticate: (req, res, next) => { req.user = { id: 'u1', role: 'admin' }; next(); },
}));
jest.mock('../src/middleware/sections', () => ({
    requireSection: () => (req, res, next) => next(),
}));
jest.mock('../src/config/openai', () => ({ calculateMatchScore: jest.fn(async () => ({ score: 0.9 })) }));
jest.mock('../src/services/notifications', () => ({}));
jest.mock('../src/routes/chatbot-sync', () => ({ syncJobAsync: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

// Keep the real canonical vocab/normalizer; control only candidateHasCv + the
// fire-and-forget sync helpers.
jest.mock('../src/services/candidate-stage', () => {
    const actual = jest.requireActual('../src/services/candidate-stage');
    return {
        ...actual,
        candidateHasCv: jest.fn(),
        syncCandidateStage: jest.fn(async () => {}),
        setCandidateStage: jest.fn(async () => ({ updatedApplications: 0 })),
    };
});

const { query } = require('../src/config/database');
const { candidateHasCv } = require('../src/services/candidate-stage');
const applicationsRouter = require('../src/routes/applications');

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/applications', applicationsRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    return app;
}

describe('POST /api/applications — CV eligibility gate (#5)', () => {
    let app;
    beforeEach(() => { app = createApp(); jest.clearAllMocks(); });

    test('422 screening_gate when the candidate has no CV', async () => {
        candidateHasCv.mockResolvedValueOnce(false);
        const res = await request(app)
            .post('/api/applications')
            .send({ candidate_id: 'c1', job_id: 'j1' });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('screening_gate');
        expect(res.body.has_cv).toBe(false);
        // It must NOT have tried to insert an application.
        expect(query).not.toHaveBeenCalled();
    });

    test("creates a 'screening' application when a CV is on file", async () => {
        candidateHasCv.mockResolvedValueOnce(true);
        query
            .mockResolvedValueOnce({ rows: [{ id: 'c1', status: 'new', parsed_data: null }] }) // candidate
            .mockResolvedValueOnce({ rows: [{ id: 'j1', requirements: {}, project_title: 'P' }] }) // job
            .mockResolvedValueOnce({ rows: [{ id: 'app-uuid', candidate_id: 'c1', job_id: 'j1', status: 'screening' }] }); // insert RETURNING
        const res = await request(app)
            .post('/api/applications')
            .send({ candidate_id: 'c1', job_id: 'j1' });
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('screening');
        // The INSERT statement must use the canonical 'screening' (not legacy 'applied').
        const insertCall = query.mock.calls.find(([sql]) => /INSERT INTO applications/i.test(sql));
        expect(insertCall).toBeTruthy();
        expect(insertCall[0]).toMatch(/'screening'/);
        expect(insertCall[0]).not.toMatch(/'applied'/);
    });
});
