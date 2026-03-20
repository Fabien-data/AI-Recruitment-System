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
const { resolveCvAccessUrl } = require('../src/utils/cv-url');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            out[key] = true;
            continue;
        }
        out[key] = next;
        i += 1;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const limit = args.limit ? Number(args.limit) : 200;
const strict = Boolean(args.strict);

if (!Number.isFinite(limit) || limit <= 0) {
    console.error('❌ --limit must be a positive number');
    process.exit(1);
}

async function getRecentChatbotCandidates(maxRows) {
    if (isMySQL) {
        return db.query(
            `SELECT id, name, source, status, created_at
             FROM candidates
             WHERE source IN ('whatsapp', 'chatbot')
             ORDER BY created_at DESC
             LIMIT ?`,
            [Math.floor(maxRows)]
        );
    }

    return db.query(
        `SELECT id, name, source, status, created_at
         FROM candidates
         WHERE source IN ('whatsapp', 'chatbot')
         ORDER BY created_at DESC
         LIMIT $1`,
        [Math.floor(maxRows)]
    );
}

async function getCandidateCvs(candidateId) {
    if (isMySQL) {
        return db.query(
            `SELECT id, candidate_id, file_url, file_name, uploaded_at
             FROM cv_files
             WHERE candidate_id = ?
             ORDER BY uploaded_at DESC`,
            [candidateId]
        );
    }

    return db.query(
        `SELECT id, candidate_id, file_url, file_name, uploaded_at
         FROM cv_files
         WHERE candidate_id = $1
         ORDER BY uploaded_at DESC`,
        [candidateId]
    );
}

async function getCandidateApplications(candidateId) {
    if (isMySQL) {
        return db.query('SELECT id FROM applications WHERE candidate_id = ?', [candidateId]);
    }
    return db.query('SELECT id FROM applications WHERE candidate_id = $1', [candidateId]);
}

async function main() {
    console.log('🔍 Chatbot Integration Verification');
    console.log(`   env file: ${loadedEnvPath || 'not found'}`);
    console.log(`   db: ${isMySQL ? 'MySQL' : 'PostgreSQL'}`);
    console.log(`   strict mode: ${strict ? 'yes' : 'no'}`);

    const candidateResult = await getRecentChatbotCandidates(limit);
    const candidates = candidateResult.rows || [];

    if (candidates.length === 0) {
        console.log('ℹ️ No chatbot candidates found in the selected range.');
        return;
    }

    const issues = {
        noCv: [],
        unresolvedCv: [],
        noApplication: [],
    };

    for (const candidate of candidates) {
        const cvsResult = await getCandidateCvs(candidate.id);
        const cvs = cvsResult.rows || [];
        if (cvs.length === 0) {
            issues.noCv.push({ candidate_id: candidate.id, name: candidate.name });
            continue;
        }

        const bestCv = cvs[0];
        const resolved = resolveCvAccessUrl(bestCv);
        if (!resolved.url) {
            issues.unresolvedCv.push({
                candidate_id: candidate.id,
                name: candidate.name,
                cv_id: bestCv.id,
                file_url: bestCv.file_url,
                file_name: bestCv.file_name,
                status: resolved.status,
            });
        }

        const appResult = await getCandidateApplications(candidate.id);
        if ((appResult.rows || []).length === 0 && candidate.status !== 'future_pool') {
            issues.noApplication.push({
                candidate_id: candidate.id,
                name: candidate.name,
                status: candidate.status,
            });
        }
    }

    console.log('\n📊 Summary');
    console.log(`   candidates checked: ${candidates.length}`);
    console.log(`   no CV records: ${issues.noCv.length}`);
    console.log(`   unresolved CV URLs: ${issues.unresolvedCv.length}`);
    console.log(`   no application (excluding future_pool): ${issues.noApplication.length}`);

    if (issues.noCv.length > 0) {
        console.log('\n⚠️ Candidates with no CV record (first 20)');
        console.table(issues.noCv.slice(0, 20));
    }
    if (issues.unresolvedCv.length > 0) {
        console.log('\n⚠️ Candidates with unresolved CV URLs (first 20)');
        console.table(issues.unresolvedCv.slice(0, 20));
    }
    if (issues.noApplication.length > 0) {
        console.log('\n⚠️ Candidates with no application (first 20)');
        console.table(issues.noApplication.slice(0, 20));
    }

    const totalIssues = issues.noCv.length + issues.unresolvedCv.length + issues.noApplication.length;
    if (strict && totalIssues > 0) {
        console.error(`\n❌ Strict mode failed with ${totalIssues} issue(s).`);
        process.exitCode = 2;
        return;
    }

    console.log('\n✅ Verification completed.');
}

main()
    .catch((err) => {
        console.error('❌ Verification failed:', err.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            if (db.pool && typeof db.pool.end === 'function') {
                await db.pool.end();
            }
        } catch (_) {}
    });