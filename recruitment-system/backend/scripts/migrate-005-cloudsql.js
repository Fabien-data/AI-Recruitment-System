/**
 * Migration 005 – Add chatbot columns to candidates table
 * =========================================================
 * Run once against Cloud SQL (via Cloud Run Job or Auth Proxy).
 *
 *   node scripts/migrate-005-cloudsql.js
 *
 * Env vars required (same as production Cloud Run env):
 *   USE_CLOUD_SQL=true
 *   CLOUD_SQL_INSTANCE_CONNECTION_NAME=dewan-chatbot-1234:us-central1:recruitment-db
 *   CLOUD_SQL_USER, CLOUD_SQL_PASSWORD, CLOUD_SQL_DATABASE
 */

require('dotenv').config();
const { Pool } = require('pg');

const useCloudSQL = process.env.USE_CLOUD_SQL === 'true';
const instanceConnectionName = process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME;

let poolConfig;

if (useCloudSQL && instanceConnectionName) {
    const socketPath = `/cloudsql/${instanceConnectionName}`;
    console.log(`☁️  Connecting via Cloud SQL Unix socket: ${socketPath}`);
    poolConfig = {
        user:     process.env.CLOUD_SQL_USER,
        password: process.env.CLOUD_SQL_PASSWORD,
        database: process.env.CLOUD_SQL_DATABASE,
        host:     socketPath,
        ssl: false,
        max: 5,
        connectionTimeoutMillis: 15000,
    };
} else {
    // Local dev – Cloud SQL Auth Proxy must be running on 127.0.0.1:5432
    console.log('🔌 Connecting via local Auth Proxy (127.0.0.1:5432)');
    poolConfig = {
        host:     '127.0.0.1',
        port:     parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.CLOUD_SQL_DATABASE || process.env.DB_NAME,
        user:     process.env.CLOUD_SQL_USER     || process.env.DB_USER,
        password: process.env.CLOUD_SQL_PASSWORD || process.env.DB_PASSWORD,
        ssl: false,
        max: 5,
        connectionTimeoutMillis: 15000,
    };
}

const pool = new Pool(poolConfig);

async function applyMigration() {
    const client = await pool.connect();
    try {
        console.log('✅ Connected to database.');
        console.log('Applying migration 005: adding chatbot columns to candidates table...\n');

        const statements = [
            {
                label: 'skills column',
                sql: `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills TEXT`,
            },
            {
                label: 'experience_years column',
                sql: `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years SMALLINT`,
            },
            {
                label: 'highest_qualification column',
                sql: `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255)`,
            },
            {
                label: 'whatsapp_phone column',
                sql: `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(50)`,
            },
            {
                label: 'chatbot_ref column',
                sql: `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS chatbot_ref VARCHAR(100)`,
            },
            {
                label: 'ad_ref column',
                sql: `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ad_ref VARCHAR(100)`,
            },
            {
                label: 'idx_candidates_whatsapp index',
                sql: `CREATE INDEX IF NOT EXISTS idx_candidates_whatsapp ON candidates(whatsapp_phone)`,
            },
            {
                label: 'idx_candidates_ad_ref index',
                sql: `CREATE INDEX IF NOT EXISTS idx_candidates_ad_ref ON candidates(ad_ref)`,
            },
        ];

        for (const { label, sql } of statements) {
            try {
                await client.query(sql);
                console.log(`  ✅ ${label}`);
            } catch (err) {
                console.error(`  ❌ ${label}: ${err.message}`);
                throw err;
            }
        }

        // Verify final columns
        const { rows } = await client.query(`
            SELECT column_name, data_type, character_maximum_length
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'candidates'
            ORDER BY ordinal_position
        `);

        console.log('\nCurrent candidates table columns:');
        rows.forEach(r => {
            const maxLen = r.character_maximum_length ? `(${r.character_maximum_length})` : '';
            console.log(`  - ${r.column_name}  [${r.data_type}${maxLen}]`);
        });

        console.log('\n🎉 Migration 005 applied successfully!');
        process.exit(0);

    } catch (err) {
        console.error('\n💥 Migration failed:', err.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

applyMigration();
