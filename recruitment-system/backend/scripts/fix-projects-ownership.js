/**
 * fix-projects-ownership.js
 * ─────────────────────────
 * One-shot script that grants `recruitment_user` ownership of the projects
 * table so the pipeline-v2 (migration 022) industry_types ADD COLUMN +
 * backfill + GIN index can succeed on the next backend restart.
 *
 * Mirrors fix-jobs-ownership.js (2026-05-24 incident).
 *
 * The auto-migrations in src/config/migrations.js use safeAlter(), which
 * swallows "must be owner" warnings — so the failure looks silent in
 * Cloud Run logs except for the WARN line. This script runs the same
 * ALTER + the missing column/index AS postgres, then verifies.
 *
 * Connect via the Cloud SQL instance public IP — your IP must be in the
 * instance's authorized-networks list before running. After running,
 * restart the backend so the chatbot job cache rebuilds.
 *
 * Usage (PowerShell):
 *   $env:PG_HOST    = "34.173.103.124"
 *   $env:PG_USER    = "postgres"
 *   $env:PG_PASSWORD= "<from password manager>"
 *   $env:PG_DATABASE= "recruitment_db"
 *   node scripts/fix-projects-ownership.js
 *
 * Required env: PG_HOST, PG_USER (postgres), PG_PASSWORD, PG_DATABASE
 */

const { Client } = require('pg');

async function main() {
    const host = process.env.PG_HOST;
    const user = process.env.PG_USER || 'postgres';
    const password = process.env.PG_PASSWORD;
    const database = process.env.PG_DATABASE || 'recruitment_db';
    if (!host || !password) {
        console.error('Set PG_HOST and PG_PASSWORD env vars before running.');
        process.exit(1);
    }
    const client = new Client({
        host,
        user,
        password,
        database,
        port: 5432,
        ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
        // 1) Transfer ownership so future migrations from the backend
        //    user can ALTER this table without superuser intervention.
        try {
            await client.query(`ALTER TABLE projects OWNER TO recruitment_user;`);
            console.log('OK    ALTER TABLE projects OWNER TO recruitment_user');
        } catch (err) {
            console.log('WARN  projects ownership: ' + err.message.split('\n')[0]);
        }

        // 2) Apply the columns + backfill + GIN index that migration 022
        //    couldn't apply while the table was still postgres-owned.
        const stmts = [
            `ALTER TABLE projects ADD COLUMN IF NOT EXISTS industry_types JSONB DEFAULT '[]'::jsonb`,
            `UPDATE projects
                SET industry_types = jsonb_build_array(industry_type)
              WHERE (industry_types IS NULL OR industry_types = '[]'::jsonb)
                AND industry_type IS NOT NULL
                AND industry_type <> ''`,
            `CREATE INDEX IF NOT EXISTS idx_projects_industry_types ON projects USING gin (industry_types)`,
        ];
        for (const sql of stmts) {
            try {
                await client.query(sql);
                console.log('OK    ' + sql.split('\n')[0].substring(0, 100));
            } catch (err) {
                console.log('WARN  ' + sql.substring(0, 60) + ' :: ' + err.message.split('\n')[0]);
            }
        }

        // 3) Verify the column exists and at least one row was backfilled.
        const colRes = await client.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'projects' AND column_name = 'industry_types'
        `);
        const backfillRes = await client.query(`
            SELECT COUNT(*)::int AS filled
            FROM projects
            WHERE industry_types IS NOT NULL AND jsonb_array_length(industry_types) > 0
        `);

        console.log('\nVerification:');
        if (colRes.rows.length === 0) {
            console.log('  ❌ industry_types column still missing');
        } else {
            const row = colRes.rows[0];
            console.log(`  ✅ industry_types: ${row.data_type}  default=${row.column_default}`);
            console.log(`  ✅ rows with backfilled industry_types: ${backfillRes.rows[0].filled}`);
        }
    } finally {
        await client.end();
    }
}

main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
