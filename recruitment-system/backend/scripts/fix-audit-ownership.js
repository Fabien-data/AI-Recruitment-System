/**
 * fix-audit-ownership.js
 * ──────────────────────
 *
 * One-shot script that grants `recruitment_user` ownership of the audit_logs
 * table so Migration 021's ALTER TABLE statements can succeed.
 *
 * Background:
 *   audit_logs was created at some point by the `postgres` superuser, so when
 *   the Cloud Run backend (running as recruitment_user) tries to ALTER TABLE
 *   audit_logs ADD COLUMN session_id ... the statement fails silently with
 *   "must be owner of table audit_logs". This script connects AS postgres,
 *   transfers ownership, then runs the three column-add statements.
 *
 * Prerequisites:
 *   - Your IP is in the Cloud SQL instance's authorized networks list (or you
 *     run this through Cloud SQL Auth Proxy).
 *   - You know the postgres superuser password for the recruitment-db instance.
 *
 * Usage:
 *     # Set env vars (substitute real values):
 *     $env:PG_HOST     = "34.173.103.124"          # public IP of recruitment-db
 *     $env:PG_USER     = "postgres"
 *     $env:PG_PASSWORD = "<postgres password>"
 *     $env:PG_DATABASE = "recruitment_db"
 *
 *     node scripts/fix-audit-ownership.js
 *
 * After this completes successfully, restart the Cloud Run backend so the
 * startup migration runs again and applies the indexes (which were also
 * blocked by the ownership issue):
 *
 *     gcloud run deploy recruitment-backend `
 *       --image gcr.io/dewan-chatbot-1234/recruitment-backend `
 *       --region us-central1 `
 *       --env-vars-file backend_env.yaml
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
        // Step 1: transfer ownership of audit_logs to recruitment_user.
        try {
            await client.query(`ALTER TABLE audit_logs OWNER TO recruitment_user;`);
            console.log('OK    ALTER TABLE audit_logs OWNER TO recruitment_user');
        } catch (err) {
            console.log(`WARN  ${err.message.split('\n')[0]}`);
        }

        // Step 2: apply the missing column additions while we're still
        // connected as postgres — saves a backend restart roundtrip.
        const statements = [
            `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS session_id  UUID`,
            `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS section_key VARCHAR(40)`,
            `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER`,
            `CREATE INDEX IF NOT EXISTS idx_audit_session
               ON audit_logs(session_id) WHERE session_id IS NOT NULL`,
            `CREATE INDEX IF NOT EXISTS idx_audit_user_section_date
               ON audit_logs(user_id, section_key, created_at DESC)`,
        ];

        for (const sql of statements) {
            try {
                await client.query(sql);
                console.log('OK    ' + sql.split('\n')[0].substring(0, 90));
            } catch (err) {
                console.log('WARN  ' + sql.split('\n')[0].substring(0, 60) + ' :: ' + err.message.split('\n')[0]);
            }
        }

        // Step 3: verify the columns now exist.
        const r = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'audit_logs'
              AND column_name IN ('session_id', 'section_key', 'duration_ms')
            ORDER BY column_name
        `);
        console.log('\nVerification:');
        if (r.rows.length === 0) {
            console.log('  (still missing — investigate the WARNs above)');
            process.exit(1);
        }
        for (const row of r.rows) {
            console.log(`  ${row.column_name.padEnd(12)} ${row.data_type}`);
        }
        console.log('\nDone. Redeploy the backend to clear the cached "schema partial" flag.');
    } finally {
        await client.end();
    }
}

main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
