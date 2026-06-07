// Recruitment System Backend Server 
require('dotenv').config();
const http = require('http');
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { initWebSocket } = require('./utils/websocket');

// Import routes
const candidatesRouter = require('./routes/candidates');
const jobsRouter = require('./routes/jobs');
const applicationsRouter = require('./routes/applications');
const bulkImportRouter = require('./routes/bulk-import');
const communicationsRouter = require('./routes/communications');
const webhooksRouter = require('./routes/webhooks');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const gmailRouter = require('./routes/gmail');
const autoAssignRouter = require('./routes/auto-assign');
const projectsRouter = require('./routes/projects');
const interviewsRouter = require('./routes/interviews');
const analyticsRouter = require('./routes/analytics');
const notificationsRouter = require('./routes/notifications');
const candidateTasksRouter = require('./routes/candidate-tasks');
const engagementRouter = require('./routes/engagement');

// WhatsApp Ad Integration routes
const chatbotIntakeRouter = require('./routes/chatbot-intake');
const adLinksRouter = require('./routes/ad-links');
const chatbotContextRouter = require('./routes/chatbot-context');
const chatbotSyncRouter = require('./routes/chatbot-sync');
const marketingHubRouter = require('./routes/marketing-hub');
const marketingAnalyticsRouter = require('./routes/analytics-marketing');
const threecxWebhookRouter = require('./routes/webhooks-3cx');

// Only load Supabase routes if configured
let supabaseCandidatesRouter = null;
if (process.env.SUPABASE_URL) {
    supabaseCandidatesRouter = require('./routes/supabase-candidates');
}

// n8n Integration: Email processing is now handled by n8n workflows
// The email processor job has been replaced by n8n Gmail CV Retriever workflow
// See: n8n/workflows/02-gmail-cv-retriever.json
const USE_N8N_FOR_EMAIL = process.env.USE_N8N_FOR_EMAIL !== 'false';

// Legacy email processor (only loaded if not using n8n)
let startEmailPolling, stopEmailPolling, isPollingActive;
if (!USE_N8N_FOR_EMAIL) {
    const emailProcessor = require('./jobs/emailProcessor');
    startEmailPolling = emailProcessor.startEmailPolling;
    stopEmailPolling = emailProcessor.stopEmailPolling;
    isPollingActive = emailProcessor.isPollingActive;
}

// Import middleware
const errorHandler = require('./middleware/errorHandler');
const auditMiddleware = require('./middleware/audit');
const logger = require('./utils/logger');
const { applyMigrations } = require('./config/migrations');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Cloud Run / GCP load-balancer proxy (fixes express-rate-limit X-Forwarded-For validation)
// See: https://expressjs.com/en/guide/behind-proxies.html
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration — allow frontend origins (local + production)
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:3000',
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
    'https://recruitment.markui.lk'
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (curl, Postman, server-to-server) or listed origins
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true
}));

// Rate limiting — keyed by the AUTHENTICATED USER, not the IP. Our agents share a
// single office IP (NAT), so a per-IP cap lumped them all into one budget and the
// polling dashboard 429'd everyone (worse since the backend is pinned to one
// instance → one in-memory counter). Each logged-in agent now gets their own
// generous budget; anonymous traffic keeps the original tight per-IP cap for
// login brute-force protection. (High-frequency chatbot/3cx/internal routes have
// their own dedicated limiters.)
function rateLimitUserId(req) {
    if (req._rlUserId !== undefined) return req._rlUserId;
    let uid = null;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ') && process.env.JWT_SECRET) {
        try {
            const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
            uid = decoded.userId || decoded.id || null;
        } catch (e) { uid = null; }
    }
    req._rlUserId = uid;
    return uid;
}

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    // Authenticated agent → 2000/15min keyed by user; anonymous → 300/15min by IP.
    max: (req) => (rateLimitUserId(req) ? 2000 : 300),
    keyGenerator: (req) => {
        const uid = rateLimitUserId(req);
        return uid ? `user:${uid}` : (req.ip || 'unknown');
    },
    message: { error: 'Too many requests, please slow down and try again shortly.' },
    validate: false, // disable dev-time sanity warnings (custom keyGenerator + trust proxy)
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Local file uploads (CVs etc.)
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
app.use('/uploads', express.static(path.resolve(uploadDir)));

