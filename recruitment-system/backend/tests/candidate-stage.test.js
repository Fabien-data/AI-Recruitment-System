// Unit tests for setCandidateStage() — the shared cascade used by both the CV
// Manager `PUT /:id/stage` endpoint and the calling console "Done → advance".
// All DB access is mocked; we assert the SQL/params the service issues.

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }));
// Websocket is lazy-required inside emitStageChanged and wrapped in try/catch;
// stub it so the emit is a no-op rather than touching a real io instance.
jest.mock('../src/utils/websocket', () => ({ getIO: () => null }));

const { query } = require('../src/config/database');
const { setCandidateStage, syncCandidateStage } = require('../src/services/candidate-stage');

describe('setCandidateStage', () => {
    beforeEach(() => jest.clearAllMocks());

    test('certified cascades to applications then re-derives candidate.status', async () => {
        query
            .mockResolvedValueOnce({ rowCount: 1 })                                          // UPDATE applications
            .mockResolvedValueOnce({ rows: [{ current_status: 'screening', has_cv: true }] }) // sync: candidate select
            .mockResolvedValueOnce({ rows: [{ status: 'certified' }] })                       // sync: applications select
            .mockResolvedValueOnce({ rowCount: 1 });                                          // sync: UPDATE candidates

        const res = await setCandidateStage('cand-1', 'certified');
        expect(res.updatedApplications).toBe(1);

        const [firstSql, firstParams] = query.mock.calls[0];
        expect(firstSql).toContain('UPDATE applications');
        expect(firstParams[0]).toBe('certified');

        const lastCall = query.mock.calls[query.mock.calls.length - 1];
        expect(lastCall[0]).toContain('UPDATE candidates');
        expect(lastCall[1][0]).toBe('certified');
    });

    test('new is a direct candidate.status write (no application cascade)', async () => {
        query.mockResolvedValueOnce({ rowCount: 1 }); // direct UPDATE candidates

        const res = await setCandidateStage('cand-2', 'new');
        expect(res.updatedApplications).toBe(0);
        expect(query).toHaveBeenCalledTimes(1);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('UPDATE candidates');
        expect(params[0]).toBe('new');
    });

    test('merged/hired are terminal — never overwritten by the re-derive', async () => {
        query
            .mockResolvedValueOnce({ rowCount: 1 })                                          // UPDATE applications
            .mockResolvedValueOnce({ rows: [{ current_status: 'hired', has_cv: true }] });   // sync: terminal → returns early

        const res = await setCandidateStage('cand-3', 'certified');
        expect(res.updatedApplications).toBe(1);
        // Only the apps update + the terminal-status select ran — candidates untouched.
        expect(query).toHaveBeenCalledTimes(2);
    });

    test('future_pool is LIFTED to its forward stage once a real application appears (drift fix)', async () => {
        // Reproduces the agents' bug: a candidate parked in future_pool who then
        // gets a screening/certified application must move OUT of the pool so
        // Messages (bucketed by candidate.status) matches Applications.
        query
            .mockResolvedValueOnce({ rowCount: 1 })                                              // UPDATE applications → certified
            .mockResolvedValueOnce({ rows: [{ current_status: 'future_pool', has_cv: true }] })  // sync: candidate select
            .mockResolvedValueOnce({ rows: [{ status: 'certified' }] })                          // sync: applications select
            .mockResolvedValueOnce({ rowCount: 1 });                                             // sync: UPDATE candidates → certified

        await setCandidateStage('cand-3', 'certified');
        const lastCall = query.mock.calls[query.mock.calls.length - 1];
        expect(lastCall[0]).toContain('UPDATE candidates');
        expect(lastCall[1][0]).toBe('certified');
        // The WHERE no longer excludes future_pool (only merged/hired stay terminal).
        expect(lastCall[0]).not.toContain("'future_pool'");
    });

    test('future_pool STAYS parked when the best derived stage is only "new" (no forward app)', async () => {
        // A deliberately-parked candidate whose only signal derives to 'new' (e.g.
        // CV-less) must not be un-parked — preserves the flexible backup pool.
        query
            .mockResolvedValueOnce({ rows: [{ current_status: 'future_pool', has_cv: false }] }) // candidate select, no CV
            .mockResolvedValueOnce({ rows: [{ status: 'screening' }] });                         // apps select → derives 'new'

        await syncCandidateStage('cand-park');
        const issuedUpdate = query.mock.calls.some(([sql]) => /UPDATE candidates/.test(sql));
        expect(issuedUpdate).toBe(false);
        expect(query).toHaveBeenCalledTimes(2);
    });

    test('a CV-less candidate cannot be derived past New (CV gate)', async () => {
        query
            .mockResolvedValueOnce({ rowCount: 1 })                                            // UPDATE applications → screening
            .mockResolvedValueOnce({ rows: [{ current_status: 'new', has_cv: false }] })       // sync: candidate select, no CV
            .mockResolvedValueOnce({ rows: [{ status: 'screening' }] });                       // sync: applications select
        // deriveCandidateStage('screening', false) → 'new' === current → sync returns
        // BEFORE issuing an UPDATE candidates, so there is no 4th query.

        await setCandidateStage('cand-4', 'screening');
        expect(query).toHaveBeenCalledTimes(3);
        // No candidates UPDATE was issued (the gate held the candidate at New).
        const issuedCandidatesUpdate = query.mock.calls.some(
            ([sql]) => /UPDATE candidates/.test(sql)
        );
        expect(issuedCandidatesUpdate).toBe(false);
    });

    test('the CV gate also blocks CERTIFIED for a CV-less candidate (not just screening)', async () => {
        // Regression for the review finding: deriveCandidateStage previously gated
        // only 'screening', so a CV-less candidate with a certified application
        // could be re-promoted to certified. Now ALL forward stages gate to New.
        query
            .mockResolvedValueOnce({ rowCount: 1 })                                            // UPDATE applications → certified
            .mockResolvedValueOnce({ rows: [{ current_status: 'new', has_cv: false }] })       // sync: candidate select, no CV
            .mockResolvedValueOnce({ rows: [{ status: 'certified' }] });                       // sync: applications select
        // deriveCandidateStage('certified', false) → 'new' === current → no UPDATE.

        await setCandidateStage('cand-5', 'certified');
        expect(query).toHaveBeenCalledTimes(3);
        const issuedCandidatesUpdate = query.mock.calls.some(([sql]) => /UPDATE candidates/.test(sql));
        expect(issuedCandidatesUpdate).toBe(false);
    });

    test('future_pool is written directly even WITHOUT a CV (flexible backup pool)', async () => {
        // C1: future_pool is exempt from the CV gate — a candidate can be parked
        // in the pool regardless of CV. The CV check must NOT run, and the status
        // is written straight to future_pool (no fallback to New).
        query.mockResolvedValueOnce({ rowCount: 1 }); // direct UPDATE candidates → future_pool

        const res = await setCandidateStage('cand-6', 'future_pool');
        expect(res.updatedApplications).toBe(0);
        // Exactly one query: the direct write. The CV-gate point-check (a SELECT)
        // is short-circuited for future_pool, so it never fires.
        expect(query).toHaveBeenCalledTimes(1);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('UPDATE candidates');
        expect(params[0]).toBe('future_pool');
    });
});
