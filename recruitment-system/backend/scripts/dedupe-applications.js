/**
 * dedupe-applications.js
 * ──────────────────────
 *
 * One-shot fallback for Migration 024. Deletes duplicate (candidate_id, job_id)
 * application rows, keeping the single furthest-along application per pair, then
 * (re)creates the unique index. The startup migration does the same thing, but
 * on prod the `applications` table may be owned by the `postgres` superuser, so
 * the in-app DELETE can be rejected with "must be owner". Run this with the
 * owner role to clean up legacy duplicates.
 *
 * Idempotent: a clean table deletes 0 rows.
 *
 * Prerequisites:
 *   - Your IP is authorized on the Cloud SQL instance (or use Cloud SQL Auth Proxy).
 *   - You know a role that owns/can delete from `applications` (e.g. postgres).
 *
 * Usage (PowerShell):
 *     $env:PG_HOST     = "<public IP of recruitment-db>"
 *     $env:PG_USER     = "postgres"
 *     $env:PG_PASSWORD = "<postgres password>"
 *     $env:PG_DATABASE = "recruitment_db"
 *     node scripts/dedupe-applications.js
 */

const { Client } = require('pg');

const DEDUPE_SQL = `
DELETE FROM applications a
 USING (
   SELECT id, ROW_NUMBER() OVER (
     PARTITION BY candidate_id, job_id
     ORDER BY CASE status
       WHEN 'placed'              THEN 8
       WHEN 'selected'            THEN 7
       WHEN 'interview_scheduled' THEN 6
       WHEN 'interviewed'         THEN 6
       WHEN 'pre_screened'        THEN 5
       WHEN 'certified'           THEN 4
       WHEN 'screening'           THEN 3
       WHEN 'reviewing'           THEN 2
       WHEN 'auto_assigned'       THEN 2
       WHEN 'applied'             THEN 2
       ELSE 1
     END DESC, applied_at ASC
   ) AS rn
   FROM applications
 ) d
 WHERE a.id = d.id AND d.rn > 1
`;

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
        host, user, password, database, port: 5432,
        ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    console.log(`Connected as ${user} to ${database} on ${host}\n`);

    try {
        const before = await client.query('SELECT COUNT(*)::int AS n FROM applications');
        const del = await client.query(DEDUPE_SQL);
        console.log(`Deleted ${del.rowCount} duplicate application row(s).`);

        try {
            await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_unique ON applications(candidate_id, job_id)');
            console.log('OK    unique index idx_applications_unique present');
        } catch (idxErr) {
            console.log('WARN  could not create unique index :: ' + idxErr.message.split('\n')[0]);
        }

        const after = await client.query('SELECT COUNT(*)::int AS n FROM applications');
        console.log(`\nApplications: ${before.rows[0].n} → ${after.rows[0].n}`);
        console.log('Done.');
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
