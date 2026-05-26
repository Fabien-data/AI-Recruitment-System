/**
 * Knowledge Base Documents API
 * =============================
 * Recruiters upload PDF / DOCX / TXT files. On upload we:
 *   1. Parse the file to text (pdf-parse / mammoth / utf8).
 *   2. Chunk the text on paragraph/sentence boundaries.
 *   3. Insert one knowledge_documents row + one knowledge_document_chunks row
 *      per chunk inside a single transaction.
 *   4. Enqueue each chunk to the chatbot via the existing outbox so the bot
 *      can retrieve it alongside FAQ entries.
 *
 * The original file binary is NOT persisted — the chunks ARE the knowledge.
 * (Storage of the source file can be added later via GCS if needed.)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { authenticate, authorize } = require('../middleware/auth');
const { pool, withTransaction, generateUUID } = require('../config/database');
const chatbotOutbox = require('../services/chatbot-outbox');
const { buildKbDocChunkPayload } = require('../services/chatbot-payloads');
const logger = require('../utils/logger');

router.use(authenticate);

const MAX_FILE_BYTES = 10 * 1024 * 1024;       // 10 MB
const CHUNK_CHAR_TARGET = 2000;                 // ~500 tokens
const CHUNK_CHAR_OVERLAP = 200;                 // ~50 tokens of overlap
const ALLOWED_MIME = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'text/plain',
]);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype) || /\.(pdf|docx|txt)$/i.test(file.originalname || '')) {
            return cb(null, true);
        }
        cb(new Error('Only PDF, DOCX, or TXT files are accepted'));
    },
});

// ── Text extraction ─────────────────────────────────────────────────────────
async function extractText(buffer, mimeType, originalName) {
    const lower = (originalName || '').toLowerCase();
    if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
        const result = await pdfParse(buffer);
        return result.text || '';
    }
    if (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        || lower.endsWith('.docx')
    ) {
        const result = await mammoth.extractRawText({ buffer });
        return result.value || '';
    }
    // Fallback: treat as utf-8 text
    return buffer.toString('utf8');
}

// ── Chunking ────────────────────────────────────────────────────────────────
function _normalizeWhitespace(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[\t ]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function chunkText(text) {
    const cleaned = _normalizeWhitespace(text);
    if (!cleaned) return [];

    // Split on paragraph breaks first; if a paragraph is huge, fall through to sentence split.
    const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

    const chunks = [];
    let current = '';

    const flush = () => {
        const trimmed = current.trim();
        if (trimmed) chunks.push(trimmed);
        current = '';
    };

    const startNextWithOverlap = (chunkSource) => {
        if (CHUNK_CHAR_OVERLAP <= 0) return '';
        const tail = chunkSource.slice(Math.max(0, chunkSource.length - CHUNK_CHAR_OVERLAP));
        // Snap overlap to the next sentence/word boundary so we don't start mid-word.
        const snap = tail.search(/[.!?]\s|\n/);
        return snap >= 0 ? tail.slice(snap + 1).trimStart() : tail;
    };

    for (const para of paragraphs) {
        // If a paragraph alone exceeds the target, sentence-split it.
        if (para.length > CHUNK_CHAR_TARGET) {
            const sentences = para.split(/(?<=[.!?])\s+/);
            for (const s of sentences) {
                if (current.length + s.length + 1 > CHUNK_CHAR_TARGET && current.length > 0) {
                    const previous = current;
                    flush();
                    current = startNextWithOverlap(previous);
                }
                current += (current ? ' ' : '') + s;
            }
            continue;
        }

        if (current.length + para.length + 2 > CHUNK_CHAR_TARGET && current.length > 0) {
            const previous = current;
            flush();
            current = startNextWithOverlap(previous);
        }
        current += (current ? '\n\n' : '') + para;
    }
    flush();

    return chunks;
}

function approxTokens(text) {
    // Rough — 1 token ≈ 4 chars for English. Good enough for usage reporting.
    return Math.max(1, Math.round((text || '').length / 4));
}

// ── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/knowledge-documents
 * List with pagination and optional category filter
 */
router.get('/', async (req, res, next) => {
    try {
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
        const offset = (page - 1) * limit;
        const { category, status } = req.query;

        const where = [];
        const params = [];
        if (category) { params.push(category); where.push(`category = $${params.length}`); }
        if (status)   { params.push(status);   where.push(`status = $${params.length}`); }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

        params.push(limit, offset);
        const result = await pool.query(
            `SELECT id, title, original_filename, mime_type, file_size_bytes, category, status,
                    parse_error, chunk_count, uploaded_by, uploaded_at, updated_at
             FROM knowledge_documents
             ${whereSql}
             ORDER BY uploaded_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total FROM knowledge_documents ${whereSql}`,
            params.slice(0, params.length - 2)
        );
        const total = countResult.rows[0]?.total || 0;

        res.json({
            data: result.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.max(Math.ceil(total / limit), 1),
            },
        });
    } catch (err) { next(err); }
});

/**
 * POST /api/knowledge-documents
 * Upload a single document. Form field: file. Optional fields: title, category.
 */
