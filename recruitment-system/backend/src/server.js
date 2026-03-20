// Recruitment System Backend Server 
require('dotenv').config();
const http = require('http');
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { initWebSocket } = require('./utils/websocket');

// Import routes
const candidatesRouter = require('./routes/candidates');
const jobsRouter = require('./routes/jobs');
const applicationsRouter = require('./routes/applications');
const communicationsRouter = require('./routes/communications');
const webhooksRouter = require('./routes/webhooks');
const authRouter = require('./routes/auth');
const gmailRouter = require('./routes/gmail');
const mockDataRouter = require('./routes/mock-data');
const autoAssignRouter = require('./routes/auto-assign');
const projectsRouter = require('./routes/projects');
const interviewsRouter = require('./routes/interviews');
const analyticsRouter = require('./routes/analytics');

// WhatsApp Ad Integration routes
const chatbotIntakeRouter = require('./routes/chatbot-intake');
const adLinksRouter = require('./routes/ad-links');
const chatbotContextRouter = require('./routes/chatbot-context');
const chatbotSyncRouter = require('./routes/chatbot-sync');

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

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 300, // Limit each IP to 300 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    validate: { xForwardedForHeader: false }, // suppress warning — trust proxy is set above
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

// Audit middleware — fires after auth middleware sets req.user
app.use(auditMiddleware);

// API Routes
app.use('/api/auth', authRouter);
app.use('/api/candidates', candidatesRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/projects', projectsRouter); // Projects management
app.use('/api/applications', applicationsRouter);
app.use('/api/communications', communicationsRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/mock', mockDataRouter); // Mock data for development/testing
app.use('/api/auto-assign', autoAssignRouter); // Auto-assign CVs to jobs

// ── Interview & Analytics routes ──────────────────────────────────────────────
app.use('/api/interviews', interviewsRouter);
app.use('/api/analytics', analyticsRouter);

// ── WhatsApp Ad Integration ──────────────────────────────────────────────
app.use('/api/chatbot/intake', chatbotIntakeRouter); // POST /api/chatbot/intake
app.use('/api/chatbot', chatbotIntakeRouter); // GET  /api/chatbot/jobs, POST /api/chatbot/sync-message
app.use('/api/ad-links', adLinksRouter);
app.use('/api/public', chatbotContextRouter);
app.use('/api/chatbot-sync', chatbotSyncRouter);

// Knowledge Base API (NEW)
const knowledgeBaseRouter = require('./routes/knowledge-base');
app.use('/api/knowledge-base', knowledgeBaseRouter);

// Only mount Supabase routes if configured
if (supabaseCandidatesRouter) {
    app.use('/api/supabase', supabaseCandidatesRouter); // Supabase/n8n data routes
}

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
