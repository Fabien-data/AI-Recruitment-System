/**
 * fix-ownership-all.js
 * ────────────────────
 *
 * Sweeps ownership of EVERY public table + sequence to `recruitment_user` so
 * the Cloud Run backend (which runs as recruitment_user) can ALTER them during
 * startup migrations. Then re-applies the Migration 021 audit_logs columns +
 * indexes while still connected as the superuser.
 *
 * Background:
 *   This project has hit the same "must be owner of table X" wall four times —
 *   jobs, communications, interviews, and audit_logs — each because the table
 *   was created at some point by the `postgres` superuser, so the app user's
 *   ALTER TABLE statements fail silently (safeAlter() swallows the error and
 *   logs a WARN). The most recent symptom was a 500 on PUT
 *   /api/admin/users/:id/permissions: `column "session_id" of relation
 *   "audit_logs" does not exist`. Rather than write a 5th one-off, this script
 *   transfers ALL mismatched objects in one pass and kills the class of bug.
 *
 * Prerequisites:
 *   - Your IP is in the Cloud SQL instance's authorized networks list, OR you
 *     run this through the Cloud SQL Auth Proxy (recommended).
 *   - You know the postgres superuser password for the recruitment-db instance.
 *
 * Usage (PowerShell):
 *     $env:PG_HOST     = "34.173.103.124"      # public IP of recruitment-db
 *     $env:PG_USER     = "postgres"
 *     $env:PG_PASSWORD = "<postgres password>"
 *     $env:PG_DATABASE = "recruitment_db"
 *     $env:PG_APP_USER = "recruitment_user"    # optional, defaults to recruitment_user
 *     node scripts/fix-ownership-all.js
 *
 * After it completes, redeploy the backend so the startup migration runs again
 * and the cached "schema partial" flag in utils/audit-writer.js resets:
 *     gcloud run deploy recruitment-backend `
 *       --image gcr.io/dewan-chatbot-1234/recruitment-backend:<TAG> `
 *       --region us-central1
 *
 * Idempotent + safe to re-run: every statement is wrapped in try/catch and a
 * table already owned by the app user is simply skipped.
 */

const { Client } = require('pg');

async function main() {
    const host     = process.env.PG_HOST;
    const user     = process.env.PG_USER || 'postgres';
    const password = process.env.PG_PASSWORD;
    const database = process.env.PG_DATABASE || 'recruitment_db';
    const appUser  = process.env.PG_APP_USER || 'recruitment_user';

    if (!host || !password) {
        console.error('Set PG_HOST and PG_PASSWORD env vars before running.');
        process.exit(1);
    }

    const client = new Client({
        host, user, password, database, port: 5432,
        ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    console.log(`Connected as ${user} to ${database} on ${host}`);
    console.log(`Target owner: ${appUser}\n`);

    let transferred = 0;
    let skipped = 0;
    let failed = 0;

    try {
        // ── Step 1: transfer ownership of every public table not already owned ──
        const tables = await client.query(`
            SELECT tablename
            FROM pg_tables
            WHERE schemaname = 'public' AND tableowner <> $1
            ORDER BY tablename
        `, [appUser]);

        if (tables.rows.length === 0) {
            console.log('All public tables already owned by ' + appUser + '.');
        } else {
            console.log(`Transferring ${tables.rows.length} table(s):`);
            for (const { tablename } of tables.rows) {
                // Identifiers can't be parameterised — quote defensively.
                const ident = '"' + String(tablename).replace(/"/g, '""') + '"';
                try {
                    await client.query(`ALTER TABLE ${ident} OWNER TO ${appUser}`);
                    console.log(`  OK    ${tablename}`);
                    transferred += 1;
                } catch (err) {
                    console.log(`  WARN  ${tablename} :: ${err.message.split('\n')[0]}`);
                    failed += 1;
                }
            }
        }

        // ── Step 2: transfer ownership of every public sequence ────────────────
        // Sequences backing serial/identity columns can be separately owned and
        // bite on the same wall when a migration alters a default.
        const seqs = await client.query(`
            SELECT sequencename
            FROM pg_sequences
            WHERE schemaname = 'public' AND sequenceowner <> $1
            ORDER BY sequencename
        `, [appUser]);
        if (seqs.rows.length > 0) {
            console.log(`\nTransferring ${seqs.rows.length} sequence(s):`);
            for (const { sequencename } of seqs.rows) {
                const ident = '"' + String(sequencename).replace(/"/g, '""') + '"';
                try {
                    await client.query(`ALTER SEQUENCE ${ident} OWNER TO ${appUser}`);
                    console.log(`  OK    ${sequencename}`);
                    transferred += 1;
                } catch (err) {
                    console.log(`  WARN  ${sequencename} :: ${err.message.split('\n')[0]}`);
                    failed += 1;
                }
            }
        }

        // ── Step 3: re-apply the Migration 021 audit_logs columns + indexes ────
        // These are the ones that failed silently and caused the permissions 500.
        console.log('\nApplying audit_logs Migration 021 columns/indexes:');
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
                console.log('  OK    ' + sql.split('\n')[0].trim().substring(0, 80));
            } catch (err) {
                console.log('  WARN  ' + sql.split('\n')[0].trim().substring(0, 50) + ' :: ' + err.message.split('\n')[0]);
            }
        }

        // ── Step 4: verify the audit_logs columns now exist ────────────────────
        const r = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'audit_logs'
              AND column_name IN ('session_id', 'section_key', 'duration_ms')
            ORDER BY column_name
        `);
        console.log(`\nSummary: ${transferred} transferred, ${skipped} skipped, ${failed} failed.`);
        console.log('audit_logs verification:');
        if (r.rows.length < 3) {
            console.log(`  Only ${r.rows.length}/3 columns present — investigate the WARNs above.`);
            process.exit(1);
        }
        for (const row of r.rows) console.log(`  OK    ${row.column_name}`);
        console.log('\nDone. Redeploy the backend so it re-runs startup migrations and clears the cached schema flag.');
    } finally {
        await client.end();
    }
}

main().catch(err => {
    console.error('FAILED:', err.message);
    process.exit(1);
});
