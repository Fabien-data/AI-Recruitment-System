/**
 * add-jobs-columns.js
 * Runs the missing column ADDs on the jobs table AS the table owner
 * (recruitment_user, after fix-jobs-ownership.js has transferred ownership).
 *
 * Env: PG_HOST, PG_USER=recruitment_user, PG_PASSWORD, PG_DATABASE=recruitment_db
 */
const { Client } = require('pg');

(async () => {
    const c = new Client({
        host: process.env.PG_HOST,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE,
        port: 5432,
        ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    const stmts = [
        `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN NOT NULL DEFAULT FALSE`,
        `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_fields_schema JSONB DEFAULT '{}'::jsonb`,
        `CREATE INDEX IF NOT EXISTS idx_jobs_is_urgent ON jobs(is_urgent) WHERE is_urgent = TRUE`,
    ];
    for (const s of stmts) {
        try {
            await c.query(s);
            console.log('OK   ', s.slice(0, 80));
        } catch (e) {
            console.log('FAIL ', s.slice(0, 80), '::', e.message.split('\n')[0]);
        }
    }
    const r = await c.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name = 'jobs' AND column_name IN ('is_urgent','required_fields_schema')
         ORDER BY column_name`
    );
    console.log('\nColumns now present:');
    if (r.rows.length === 0) console.log('  (none)');
    r.rows.forEach(row => console.log('  ' + row.column_name + ': ' + row.data_type));
    await c.end();
})().catch(e => {
    console.error('ERR', e.message);
    process.exit(1);
});
