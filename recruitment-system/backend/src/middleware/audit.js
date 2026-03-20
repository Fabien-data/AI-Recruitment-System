/**
 * Audit Logging Middleware
 *
 * Intercepts all mutation routes (POST / PUT / PATCH / DELETE) and writes to
 * the audit_logs table.  Skips internal/health/webhook paths.
 *
 * Usage in server.js (mount AFTER authenticate middleware):
 *   const auditMiddleware = require('./middleware/audit');
 *   app.use(auditMiddleware);
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');

const SKIP_PATHS = [
    '/health',
    '/api/auth/login',
    '/api/auth/register',
    '/webhooks',
    '/api/internal',
];

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function shouldSkip(path) {
    return SKIP_PATHS.some(skip => path.startsWith(skip));
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

module.exports = function auditMiddleware(req, res, next) {
    if (!MUTATION_METHODS.has(req.method)) return next();
    if (shouldSkip(req.path)) return next();

    // Capture original json() to intercept the response body
    const originalJson = res.json.bind(res);
    res.json = function (body) {
        // Fire-and-forget audit write
        setImmediate(async () => {
            try {
                const { entity_type, entity_id } = parseEntity(req.path);
                const userId = req.user?.id || null;
                const action = req.method === 'DELETE' ? 'delete'
                             : req.method === 'POST'   ? 'create'
                             : 'update';

                const changes = {
                    request_body: req.body,
                    response_status: res.statusCode,
                    entity_id_from_response: body?.id || entity_id
                };

                await query(
                    adaptQuery(`
                        INSERT INTO audit_logs (user_id, action, entity_type, entity_id, changes, ip_address, user_agent)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    `),
                    [
                        userId,
                        action,
                        entity_type,
                        entity_id,
                        JSON.stringify(changes),
                        getIp(req),
                        req.headers['user-agent'] || null
                    ]
                );
            } catch (err) {
                // Never let audit failure affect the response
                logger.warn('audit-middleware: write failed —', err.message);
            }
        });

        return originalJson(body);
    };

    next();
};
