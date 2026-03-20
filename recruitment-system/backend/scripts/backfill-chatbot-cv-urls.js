#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const dotenv = require('dotenv');

function loadEnv() {
    const candidates = [
        path.resolve(__dirname, '../.env'),
        path.resolve(__dirname, '../../.env')
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

function parseArgs(argv) {
    const parsed = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            parsed[key] = true;
            continue;
        }
        parsed[key] = next;
        i += 1;
    }
    return parsed;
}

const args = parseArgs(process.argv.slice(2));
const dryRun = !args.apply;
const checkRemote = Boolean(args['check-remote']);
const limit = args.limit ? Number(args.limit) : null;
const bucketName = String(args.bucket || process.env.GCS_BUCKET_NAME || 'dewan-recruitment-cvs').trim();
const uploadsDir = path.resolve(args['uploads-dir'] || path.join(__dirname, '../uploads/cvs'));

if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
    console.error('❌ --limit must be a positive number');
    process.exit(1);
}

function parseCandidateId(fileUrl, candidateId) {
    if (candidateId) return String(candidateId);
    const m = /^chatbot:\/\/candidate\/([a-zA-Z0-9-]+)/.exec(String(fileUrl || ''));
    return m ? m[1] : null;
}

function sanitizeFileName(fileName) {
    if (!fileName) return null;
    return path.basename(String(fileName).trim());
}

function localCandidateUrl(fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!safeName) return null;
    const absPath = path.join(uploadsDir, safeName);
    if (!fs.existsSync(absPath)) return null;
    return `/uploads/cvs/${safeName}`;
}

function gcsCandidateUrl(candidateId, fileName) {
    const safeName = sanitizeFileName(fileName);
    if (!candidateId || !safeName || !bucketName) return null;
    return `https://storage.googleapis.com/${bucketName}/cvs/${candidateId}/${safeName}`;
}

async function existsRemotely(url) {
    if (!checkRemote) return true;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeout);
        return response.ok;
    } catch (_) {
        return false;
    }
}

function buildSelectSql() {
    if (isMySQL) {
        const mysqlLimit = limit ? ` LIMIT ${Math.floor(limit)}` : '';
        return {
            sql: `SELECT id, candidate_id, file_url, file_name, uploaded_at
                  FROM cv_files
                  WHERE file_url LIKE 'chatbot://candidate/%'
                  ORDER BY uploaded_at DESC${mysqlLimit}`,
            params: []
        };
    }

    if (limit) {
        return {
            sql: `SELECT id, candidate_id, file_url, file_name, uploaded_at
                  FROM cv_files
                  WHERE file_url LIKE 'chatbot://candidate/%'
                  ORDER BY uploaded_at DESC
                  LIMIT $1`,
            params: [Math.floor(limit)]
        };
    }

    return {
        sql: `SELECT id, candidate_id, file_url, file_name, uploaded_at
              FROM cv_files
              WHERE file_url LIKE 'chatbot://candidate/%'
              ORDER BY uploaded_at DESC`,
        params: []
    };
}

async function main() {
    console.log('🔎 Backfill scan started');
    console.log(`   env file: ${loadedEnvPath || 'not found'}`);
    console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
    console.log(`   DB: ${isMySQL ? 'MySQL' : 'PostgreSQL'}`);
    console.log(`   uploads dir: ${uploadsDir}`);
    console.log(`   bucket: ${bucketName}`);
    console.log(`   check remote: ${checkRemote ? 'yes' : 'no'}`);

    const { sql, params } = buildSelectSql();
    const result = await db.query(sql, params);
    const rows = result.rows || [];

    if (rows.length === 0) {
        console.log('✅ No chatbot:// CV records found.');
        return;
    }

    const updates = [];
    const unresolved = [];

    for (const row of rows) {
        const candidateId = parseCandidateId(row.file_url, row.candidate_id);
        const fileName = sanitizeFileName(row.file_name);

        if (!fileName) {
            unresolved.push({ id: row.id, reason: 'missing file_name' });
            continue;
        }

        const localUrl = localCandidateUrl(fileName);
        if (localUrl) {
            updates.push({ id: row.id, oldUrl: row.file_url, newUrl: localUrl, strategy: 'local', fileName });
            continue;
        }

        const gcsUrl = gcsCandidateUrl(candidateId, fileName);
        if (gcsUrl && await existsRemotely(gcsUrl)) {
            updates.push({ id: row.id, oldUrl: row.file_url, newUrl: gcsUrl, strategy: 'gcs', fileName });
            continue;
        }

        unresolved.push({ id: row.id, reason: 'no local file and no resolvable remote URL', fileName });
    }

    console.log(`\n📊 Summary`);
    console.log(`   Found placeholders: ${rows.length}`);
    console.log(`   Resolvable: ${updates.length}`);
    console.log(`   Unresolved: ${unresolved.length}`);

    if (updates.length > 0) {
        console.log('\n🧪 Preview of updates (first 20):');
        console.table(updates.slice(0, 20).map(u => ({
            id: u.id,
            strategy: u.strategy,
            file_name: u.fileName,
            new_url: u.newUrl
        })));
    }

    if (unresolved.length > 0) {
        console.log('\n⚠️ Unresolved rows (first 20):');
        console.table(unresolved.slice(0, 20));
    }

    if (dryRun) {
        console.log('\nℹ️ Dry run only. Re-run with --apply to write changes.');
        return;
    }

    let updatedCount = 0;
    for (const item of updates) {
        if (isMySQL) {
            await db.query('UPDATE cv_files SET file_url = ? WHERE id = ?', [item.newUrl, item.id]);
        } else {
            await db.query('UPDATE cv_files SET file_url = $1 WHERE id = $2', [item.newUrl, item.id]);
        }
        updatedCount += 1;
    }

    console.log(`\n✅ Backfill complete. Updated ${updatedCount} row(s).`);
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