/**
 * fix-jobs-ownership.js
 * ─────────────────────
 * One-shot script that grants `recruitment_user` ownership of tables that the
 * auto-migrations couldn't ALTER because they were owned by `postgres`.
 *
 * After this runs once, the regular startup migrations in
 * src/config/migrations.js will succeed for jobs.is_urgent,
 * jobs.required_fields_schema, etc.
 *
 * Connect via the Cloud SQL instance public IP — your IP must be in the
 * instance's authorized-networks list before running.
 *
 * Usage:
 *   node scripts/fix-jobs-ownership.js
 *
 * Required env: PG_HOST, PG_USER (postgres), PG_PASSWORD, PG_DATABASE
 */

const { Client } = require('pg');

const TABLES = ['jobs', 'communications'];

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
        for (const t of TABLES) {
            try {
                await client.query(`ALTER TABLE ${t} OWNER TO recruitment_user;`);
                console.log(`OK    ALTER TABLE ${t} OWNER TO recruitment_user`);
            } catch (err) {
                console.log(`WARN  ${t}: ${err.message.split('\n')[0]}`);
            }
        }
        // Also explicitly apply the missing column additions while we're connected
        // as postgres, in case the next backend restart races.
        const colStatements = [
            `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN NOT NULL DEFAULT FALSE`,
            `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_fields_schema JSONB DEFAULT '{}'::jsonb`,
            `CREATE INDEX IF NOT EXISTS idx_jobs_is_urgent ON jobs(is_urgent) WHERE is_urgent = TRUE`,
        ];
        for (const sql of colStatements) {
            try {
                await client.query(sql);
                console.log('OK    ' + sql.split('\n')[0].substring(0, 100));
            } catch (err) {
                console.log('WARN  ' + sql.substring(0, 60) + ' :: ' + err.message.split('\n')[0]);
            }
        }
        // Verify columns now exist
        const r = await client.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'jobs' AND column_name IN ('is_urgent', 'required_fields_schema')
        `);
        console.log('\nVerification:');
        if (r.rows.length === 0) console.log('  (still missing)');
        for (const row of r.rows) {
            console.log(`  ${row.column_name}: ${row.data_type}  default=${row.column_default}`);
        }
    } finally {
        await client.end();
    }
}

main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
