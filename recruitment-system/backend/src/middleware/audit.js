/**
 * Audit Logging Middleware
 *
 * Two passes:
 *   1. Mutations (POST / PUT / PATCH / DELETE) — always logged with action
 *      create/update/delete and the request body in `changes`.
 *   2. Views (authenticated GETs against tracked entity routes) — logged with
 *      action 'view' and de-duped per (user, path) for 30 seconds so dashboards
 *      and polling endpoints don't flood the table.
 *
 * Every row carries entity_type, section_key (derived from entity_type),
 * session_id (from req.user, set by auth middleware) and duration_ms (measured
 * via res.on('finish')). Skips internal/health/webhook/polling paths.
 *
 * Mount AFTER authenticate middleware:
 *   app.use(auditMiddleware);
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');

// Paths skipped for ALL methods (mutations + views).
const SKIP_PATHS = [
    '/health',
    '/api/auth/login',
    '/api/auth/register',
    // /api/auth/logout writes its own audit row (action='logout') with the
    // matching session_id — letting the generic mutation logger also fire
    // would create duplicate "update session" rows.
    '/api/auth/logout',
    '/webhooks',
    '/api/internal',
];

// Additional paths skipped for view-tracking only. These are noisy polling /
// dashboard endpoints that would otherwise dominate audit_logs.
const VIEW_SKIP_PATHS = [
    '/api/admin/audit-logs',
    '/api/admin/activity',
    '/api/admin/stats',
    '/api/admin/users/',
    '/api/auth/me',
    '/api/notifications',
    '/api/chatbot-sync/outbox-status',
    '/api/communications/poll',
    '/api/interviews/upcoming',
    '/uploads',
];

// Entity → section_key mapping. Keys are derived from the URL by parseEntity().
// Anything missing here lands on 'section_key = null' and falls into '_other'
// in the KPI section_usage breakdown.
const ENTITY_TO_SECTION = {
    candidate:           'candidates',
    job:                 'jobs',
    project:             'projects',
    application:         'applications',
    interview:           'interviews',
    communication:       'communications',
    cv:                  'cv_manager',
    knowledge_base:      'knowledge_base',
    knowledge_document:  'knowledge_base',
    marketing:           'marketing_hub',
    marketing_hub:       'marketing_hub',
    lead:                'marketing_hub',
    analytics:           'analytics',
    auto_assign:         'general_pool',
    pool:                'general_pool',
    admin:               'dashboard',
};

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// In-memory de-dupe cache for view tracking. Key = `${userId}:${path}`, value
// = last-logged epoch ms. Bounded with a periodic sweep so it can't grow forever.
const VIEW_DEDUPE_MS = 30_000;
const viewDedupe = new Map();
setInterval(() => {
    const cutoff = Date.now() - VIEW_DEDUPE_MS * 2;
    for (const [k, ts] of viewDedupe) {
        if (ts < cutoff) viewDedupe.delete(k);
    }
}, 5 * 60_000).unref?.();

function shouldSkip(path) {
    return SKIP_PATHS.some(skip => path.startsWith(skip));
}

function shouldSkipView(path) {
    if (shouldSkip(path)) return true;
    return VIEW_SKIP_PATHS.some(skip => path.startsWith(skip));
}

/**
 * Derive entity_type and entity_id from the request path.
 * e.g. /api/candidates/abc-123 → { entity_type: 'candidate', entity_id: 'abc-123' }
 */
function parseEntity(path) {
    const parts = path.replace('/api/', '').split('/');
    const entity_type = parts[0]?.replace(/-/g, '_').replace(/s$/, '') || 'unknown';
    const entity_id = parts[1] && /^[0-9a-f-]{36}$/i.test(parts[1]) ? parts[1] : null;
    return { entity_type, entity_id };
}

function getIp(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.connection?.remoteAddress ||
        req.ip ||
        'unknown'
    );
}

// Tracks whether the Migration 021 columns on audit_logs are present. Detected
// lazily on first failure and remembered so we don't repeatedly probe a schema
// we already know is partial — this keeps audit logging working when the
// ownership fix for audit_logs hasn't been applied yet.
let hasMigration021Cols = true;

