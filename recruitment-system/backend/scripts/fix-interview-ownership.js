/**
 * fix-interview-ownership.js
 * ──────────────────────────
 *
 * One-shot script that grants `recruitment_user` ownership of the
 * interview_schedules table and adds the `description` column (migration 023),
 * which the Cloud Run backend can't add itself because the table is owned by
 * the `postgres` superuser ("must be owner of table interview_schedules").
 *
 * The app degrades gracefully without this (the description still rides the
 * WhatsApp invite), but running this enables persisting it on the row.
 *
 * Prerequisites:
 *   - Your IP is authorized on the Cloud SQL instance (or use Cloud SQL Auth Proxy).
 *   - You know the postgres superuser password for the recruitment-db instance.
 *
 * Usage (PowerShell):
 *     $env:PG_HOST     = "<public IP of recruitment-db>"
 *     $env:PG_USER     = "postgres"
 *     $env:PG_PASSWORD = "<postgres password>"
 *     $env:PG_DATABASE = "recruitment_db"
 *     node scripts/fix-interview-ownership.js
 *
 * No backend restart is required — the next schedule re-checks the column.
 */

const { Client } = require('pg');

async function main() {
    const host     = process.env.PG_HOST;
    const user     = process.env.PG_USER || 'postgres';
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
        // Order matters: Cloud SQL's `postgres` is cloudsqlsuperuser (not a true
        // superuser), so we must ADD the column WHILE postgres still owns the
        // table, THEN transfer ownership — doing it the other way fails the
        // ADD with "must be owner" (see cloud-sql-table-ownership notes).
        const statements = [
            `ALTER TABLE interview_schedules ADD COLUMN IF NOT EXISTS description TEXT`,
            `ALTER TABLE interview_schedules OWNER TO recruitment_user`,
        ];
        for (const sql of statements) {
            try {
                await client.query(sql);
                console.log('OK    ' + sql);
            } catch (err) {
                console.log('WARN  ' + sql + ' :: ' + err.message.split('\n')[0]);
            }
        }

        const r = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'interview_schedules' AND column_name = 'description'
        `);
        console.log('\nVerification:');
        if (r.rows.length === 0) {
            console.log('  description still missing — investigate the WARNs above');
            process.exit(1);
        }
        console.log(`  description ${r.rows[0].data_type}`);
        console.log('\nDone. Interview descriptions will now persist on the row.');
    } finally {
        await client.end();
    }
}

main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
