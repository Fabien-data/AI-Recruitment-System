/**
 * create-knowledge-base-table.js
 * ──────────────────────────────
 * Idempotent. Creates ONLY the knowledge_base table inside production. Safe to
 * re-run. Connects via the same Cloud SQL Unix socket the backend container uses.
 *
 * Why this exists: create_ai_tables.js mixes a CREATE TABLE for knowledge_base
 * with an ALTER TABLE cv_files that recruitment_user does not own, so the whole
 * transaction rolls back and knowledge_base never gets created. This script
 * isolates the CREATE so it can succeed on its own.
 *
 * Run as a Cloud Run Job using the backend image:
 *   gcloud run jobs deploy create-kb-table \
 *     --image <backend-image> --command node \
 *     --args scripts/create-knowledge-base-table.js \
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
      CREATE TABLE IF NOT EXISTS knowledge_base (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tenant_id UUID,
        category VARCHAR(100) NOT NULL,
        question_en TEXT NOT NULL,
        question_si TEXT,
        question_ta TEXT,
        answer_en TEXT NOT NULL,
        answer_si TEXT,
        answer_ta TEXT,
        keywords JSONB DEFAULT '[]'::jsonb,
        embedding_vector JSONB,
        priority INT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        usage_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by UUID
      )
    `);
    console.log('OK: knowledge_base ready');
    const r = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='knowledge_base'"
    );
    console.log('VERIFY:', JSON.stringify(r.rows));
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