// Logging
app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV
    });
});

// ── Internal endpoints (Cloud Scheduler, protected by API key) ────────────────
app.post('/api/internal/process-queue', async (req, res) => {
    const internalKey = process.env.INTERNAL_API_KEY;
    const provided = req.headers['x-internal-key'] || req.query.key;
    if (internalKey && provided !== internalKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const notifService = require('./services/notifications');
        const interviewReminders = require('./services/interview-reminder');
        const [notifResult, reminderResult] = await Promise.allSettled([
            notifService.processNotificationQueue(),
            interviewReminders.sendPendingReminders()
        ]);
        res.json({
            notifications: notifResult.status,
            interview_reminders: reminderResult.status,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        logger.error('process-queue endpoint error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Daily recruitment digest — Cloud Scheduler hits this once each morning.
app.post('/api/internal/daily-digest', async (req, res) => {
    const internalKey = process.env.INTERNAL_API_KEY;
    const provided = req.headers['x-internal-key'] || req.query.key;
    if (internalKey && provided !== internalKey) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const { runDailyDigest } = require('./services/daily-digest');
        const digest = await runDailyDigest();
        res.json({ ok: true, digest });
    } catch (err) {
        logger.error('daily-digest endpoint error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Audit middleware — fires after auth middleware sets req.user
app.use(auditMiddleware);

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/candidates', candidatesRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/projects', projectsRouter); // Projects management
// Mount bulk-import BEFORE the generic applications router so the more specific
// /bulk-import/* path is matched first.
app.use('/api/applications/bulk-import', bulkImportRouter);
app.use('/api/applications', applicationsRouter);
app.use('/api/communications', communicationsRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/auto-assign', autoAssignRouter); // Auto-assign CVs to jobs

// ── Interview & Analytics routes ──────────────────────────────────────────────
app.use('/api/interviews', interviewsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/candidate-tasks', candidateTasksRouter);
app.use('/api/engagement', engagementRouter);
app.use('/api/preferences', require('./routes/preferences'));
app.use('/api/me', require('./routes/work-today'));
app.use('/api/search', require('./routes/search'));
app.use('/api/control-tower', require('./routes/control-tower'));

// ── WhatsApp Ad Integration ──────────────────────────────────────────────
app.use('/api/chatbot/intake', chatbotIntakeRouter); // POST /api/chatbot/intake
app.use('/api/chatbot', chatbotIntakeRouter); // GET  /api/chatbot/jobs, POST /api/chatbot/sync-message
app.use('/api/ad-links', adLinksRouter);
app.use('/api/public/job-context', chatbotContextRouter);
app.use('/api/chatbot-sync', chatbotSyncRouter);

// Knowledge Base API (NEW)
const knowledgeBaseRouter = require('./routes/knowledge-base');
app.use('/api/knowledge-base', knowledgeBaseRouter);

// Knowledge Base Documents — recruiter uploads PDF/DOCX/TXT, parsed + chunked
// so the chatbot can retrieve passages alongside FAQ entries.
const knowledgeDocumentsRouter = require('./routes/knowledge-documents');
app.use('/api/knowledge-documents', knowledgeDocumentsRouter);

// Marketing Hub — analytics router must be mounted BEFORE the broader hub
// router so the /analytics prefix wins (Express matches in declaration order).
app.use('/api/marketing-hub/analytics', marketingAnalyticsRouter);
app.use('/api/marketing-hub', marketingHubRouter);

// Only mount Supabase routes if configured
if (supabaseCandidatesRouter) {
    app.use('/api/supabase', supabaseCandidatesRouter); // Supabase/n8n data routes
}

// More specific mount must come first so /webhooks/3cx/* doesn't fall into webhooksRouter.
app.use('/webhooks/3cx', threecxWebhookRouter); // 3CX PBX call events (shared-secret auth)
app.use('/webhooks', webhooksRouter); // No auth required for webhooks

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'Recruitment System API',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            api: '/api',
            docs: '/api/docs'
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        path: req.path
    });
});

// Error handling middleware (must be last)
app.use(errorHandler);


// Start server — apply DB migrations first, then listen
applyMigrations()
    .then(() => {
        // Create an http.Server so Socket.io can attach
        const server = http.createServer(app);

        server.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
            logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
            logger.info(`Health check: http://localhost:${PORT}/health`);

            // ── Initialize Socket.io WebSocket server ─────────────────────
            initWebSocket(server);
            logger.info('🔌 WebSocket (Socket.io) server ready');

            // ── In-call presence TTL sweep ─────────────────────────────────
            // Backstop for hard crashes where the socket 'disconnect' cleanup
            // never ran: clear any 'on_call' rows whose heartbeat went stale
            // (the frontend heartbeats every ~60s while a call toggle is ON).
            try {
                const { query } = require('./config/database');
                const { getIO } = require('./utils/websocket');
                const STALE_MIN = parseInt(process.env.CALL_PRESENCE_TTL_MIN, 10) || 15;
                const sweepStaleCalls = async () => {
                    try {
                        const stale = await query(
                            `SELECT id FROM candidates
                             WHERE call_status = 'on_call'
                               AND call_started_at < NOW() - make_interval(mins => $1)`,
                            [STALE_MIN]
                        );
                        if (!stale.rows || stale.rows.length === 0) return;
                        await query(
                            `UPDATE candidates SET call_status = NULL, call_agent_id = NULL, call_started_at = NULL
                             WHERE call_status = 'on_call'
                               AND call_started_at < NOW() - make_interval(mins => $1)`,
                            [STALE_MIN]
                        );
                        const io = getIO();
                        if (io) {
                            for (const r of stale.rows) {
                                io.emit('call_status_changed', {
                                    candidate_id: r.id, on_call: false, ts: new Date().toISOString(),
                                });
                            }
                        }
                        logger.info(`Call-presence TTL sweep cleared ${stale.rows.length} stale on_call row(s)`);
                    } catch (err) {
                        logger.debug(`call-presence sweep skipped: ${err.message}`);
                    }
                };
                const sweepTimer = setInterval(sweepStaleCalls, 60 * 1000);
                sweepTimer.unref();
            } catch (err) {
                logger.warn(`call-presence TTL sweep not started: ${err.message}`);
            }

            // ── Start chatbot knowledge sync worker (outbox drain + reconcile)
            try {
                const chatbotSyncWorker = require('./workers/chatbot-sync-worker');
                chatbotSyncWorker.start();
            } catch (err) {
                logger.warn(`chatbot-sync-worker failed to start: ${err.message}`);
            }

            // ── Validate WhatsApp credentials (non-blocking) ───────────────
            // Catches an expired/invalid token at boot rather than when an
            // agent first tries to send and hits "Cannot parse access token".
            try {
                const { verifyCredentials } = require('./services/whatsapp');
                verifyCredentials().then((res) => {
                    if (res.ok) {
                        logger.info('✅ WhatsApp credentials validated against Meta');
                    } else {
                        logger.error(
                            `⚠️  WhatsApp credentials check failed: ${res.error}` +
                            (res.code ? ` (Meta code ${res.code})` : '') +
                            '. Outbound WhatsApp will fail until WHATSAPP_ACCESS_TOKEN is fixed.'
                        );
                    }
                }).catch(() => { /* never block startup on this */ });
            } catch (err) {
                logger.warn(`WhatsApp credential check skipped: ${err.message}`);
            }

            // n8n Integration Mode
            if (USE_N8N_FOR_EMAIL) {
                logger.info('📧 Email processing: HANDLED BY n8n workflows');
                logger.info('📱 WhatsApp processing: HANDLED BY n8n workflows');
                logger.info('💡 This backend serves the dashboard API only');
            } else {
                const pollInterval = parseInt(process.env.GMAIL_POLL_INTERVAL) || 2;
                startEmailPolling(pollInterval);
                logger.info(`Email polling started (every ${pollInterval} minutes)`);
            }
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            logger.info('SIGTERM signal received: closing HTTP server');
            if (!USE_N8N_FOR_EMAIL && stopEmailPolling) stopEmailPolling();
            server.close(() => {
                logger.info('HTTP server closed');
                process.exit(0);
            });
        });
    })
    .catch(err => {
        logger.error('Startup migrations encountered errors (non-fatal):', err.message);
    });

module.exports = app;
