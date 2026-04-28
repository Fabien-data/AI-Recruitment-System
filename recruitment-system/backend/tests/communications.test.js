const express = require('express');
const request = require('supertest');

jest.mock('../src/config/database', () => ({
    query: jest.fn(),
    generateUUID: jest.fn(() => 'uuid-1234'),
}));

jest.mock('../src/middleware/auth', () => ({
    authenticate: (req, res, next) => {
        req.user = { id: 'agent-1', name: 'Agent Alice', email: 'alice@example.com' };
        next();
    },
    authorize: () => (req, res, next) => next(),
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

const { query } = require('../src/config/database');
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
});