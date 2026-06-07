// Unit tests for the bulk application import service. All DB + storage access is
// mocked; we assert the cascade behaviour, dedup/skip rules, the certified status
// and the CV-gate bypass described in the plan.

jest.mock('../src/config/database', () => ({
    query: jest.fn(),
    withTransaction: jest.fn(),
    generateUUID: jest.fn(),
}));
jest.mock('../src/utils/gcs-upload', () => ({ saveCVFile: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }));
// candidate-stage pulls in the DB + websocket; stub the two symbols the service uses.
jest.mock('../src/services/candidate-stage', () => ({
    normalizeApplicationStatus: (s) => s,
    syncCandidateStage: jest.fn().mockResolvedValue(undefined),
}));

const { query, withTransaction, generateUUID } = require('../src/config/database');
const { saveCVFile } = require('../src/utils/gcs-upload');
const { syncCandidateStage } = require('../src/services/candidate-stage');
const svc = require('../src/services/bulk-import-service');

const JOBS = [{ id: 'job-sec', title: 'Security Guard' }, { id: 'job-clean', title: 'Cleaner' }];

// Capture every client.query issued inside the per-row transaction so we can
// assert the SQL/params of the cascade.
let clientQueries;

function wireDb({ dupRows = [] } = {}) {
    let uuid = 0;
    generateUUID.mockImplementation(() => `uuid-${++uuid}`);

    query.mockImplementation((sql) => {
        if (/FROM jobs WHERE project_id/.test(sql)) return Promise.resolve({ rows: JOBS });
        if (/SELECT id FROM candidates WHERE phone/.test(sql)) return Promise.resolve({ rows: dupRows });
        return Promise.resolve({ rows: [] });
    });

    clientQueries = [];
    withTransaction.mockImplementation(async (cb) => {
        const client = {
            query: jest.fn((sql, params) => {
                clientQueries.push([sql, params]);
                return Promise.resolve({ rows: [] });
            }),
        };
        return cb(client);
    });
}

function findClientSql(re) {
    return clientQueries.find(([sql]) => re.test(sql));
}

const baseOpts = { projectId: 'proj-1', defaultJobId: null, userId: 'user-1', batchId: 'batch-abc' };

beforeEach(() => jest.clearAllMocks());

describe('importApplicationBatch — cascade', () => {
    test('CV present → creates candidate/cv/certified application/conversation and re-derives stage', async () => {
        wireDb();
        saveCVFile.mockResolvedValue({ url: 'https://gcs/cv.pdf', name: 'cv.pdf' });

        const rows = [{ _index: 0, name: 'John Silva', phone: '0771234567', job_title: 'Security Guard', labels: 'urgent; excellent_english' }];
        const files = { 0: { buffer: Buffer.from('pdf'), originalname: 'john_cv.pdf', mimetype: 'application/pdf' } };

        const { results, summary } = await svc.importApplicationBatch(rows, files, baseOpts);

        expect(results[0].status).toBe('created');
        expect(results[0].cv_attached).toBe(true);
        expect(summary).toEqual({ created: 1, skipped_duplicate: 0, error: 0, cv_attached: 1 });

        // application inserted as certified, idempotently, bypassing the HTTP gate
        const appInsert = findClientSql(/INSERT INTO applications/);
        expect(appInsert[0]).toMatch(/'certified'/);
        expect(appInsert[0]).toMatch(/ON CONFLICT|ON DUPLICATE KEY/);

        // cv_files row + cv_uploaded flag written
        expect(findClientSql(/INSERT INTO cv_files/)).toBeTruthy();
        expect(findClientSql(/UPDATE candidates SET cv_uploaded = TRUE/)).toBeTruthy();

        // conversation row written
        expect(findClientSql(/INSERT INTO communications/)).toBeTruthy();

        // labels land on candidates.tags
        const candInsert = findClientSql(/INSERT INTO candidates/);
        const tagsParam = candInsert[1][7]; // 8th param = tags
        const tags = Array.isArray(tagsParam) ? tagsParam : JSON.parse(tagsParam);
        expect(tags).toEqual(['urgent', 'excellent_english']);

        // post-commit stage derivation
        expect(syncCandidateStage).toHaveBeenCalledWith(results[0].candidate_id);
    });

    test('no CV → still creates a certified application, flagged cv_missing', async () => {
        wireDb();
        const rows = [{ _index: 0, name: 'No CV Guy', phone: '0719876543', job_title: 'Cleaner' }];

        const { results } = await svc.importApplicationBatch(rows, {}, baseOpts);

        expect(results[0].status).toBe('created');
        expect(results[0].cv_attached).toBe(false);
        expect(results[0].reason).toBe('cv_missing');
        expect(saveCVFile).not.toHaveBeenCalled();

        // no cv_files row
        expect(findClientSql(/INSERT INTO cv_files/)).toBeFalsy();
        // application still certified
        expect(findClientSql(/INSERT INTO applications/)[0]).toMatch(/'certified'/);
        // candidate metadata marks cv_missing
        const candInsert = findClientSql(/INSERT INTO candidates/);
        const meta = JSON.parse(candInsert[1][12]); // 13th param = metadata json
        expect(meta.cv_missing).toBe(true);
        expect(meta.import_batch_id).toBe('batch-abc');
    });
});