async function writeAuditRow({ userId, sessionId, action, entityType, entityId, sectionKey, changes, ip, userAgent, durationMs }) {
    // Try the full insert first. Fall back to the pre-021 column set if any
    // of session_id / section_key / duration_ms aren't present yet.
    if (hasMigration021Cols) {
        try {
            await query(
                adaptQuery(`
                    INSERT INTO audit_logs
                        (user_id, action, entity_type, entity_id, changes, ip_address, user_agent, session_id, section_key, duration_ms)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `),
                [
                    userId,
                    action,
                    entityType,
                    entityId,
                    JSON.stringify(changes),
                    ip,
                    userAgent,
                    sessionId,
                    sectionKey,
                    durationMs,
                ]
            );
            return;
        } catch (err) {
            const msg = (err.message || '').toLowerCase();
            if (msg.includes('session_id') || msg.includes('section_key') || msg.includes('duration_ms') || msg.includes('column')) {
                hasMigration021Cols = false;
                logger.warn('audit-middleware: Migration 021 columns missing on audit_logs — falling back to legacy insert. Run scripts/fix-audit-ownership.js to restore full tracking.');
            } else {
                logger.warn('audit-middleware: write failed —', err.message);
                return;
            }
        }
    }

    // Legacy fallback — works against pre-Migration-021 audit_logs schema.
    try {
        await query(
            adaptQuery(`
                INSERT INTO audit_logs
                    (user_id, action, entity_type, entity_id, changes, ip_address, user_agent)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `),
            [
                userId,
                action,
                entityType,
                entityId,
                JSON.stringify(changes),
                ip,
                userAgent,
            ]
        );
    } catch (err) {
        logger.warn('audit-middleware: legacy write failed —', err.message);
    }
}

module.exports = function auditMiddleware(req, res, next) {
    const isMutation = MUTATION_METHODS.has(req.method);
    const isView = req.method === 'GET';

    if (!isMutation && !isView) return next();
    if (shouldSkip(req.path)) return next();
    if (isView && shouldSkipView(req.path)) return next();

    const startedAt = Date.now();
    const { entity_type, entity_id } = parseEntity(req.path);
    const sectionKey = ENTITY_TO_SECTION[entity_type] || null;

    // ── View pass ────────────────────────────────────────────────────────────
    // We hook the response lifecycle rather than acting upfront because
    // `req.user` is set by the per-route authenticate middleware, which runs
    // AFTER this global middleware. By the time res.on('finish') fires, the
    // route has executed and req.user is populated.
    if (isView) {
        res.on('finish', () => {
            if (res.statusCode >= 400) return; // don't log failed reads
            if (!req.user) return;             // unauthenticated GETs are not tracked

            const dedupeKey = `${req.user.id}:${req.path}`;
            const lastSeen = viewDedupe.get(dedupeKey) || 0;
            if (Date.now() - lastSeen < VIEW_DEDUPE_MS) return;
            viewDedupe.set(dedupeKey, Date.now());

            setImmediate(() => writeAuditRow({
                userId:      req.user.id,
                sessionId:   req.user.session_id || null,
                action:      'view',
                entityType:  entity_type,
                entityId:    entity_id,
                sectionKey,
                changes:     { path: req.path, query: req.query },
                ip:          getIp(req),
                userAgent:   req.headers['user-agent'] || null,
                durationMs:  Date.now() - startedAt,
            }));
        });
        return next();
    }

    // ── Mutation pass ────────────────────────────────────────────────────────
    // Intercept res.json so we can capture the response body for entity_id discovery.
    const originalJson = res.json.bind(res);
    res.json = function (body) {
        setImmediate(() => {
            const action = req.method === 'DELETE' ? 'delete'
                         : req.method === 'POST'   ? 'create'
                         :                            'update';

            const changes = {
                request_body: req.body,
                response_status: res.statusCode,
                entity_id_from_response: body?.id || entity_id,
            };

            writeAuditRow({
                userId:      req.user?.id || null,
                sessionId:   req.user?.session_id || null,
                action,
                entityType:  entity_type,
                entityId:    entity_id,
                sectionKey,
                changes,
                ip:          getIp(req),
                userAgent:   req.headers['user-agent'] || null,
                durationMs:  Date.now() - startedAt,
            });
        });

        return originalJson(body);
    };

    next();
};
