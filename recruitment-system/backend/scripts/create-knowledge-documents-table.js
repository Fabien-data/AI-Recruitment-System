/**
 * create-knowledge-documents-table.js
 * ────────────────────────────────────
 * Idempotent. Creates the knowledge_documents + knowledge_document_chunks tables.
 * Safe to re-run. Connects via the same Cloud SQL Unix socket the backend container uses.
 *
 * Why this exists: matches the pattern of create-knowledge-base-table.js so the
 * tables can be provisioned manually if applyMigrations() silently fails on
 * Cloud SQL (e.g. when a CREATE TABLE rolls back due to an unrelated ALTER on a
 * table the runtime user doesn't own).
 *
 * Run as a Cloud Run Job using the backend image:
 *   gcloud run jobs deploy create-kbdocs-table \
 *     --image <backend-image> --command node \
 *     --args scripts/create-knowledge-documents-table.js \
 *     --set-cloudsql-instances dewan-chatbot-1234:us-central1:recruitment-db \
 *     --env-vars-file backend_env.yaml --execute-now --wait
 */
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    user: process.env.CLOUD_SQL_USER,
    password: process.env.CLOUD_SQL_PASSWORD,
    database: process.env.CLOUD_SQL_DATABASE,
    host: '/cloudsql/' + process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME,
    ssl: false,
  });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           UUID,
        title               TEXT         NOT NULL,
        original_filename   TEXT         NOT NULL,
        mime_type           TEXT         NOT NULL,
        file_size_bytes     BIGINT       NOT NULL,
        storage_url         TEXT,
        category            VARCHAR(100) NOT NULL DEFAULT 'general',
        status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
        parse_error         TEXT,
        chunk_count         INT          NOT NULL DEFAULT 0,
        uploaded_by         UUID,
        uploaded_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kbdoc_status   ON knowledge_documents(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kbdoc_category ON knowledge_documents(category)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_document_chunks (
        id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id  UUID         NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        chunk_index  INT          NOT NULL,
        content      TEXT         NOT NULL,
        token_count  INT,
        keywords     JSONB        DEFAULT '[]'::jsonb,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_kbchunk_document ON knowledge_document_chunks(document_id)`);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_kbchunk_content_fts
        ON knowledge_document_chunks USING gin(to_tsvector('english', content))
    `);

    console.log('OK: knowledge_documents + knowledge_document_chunks ready');
    const r = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('knowledge_documents','knowledge_document_chunks') ORDER BY table_name"
    );
    console.log('VERIFY:', JSON.stringify(r.rows));
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