router.post('/', authorize('admin', 'sourcing_department'), upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded (form field "file")' });
        }
        const { originalname, mimetype, size, buffer } = req.file;
        const title = String(req.body.title || originalname || 'Untitled').trim().slice(0, 255);
        const category = String(req.body.category || 'general').trim().slice(0, 100);

        const docId = generateUUID();
        // Insert as pending first so a failure surfaces in the dashboard, not just logs.
        await pool.query(
            `INSERT INTO knowledge_documents
                (id, title, original_filename, mime_type, file_size_bytes, category, status, uploaded_by)
             VALUES ($1, $2, $3, $4, $5, $6, 'processing', $7)`,
            [docId, title, originalname, mimetype, size, category, req.user?.id || null]
        );

        let text = '';
        try {
            text = await extractText(buffer, mimetype, originalname);
        } catch (parseErr) {
            await pool.query(
                `UPDATE knowledge_documents SET status='failed', parse_error=$1, updated_at=NOW() WHERE id=$2`,
                [String(parseErr.message || 'Failed to parse file').slice(0, 1000), docId]
            );
            return res.status(422).json({ error: `Failed to parse ${originalname}: ${parseErr.message}` });
        }

        const chunks = chunkText(text);
        if (chunks.length === 0) {
            await pool.query(
                `UPDATE knowledge_documents SET status='failed', parse_error='No text extracted', updated_at=NOW() WHERE id=$1`,
                [docId]
            );
            return res.status(422).json({ error: 'No text could be extracted from this file' });
        }

        // Insert chunks in a transaction so a mid-insert failure doesn't leave the doc half-loaded.
        const insertedChunks = [];
        await withTransaction(async (conn) => {
            const exec = typeof conn.execute === 'function'
                ? (sql, p) => conn.execute(sql, p)
                : (sql, p) => conn.query(sql, p);

            for (let i = 0; i < chunks.length; i++) {
                const chunkId = generateUUID();
                const content = chunks[i];
                await exec(
                    `INSERT INTO knowledge_document_chunks (id, document_id, chunk_index, content, token_count)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [chunkId, docId, i, content, approxTokens(content)]
                );
                insertedChunks.push({ id: chunkId, chunk_index: i, content });
            }

            await exec(
                `UPDATE knowledge_documents SET status='parsed', chunk_count=$1, updated_at=NOW() WHERE id=$2`,
                [chunks.length, docId]
            );
        });

        // Read back the finalized doc + enqueue every chunk to the chatbot
        const finalDocResult = await pool.query(`SELECT * FROM knowledge_documents WHERE id=$1`, [docId]);
        const finalDoc = finalDocResult.rows[0];

        for (const chunk of insertedChunks) {
            try {
                await chatbotOutbox.enqueue({
                    doc_id: `kbdoc_chunk_${chunk.id}`,
                    doc_type: 'kb_doc_chunk',
                    operation: 'upsert',
                    payload: buildKbDocChunkPayload(chunk, finalDoc),
                });
            } catch (enqueueErr) {
                logger.warn(`KB chunk outbox enqueue failed for ${chunk.id}: ${enqueueErr.message}`);
            }
        }

        res.status(201).json(finalDoc);
    } catch (err) {
        // multer errors land here with `code` set
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: `File exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB limit` });
        }
        if (err.message && /Only PDF, DOCX, or TXT/.test(err.message)) {
            return res.status(415).json({ error: err.message });
        }
        next(err);
    }
});

/**
 * GET /api/knowledge-documents/:id/chunks
 * Inspect the parsed chunks for a document (debug + preview)
 */
router.get('/:id/chunks', async (req, res, next) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id, chunk_index, content, token_count
             FROM knowledge_document_chunks
             WHERE document_id = $1
             ORDER BY chunk_index`,
            [id]
        );
        res.json({ data: result.rows });
    } catch (err) { next(err); }
});

/**
 * GET /api/knowledge-documents/search?q=&limit=
 * Full-text search across chunks. Returns top-K chunks ranked by ts_rank.
 * The chatbot calls this directly when it wants document-level knowledge in
 * addition to the FAQ vector results.
 */
router.get('/search', async (req, res, next) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 20);

        const result = await pool.query(
            `SELECT
                c.id            AS chunk_id,
                c.content       AS content,
                c.chunk_index   AS chunk_index,
                d.id            AS document_id,
                d.title         AS document_title,
                d.category      AS document_category,
                ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', $1)) AS rank
             FROM knowledge_document_chunks c
             JOIN knowledge_documents d ON c.document_id = d.id
             WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', $1)
               AND d.status = 'parsed'
             ORDER BY rank DESC, c.chunk_index ASC
             LIMIT $2`,
            [q, limit]
        );
        res.json({ data: result.rows });
    } catch (err) { next(err); }
});

/**
 * DELETE /api/knowledge-documents/:id
 * Cascade deletes chunks via FK ON DELETE CASCADE, and enqueues chatbot deletes
 * for every chunk so the bot stops returning them.
 */
router.delete('/:id', authorize('admin', 'sourcing_department'), async (req, res, next) => {
    try {
        const { id } = req.params;

        const docResult = await pool.query(`SELECT id FROM knowledge_documents WHERE id=$1`, [id]);
        if (docResult.rows.length === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }

        const chunksResult = await pool.query(
            `SELECT id FROM knowledge_document_chunks WHERE document_id=$1`,
            [id]
        );
        const chunkIds = chunksResult.rows.map((r) => r.id);

        // Cascade delete via FK
        await pool.query(`DELETE FROM knowledge_documents WHERE id=$1`, [id]);

        // Best-effort enqueue chatbot deletes
        for (const chunkId of chunkIds) {
            try {
                await chatbotOutbox.enqueue({
                    doc_id: `kbdoc_chunk_${chunkId}`,
                    doc_type: 'kb_doc_chunk',
                    operation: 'delete',
                    payload: { doc_id: `kbdoc_chunk_${chunkId}` },
                });
            } catch (enqueueErr) {
                logger.warn(`KB chunk delete enqueue failed for ${chunkId}: ${enqueueErr.message}`);
            }
        }

        res.json({ success: true, document_id: id, chunks_deleted: chunkIds.length });
    } catch (err) { next(err); }
});

module.exports = router;
