/**
 * Quick local dev migration runner
 * Adds ad-integration columns to candidates table (and creates ad_tracking table)
 * Run: node run-migration.js
 */

require('dotenv').config();
const { query } = require('./src/config/database');

const statements = [
    // Migration 005 — candidates extras
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills TEXT`,
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years SMALLINT`,
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255)`,
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(50)`,
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS chatbot_ref VARCHAR(100)`,
    `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ad_ref VARCHAR(100)`,
    `CREATE INDEX IF NOT EXISTS idx_candidates_whatsapp ON candidates(whatsapp_phone)`,
    `CREATE INDEX IF NOT EXISTS idx_candidates_ad_ref ON candidates(ad_ref)`,

    // Migration 004 — ad_tracking table
    `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,

    `CREATE TABLE IF NOT EXISTS ad_tracking (
        id            VARCHAR(36)   NOT NULL DEFAULT uuid_generate_v4()::text,
        ad_ref        VARCHAR(100)  NOT NULL,
        job_id        VARCHAR(36)   NOT NULL,
        project_id    VARCHAR(36)   NOT NULL,
        campaign_name VARCHAR(255),
        whatsapp_link TEXT          NOT NULL DEFAULT '',
        clicks        INT           NOT NULL DEFAULT 0,
        conversions   INT           NOT NULL DEFAULT 0,
        is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
        created_by    VARCHAR(36),
        created_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
        CONSTRAINT pk_ad_tracking PRIMARY KEY (id),
        CONSTRAINT uq_ad_ref      UNIQUE (ad_ref)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_ad_job     ON ad_tracking(job_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ad_project ON ad_tracking(project_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ad_active  ON ad_tracking(is_active)`,
];

async function runMigrations() {
    console.log('🔄 Running local dev migrations...\n');
    let passed = 0;
    let failed = 0;

    for (const sql of statements) {
        const label = sql.slice(0, 70).replace(/\s+/g, ' ') + '...';
        try {
            await query(sql, []);
            console.log(`  ✅ ${label}`);
            passed++;
        } catch (err) {
            // "already exists" errors are fine
            if (err.message && (
                err.message.includes('already exists') ||
                err.message.includes('duplicate column')
            )) {
                console.log(`  ⏭️  Already exists: ${label}`);
                passed++;
            } else {
                console.error(`  ❌ FAILED: ${label}`);
                console.error(`     Error: ${err.message}`);
                failed++;
            }
        }
    }

    console.log(`\n✅ ${passed} statements succeeded, ❌ ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runMigrations().catch(err => {
    console.error('Migration runner crashed:', err);
    process.exit(1);
});
