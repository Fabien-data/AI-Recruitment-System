const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({
    query: jest.fn(),
    generateUUID: jest.fn(() => 'uuid-1234'),
}));

jest.mock('../src/middleware/auth', () => ({
    authenticate: (req, res, next) => {
        req.user = { id: 'agent-1', name: 'Agent Alice', email: 'alice@example.com', role: 'admin' };
        next();
    },
    authorize: () => (req, res, next) => next(),
}));

// Access-control middleware is exercised in its own unit (sections logic); here
// it's a pass-through so these route tests stay focused on communications logic.
jest.mock('../src/middleware/sections', () => ({
    requireSection: () => (req, res, next) => next(),
}));

jest.mock('../src/utils/gcs-upload', () => ({
    uploadToGCS: jest.fn(),
}));

jest.mock('../src/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
}));

jest.mock('../src/services/whatsapp', () => ({
    sendTextMessage: jest.fn(),
    sendMediaMessage: jest.fn(),
    sendTemplateMessage: jest.fn(),
}));

jest.mock('../src/services/gmail', () => ({
    isConnected: jest.fn(),
    sendEmail: jest.fn(),
    sendAutoReply: jest.fn(),
}));

const { query } = require('../src/config/database');
const { uploadToGCS } = require('../src/utils/gcs-upload');
const whatsappService = require('../src/services/whatsapp');
const gmailService = require('../src/services/gmail');
const communicationsRouter = require('../src/routes/communications');

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/communications', communicationsRouter);
    app.use((err, req, res, next) => {
        res.status(500).json({ error: err.message });
    });
    return app;
}