describe('importApplicationBatch — dedup & skip rules', () => {
    test('in-file duplicate (same phone twice) keeps first, skips the rest', async () => {
        wireDb();
        const rows = [
            { _index: 0, name: 'First', phone: '0771234567', job_title: 'Security Guard' },
            { _index: 1, name: 'Dup', phone: '077 123 4567', job_title: 'Security Guard' },
        ];

        const { results, summary } = await svc.importApplicationBatch(rows, {}, baseOpts);

        expect(results[0].status).toBe('created');
        expect(results[1].status).toBe('skipped_duplicate');
        expect(results[1].reason).toBe('in_file');
        expect(summary.created).toBe(1);
        expect(summary.skipped_duplicate).toBe(1);
    });

    test('DB duplicate is skipped, system record untouched, match reported', async () => {
        wireDb({ dupRows: [{ id: 'existing-cand' }] });
        const rows = [{ _index: 0, name: 'Already Here', phone: '0771112222', job_title: 'Security Guard' }];

        const { results } = await svc.importApplicationBatch(rows, {}, baseOpts);

        expect(results[0].status).toBe('skipped_duplicate');
        expect(results[0].reason).toBe('db');
        expect(results[0].matched_candidate_id).toBe('existing-cand');
        // never opened a transaction → existing record untouched
        expect(withTransaction).not.toHaveBeenCalled();
    });

    test('unknown job with no default errors the row without creating a candidate', async () => {
        wireDb();
        const rows = [{ _index: 0, name: 'Lost Job', phone: '0773334444', job_title: 'Astronaut' }];

        const { results } = await svc.importApplicationBatch(rows, {}, baseOpts);

        expect(results[0].status).toBe('error');
        expect(results[0].reason).toBe('unresolved_job');
        expect(withTransaction).not.toHaveBeenCalled();
    });

    test('invalid phone and missing name are reported as errors, never inserted', async () => {
        wireDb();
        const rows = [
            { _index: 0, name: '', phone: '0771234567', job_title: 'Security Guard' },
            { _index: 1, name: 'Bad Phone', phone: 'not-a-number', job_title: 'Security Guard' },
        ];

        const { results } = await svc.importApplicationBatch(rows, {}, baseOpts);
        expect(results[0].reason).toBe('missing_name');
        expect(results[1].reason).toBe('invalid_phone');
        expect(withTransaction).not.toHaveBeenCalled();
    });

    test('a duplicate that races past the pre-check (trigger throws) is treated as a skip', async () => {
        wireDb();
        withTransaction.mockRejectedValueOnce(new Error('Duplicate candidate: phone already exists'));
        const rows = [{ _index: 0, name: 'Racer', phone: '0775556666', job_title: 'Security Guard' }];

        const { results } = await svc.importApplicationBatch(rows, {}, baseOpts);
        expect(results[0].status).toBe('skipped_duplicate');
        expect(results[0].reason).toBe('db_race');
    });
});

describe('analyzeRows (dry-run) + helpers', () => {
    test('classifies create / in-file dup / db dup / unresolved / missing-cv', () => {
        const report = svc.analyzeRows(
            [
                { _index: 0, name: 'A', phone: '0770000001', job_title: 'Security Guard', cv_present: true },
                { _index: 1, name: 'A2', phone: '077 000 0001', job_title: 'Security Guard', cv_present: true }, // in-file dup
                { _index: 2, name: 'B', phone: '0770000002', job_title: 'Cleaner', cv_present: false },           // missing cv
                { _index: 3, name: 'C', phone: '0770000003', job_title: 'Astronaut', cv_present: true },          // unresolved job
                { _index: 4, name: 'D', phone: '0770000004', email: 'd@x.com', job_title: 'Cleaner', cv_present: true }, // db dup
                { _index: 5, name: '', phone: '0770000005', job_title: 'Cleaner', cv_present: true },             // error: missing name
            ],
            {
                jobs: JOBS,
                defaultJobId: null,
                existingPhones: new Set(['+94770000004']),
                existingEmails: new Set(),
            }
        );

        expect(report.total).toBe(6);
        expect(report.in_file_dups).toBe(1);
        expect(report.db_dups).toBe(1);
        expect(report.unresolved_job).toBe(1);
        expect(report.errors).toBe(1);
        expect(report.missing_cv).toBe(1);
        expect(report.will_create).toBe(2); // rows 0 and 2
    });

    test('resolveJobId: exact, partial, default fallback, and miss', () => {
        expect(svc.resolveJobId({ job_title: 'security guard' }, JOBS, null)).toBe('job-sec');
        expect(svc.resolveJobId({ job_title: 'Cleaner (night)' }, JOBS, null)).toBe('job-clean');
        expect(svc.resolveJobId({ job_title: '' }, JOBS, 'job-clean')).toBe('job-clean');
        expect(svc.resolveJobId({ job_title: 'Astronaut' }, JOBS, null)).toBe(null);
    });

    test('splitList and normalizeGender coercions', () => {
        expect(svc.splitList('a; b, c')).toEqual(['a', 'b', 'c']);
        expect(svc.splitList('')).toEqual([]);
        expect(svc.normalizeGender('M')).toBe('male');
        expect(svc.normalizeGender('woman')).toBe('female');
    });
});
