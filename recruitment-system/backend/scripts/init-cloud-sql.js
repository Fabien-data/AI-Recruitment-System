/**
 * One-time Cloud SQL initialization script
 * Run this once to set up the schema and permissions.
 * After running, revoke public IP access for security.
 *
 * Usage:
 *   node scripts/init-cloud-sql.js
 */

require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const CLOUD_SQL_PUBLIC_IP = process.env.CLOUD_SQL_PUBLIC_IP || '34.173.103.124';
const DB_NAME = 'recruitment_db';
const POSTGRES_PASSWORD = process.env.CLOUD_SQL_POSTGRES_PASSWORD || 'DeWanRecruit2024!';
const APP_USER = 'recruitment_user';

/**
 * Dollar-quote–aware SQL statement splitter.
 * Handles PL/pgSQL functions containing semicolons inside $$ ... $$.
 */
function splitSqlStatements(sql) {
    const statements = [];
    let current = '';
    let inDollarQuote = false;
    let dollarQuoteTag = '';
    let i = 0;
    while (i < sql.length) {
        if (!inDollarQuote) {
            const dollarMatch = sql.slice(i).match(/^\$([^$\s]*)\$/);
            if (dollarMatch) {
                dollarQuoteTag = dollarMatch[0];
                inDollarQuote = true;
                current += dollarMatch[0];
                i += dollarMatch[0].length;
                continue;
            }
            if (sql[i] === ';') {
                const stmt = current.trim();
                if (stmt) statements.push(stmt);
                current = '';
                i++;
                continue;
            }
        } else {
            if (sql.slice(i).startsWith(dollarQuoteTag)) {
                current += dollarQuoteTag;
                i += dollarQuoteTag.length;
                inDollarQuote = false;
                dollarQuoteTag = '';
                continue;
            }
        }
        current += sql[i];
        i++;
    }
    const last = current.trim();
    if (last) statements.push(last);
    return statements.filter(s =>
        s.replace(/--[^\n]*/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0
    );
}

async function runStatement(client, sql, label) {
    try {
        await client.query(sql + ';');
        return 'ok';
    } catch (err) {
        const msg = err.message.split('\n')[0];
        if (msg.includes('already exists') || msg.includes('duplicate')) return 'skip';
        console.warn(`   ⚠️  ${(label || sql.slice(0, 70).replace(/\n/g, ' '))}…\n      → ${msg}`);
        return 'warn';
    }
}

async function run() {
    console.log(`\n🔌 Connecting to Cloud SQL at ${CLOUD_SQL_PUBLIC_IP}...`);
    const superClient = new Client({
        host: CLOUD_SQL_PUBLIC_IP, port: 5432, database: 'postgres',
        user: 'postgres', password: POSTGRES_PASSWORD,
        ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
    });
    await superClient.connect();
    console.log('✅ Connected as postgres superuser');

    console.log(`\n🔑 Granting DB-level privileges to ${APP_USER}...`);
    await superClient.query(`GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${APP_USER};`);
    await superClient.end();
    console.log('✅ Done');

    const client = new Client({
        host: CLOUD_SQL_PUBLIC_IP, port: 5432, database: DB_NAME,
        user: 'postgres', password: POSTGRES_PASSWORD,
        ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
    });
    await client.connect();
    console.log(`\n📦 Connected to ${DB_NAME}`);

    await client.query(`
        GRANT ALL ON SCHEMA public TO ${APP_USER};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${APP_USER};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${APP_USER};
    `);

    // Enable extensions FIRST (uuid_generate_v4 must exist before table creation)
    console.log('\n🔧 Enabling extensions...');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pg_trgm";');
    console.log('✅ uuid-ossp + pg_trgm enabled');

    const schemaPath = path.join(__dirname, '../../database/schema.sql');
    if (!fs.existsSync(schemaPath)) { console.error('❌ schema.sql not found'); process.exit(1); }

    console.log(`\n📄 Parsing ${schemaPath}`);
    const allStmts = splitSqlStatements(fs.readFileSync(schemaPath, 'utf8'));
    console.log(`   ${allStmts.length} statements found`);

    const isExt     = s => /CREATE\s+EXTENSION/i.test(s);
    const isUsers   = s => /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["']?users["']?\b/i.test(s);

    const ordered = [
        ...allStmts.filter(isExt),
        ...allStmts.filter(isUsers),
        ...allStmts.filter(s => !isExt(s) && !isUsers(s)),
    ];

    let ok = 0, skipped = 0, warned = 0;
    for (const s of ordered) {
        const r = await runStatement(client, s);
        if (r === 'ok') ok++; else if (r === 'skip') skipped++; else warned++;
    }
    console.log(`\n✅ Schema: ${ok} created, ${skipped} already existed, ${warned} warnings`);

    const { rows } = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;`
    );
    console.log(`\n📋 Tables (${rows.length}): ${rows.map(r => r.tablename).join(', ')}`);

    await client.end();
    console.log('\n🎉 Cloud SQL initialization complete!');
    console.log('\n⚠️  SECURITY — remove the public IP whitelist when done:');
    console.log('   gcloud sql instances patch recruitment-db --project=dewan-chatbot-1234 --clear-authorized-networks\n');
}

run().catch(err => { console.error('\n❌ Failed:', err.message); process.exit(1); });