describe('Communications routes', () => {
    let app;

    beforeEach(() => {
        app = createApp();
        jest.clearAllMocks();
    });

    test('active-chats forwards sidebar filters and sort options', async () => {
        query.mockResolvedValueOnce({ rows: [] });

        await request(app)
            .get('/api/communications/active-chats')
            .query({
                search: '9476',
                pipeline_stage: 'cv_uploaded',
                handoff_state: 'human',
                response_status: 'unread',
                sort_by: 'latest_asc',
                date_from: '2026-04-01',
                date_to: '2026-04-07',
            })
            .expect(200);

        expect(query).toHaveBeenCalledTimes(1);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('cv_uploaded');
        expect(sql).toContain('human_takeover_active');
        expect(sql).toContain('ORDER BY COALESCE(lm.sent_at, ca.created_at) ASC');
        expect(sql).toContain('lm.read_at IS NULL');
        expect(params).toEqual(expect.arrayContaining(['%9476%', 'cv_uploaded', '2026-04-01', '2026-04-07']));
    });

    test('active-chats filters by status bucket and effective project (latest app OR ad)', async () => {
        query.mockResolvedValueOnce({ rows: [] });

        await request(app)
            .get('/api/communications/active-chats')
            .query({ status: 'screening', project_id: 'proj-9' })
            .expect(200);

        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain("LOWER(COALESCE(ca.status, 'new'))");
        expect(sql).toContain('COALESCE(la.project_id, adt.project_id)');
        expect(sql).toContain('effective_project_id');
        expect(sql).toContain('ad_tracking');
        expect(params).toEqual(expect.arrayContaining(['screening', 'proj-9']));
    });

    test('active-chats unassigned project filter matches a null effective project', async () => {
        query.mockResolvedValueOnce({ rows: [] });

        await request(app)
            .get('/api/communications/active-chats')
            .query({ status: 'new', project_id: 'unassigned' })
            .expect(200);

        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('COALESCE(la.project_id, adt.project_id) IS NULL');
        expect(params).toEqual(expect.arrayContaining(['new']));
        expect(params).not.toContain('unassigned');   // sentinel, not a bound param
    });

    test('status-sync persists delivered/read updates by whatsapp message id', async () => {
        query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

        await request(app)
            .post('/api/communications/status-sync')
            .set('x-chatbot-api-key', process.env.CHATBOT_API_KEY)
            .send({
                whatsapp_message_id: 'wamid.test-001',
                status: 'delivered',
                recipient_id: '94765716780',
                timestamp: 1712476800,
            })
            .expect(200);

        expect(query).toHaveBeenCalledTimes(1);
        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('whatsapp_message_id');
        expect(sql).toContain('delivered_at');
        expect(params).toEqual(expect.arrayContaining(['wamid.test-001', '2024-04-07T08:00:00.000Z']));
    });

    test('delivery-audit returns aggregate delivery metrics', async () => {
        query.mockImplementationOnce(async () => ({
            rows: [{
                total_sent: 10,
                delivered: 8,
                read: 5,
                media_sent: 3,
                media_delivered: 2,
            }],
        }));

        const response = await request(app)
            .get('/api/communications/delivery-audit')
            .query({ date_from: '2026-04-01', date_to: '2026-04-07' })
            .expect(200);

        expect(response.body.channel).toBe('whatsapp');
        expect(response.body.totals).toEqual(expect.objectContaining({
            total_sent: expect.any(Number),
            delivered: expect.any(Number),
            read: expect.any(Number),
            media_sent: expect.any(Number),
            media_delivered: expect.any(Number),
        }));
        expect(query).toHaveBeenCalledTimes(1);
    });

    // ── candidate context endpoint ───────────────────────────────────────────

    test('GET /candidate/:id/context returns application and interview rows', async () => {
        // application query
        query.mockResolvedValueOnce({
            rows: [{
                application_id: 'app-1',
                job_title: 'Warehouse Packer',
                job_description_snippet: 'Pack goods in warehouse.',
                application_status: 'interview_scheduled',
            }],
        });
        // upcoming interview query
        query.mockResolvedValueOnce({
            rows: [{
                id: 'iv-1',
                interview_job_title: 'Warehouse Packer',
                scheduled_datetime: '2026-05-10T09:00:00Z',
                location: 'Colombo Office',
                status: 'scheduled',
            }],
        });

        const res = await request(app)
            .get('/api/communications/candidate/cand-1/context')
            .expect(200);

        expect(res.body.application.job_title).toBe('Warehouse Packer');
        expect(res.body.interview.location).toBe('Colombo Office');
    });

    test('GET /candidate/:id/context falls back to last past interview when none upcoming', async () => {
        query.mockResolvedValueOnce({ rows: [{ application_id: 'app-1', job_title: 'Driver', job_description_snippet: '', application_status: 'applied' }] });
        query.mockResolvedValueOnce({ rows: [] }); // no upcoming
        query.mockResolvedValueOnce({ rows: [{ id: 'iv-past', interview_job_title: 'Driver', scheduled_datetime: '2026-03-01T09:00:00Z', location: 'TBD', status: 'completed' }] });

        const res = await request(app)
            .get('/api/communications/candidate/cand-2/context')
            .expect(200);

        expect(res.body.interview.id).toBe('iv-past');
    });

    // ── POST /send — WhatsApp only ───────────────────────────────────────────

    test('POST /send whatsapp-only delivers text and returns simulated:false', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'cand-1', name: 'Ali', phone: '94771234567', whatsapp_phone: '94771234567', email: 'ali@example.com' }] });
        whatsappService.sendTextMessage.mockResolvedValueOnce({ messages: [{ id: 'wamid.001' }] });
        query.mockResolvedValueOnce({ rowCount: 1 }); // insertCommunicationMessage
        query.mockResolvedValueOnce({ rowCount: 1 }); // clear intervention

        const res = await request(app)
            .post('/api/communications/send')
            .send({ candidate_id: 'cand-1', channel: 'whatsapp', message: 'Hello from agent' })
            .expect(201);

        expect(res.body.simulated).toBe(false);
        expect(res.body.whatsapp_message_id).toBe('wamid.001');
        expect(whatsappService.sendTextMessage).toHaveBeenCalledWith('94771234567', 'Hello from agent');
    });

    test('POST /send whatsapp returns simulated:true when WhatsApp API throws', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'cand-1', name: 'Ali', phone: '94771234567', whatsapp_phone: '94771234567', email: null }] });
        whatsappService.sendTextMessage.mockRejectedValueOnce(new Error('Outside 24h window'));
        query.mockResolvedValueOnce({ rowCount: 1 }); // insert
        query.mockResolvedValueOnce({ rowCount: 1 }); // clear

        const res = await request(app)
            .post('/api/communications/send')
            .send({ candidate_id: 'cand-1', channel: 'whatsapp', message: 'Hi' })
            .expect(201);

        expect(res.body.simulated).toBe(true);
        expect(res.body.delivery_errors.whatsapp).toContain('Outside 24h window');
    });

    // ── POST /send — email only ──────────────────────────────────────────────

    test('POST /send email-only calls sendEmail with the typed body', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'cand-2', name: 'Sara', phone: null, whatsapp_phone: null, email: 'sara@example.com' }] });
        gmailService.isConnected.mockResolvedValueOnce(true);
        gmailService.sendEmail.mockResolvedValueOnce(true);
        query.mockResolvedValueOnce({ rowCount: 1 });
        query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app)
            .post('/api/communications/send')
            .send({ candidate_id: 'cand-2', channel: 'email', message: 'Please come for the interview.' })
            .expect(201);

        expect(gmailService.sendEmail).toHaveBeenCalledWith(
            'sara@example.com',
            'Message from Dewan Recruitment',
            'Please come for the interview.',
            [],
        );
        expect(res.body.simulated).toBe(false);
    });

    test('POST /send email-only returns simulated:true when Gmail not connected', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'cand-2', name: 'Sara', phone: null, whatsapp_phone: null, email: 'sara@example.com' }] });
        gmailService.isConnected.mockResolvedValueOnce(false);
        query.mockResolvedValueOnce({ rowCount: 1 });
        query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app)
            .post('/api/communications/send')
            .send({ candidate_id: 'cand-2', channel: 'email', message: 'Hi' })
            .expect(201);

        expect(res.body.simulated).toBe(true);
        expect(res.body.delivery_errors.email).toContain('Gmail not connected');
        expect(gmailService.sendEmail).not.toHaveBeenCalled();
    });

    test('POST /send email-only returns 201 with error when candidate has no email', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'cand-3', name: 'Bob', phone: '9477000000', whatsapp_phone: null, email: null }] });
        gmailService.isConnected.mockResolvedValueOnce(true);
        query.mockResolvedValueOnce({ rowCount: 1 });
        query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app)
            .post('/api/communications/send')
            .send({ candidate_id: 'cand-3', channel: 'email', message: 'Hi' })
            .expect(201);

        expect(res.body.channel_results.email.error).toContain('no email');
        expect(res.body.simulated).toBe(true);
        expect(gmailService.sendEmail).not.toHaveBeenCalled();
    });

    // ── POST /send — send to both ────────────────────────────────────────────

    test('POST /send channels=whatsapp,email dispatches to both and reports per-channel', async () => {
        query.mockResolvedValueOnce({ rows: [{ id: 'cand-4', name: 'Nimal', phone: '94779999999', whatsapp_phone: '94779999999', email: 'nimal@example.com' }] });
        whatsappService.sendTextMessage.mockResolvedValueOnce({ messages: [{ id: 'wamid.002' }] });
        gmailService.isConnected.mockResolvedValueOnce(true);
        gmailService.sendEmail.mockResolvedValueOnce(true);
        query.mockResolvedValueOnce({ rowCount: 1 });
        query.mockResolvedValueOnce({ rowCount: 1 });

        const res = await request(app)
            .post('/api/communications/send')
            .send({ candidate_id: 'cand-4', channels: 'whatsapp,email', message: 'Interview reminder' })
            .expect(201);

        expect(res.body.channels).toEqual(expect.arrayContaining(['whatsapp', 'email']));
        expect(res.body.channel_results.whatsapp.simulated).toBe(false);
        expect(res.body.channel_results.email.simulated).toBe(false);
        expect(res.body.simulated).toBe(false);
        expect(whatsappService.sendTextMessage).toHaveBeenCalledTimes(1);
        expect(gmailService.sendEmail).toHaveBeenCalledTimes(1);
    });

    // ── default-message / context composition ────────────────────────────────

    test('GET /candidate/:id/context returns empty application and null interview when no records exist', async () => {
        query.mockResolvedValueOnce({ rows: [] });
        query.mockResolvedValueOnce({ rows: [] });
        query.mockResolvedValueOnce({ rows: [] });

        const res = await request(app)
            .get('/api/communications/candidate/cand-unknown/context')
            .expect(200);

        expect(res.body.application).toBeNull();
        expect(res.body.interview).toBeNull();
    });
});