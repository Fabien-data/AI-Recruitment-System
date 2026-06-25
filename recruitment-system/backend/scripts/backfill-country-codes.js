#!/usr/bin/env node
/**
 * Backfill jobs.country_code for legacy rows.
 *
 * country_code was added (migration 020) without backfilling existing jobs, so
 * rows created before it have country_code = NULL. The Jobs page filters with
 * `j.country_code = $n`, so those jobs silently vanish when a country filter is
 * applied — i.e. "can't filter by country" (B005). This maps each NULL-code row
 * with a non-null country through the same resolveCountry() the create/update
 * paths use, and writes the ISO code back.
 *
 * Dry run by default; pass --apply to write.
 *   node scripts/backfill-country-codes.js            # preview
 *   node scripts/backfill-country-codes.js --apply    # write
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

function loadEnv() {
    const candidates = [
        path.resolve(__dirname, '../.env'),
        path.resolve(__dirname, '../../.env'),
    ];
    for (const envPath of candidates) {
        if (fs.existsSync(envPath)) {
            dotenv.config({ path: envPath });
            return envPath;
        }
    }
    return null;
}

const loadedEnvPath = loadEnv();

const db = require('../src/config/database');
const { isMySQL } = require('../src/utils/query-adapter');
const { resolveCountry } = require('../src/utils/countries');

const args = process.argv.slice(2);
const dryRun = !args.includes('--apply');

async function main() {
    console.log('🔎 country_code backfill scan started');
    console.log(`   env file: ${loadedEnvPath || 'not found'}`);
    console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
    console.log(`   DB: ${isMySQL ? 'MySQL' : 'PostgreSQL'}`);

    const result = await db.query(
        `SELECT id, title, country, country_code
         FROM jobs
         WHERE (country_code IS NULL OR country_code = '')
           AND country IS NOT NULL AND country <> ''`
    );
    const rows = result.rows || [];

    if (rows.length === 0) {
        console.log('✅ No jobs with a country but a missing country_code.');
        return;
    }

    const updates = [];
    const unresolved = [];
    for (const row of rows) {
        const geo = resolveCountry({ name: row.country });
        if (geo.country_code) {
            updates.push({ id: row.id, title: row.title, country: row.country, country_code: geo.country_code });
        } else {
            unresolved.push({ id: row.id, title: row.title, country: row.country });
        }
    }

    console.log(`\n📊 Summary`);
    console.log(`   Missing country_code: ${rows.length}`);
    console.log(`   Resolvable: ${updates.length}`);
    console.log(`   Unresolved (country not in ISO list): ${unresolved.length}`);

    if (updates.length > 0) {
        console.log('\n🧪 Preview (first 20):');
        console.table(updates.slice(0, 20));
    }
    if (unresolved.length > 0) {
        console.log('\n⚠️ Unresolved (first 20) — review country spelling:');
        console.table(unresolved.slice(0, 20));
    }

    if (dryRun) {
        console.log('\nℹ️ Dry run only. Re-run with --apply to write changes.');
        return;
    }

    let updated = 0;
    for (const u of updates) {
        if (isMySQL) {
            await db.query('UPDATE jobs SET country_code = ? WHERE id = ?', [u.country_code, u.id]);
        } else {
            await db.query('UPDATE jobs SET country_code = $1 WHERE id = $2', [u.country_code, u.id]);
        }
        updated += 1;
    }
    console.log(`\n✅ Backfill complete. Updated ${updated} job(s).`);
}

main()
    .catch((error) => {
        console.error('❌ Backfill failed:', error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            if (db.pool && typeof db.pool.end === 'function') {
                await db.pool.end();
            }
        } catch (_) {}
    });
