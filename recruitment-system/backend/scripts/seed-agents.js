#!/usr/bin/env node
/**
 * Seed the 5 calling-console agent accounts (IGC Marketing 1–5).
 *
 * Idempotent: skips any agent whose email already exists; creates the rest with
 * role 'project_handler' (the Messages/Communications role). Passwords are read
 * from env or default to a shared starter you should rotate after first login.
 *
 * Dry run by default; pass --apply to write.
 *   node scripts/seed-agents.js                 # preview
 *   node scripts/seed-agents.js --apply         # create the accounts
 *
 * Env overrides (optional):
 *   AGENT_EMAIL_DOMAIN   default 'igcmarketing.local'
 *   AGENT_DEFAULT_PASSWORD  default 'ChangeMe#2026'
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');

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

const args = process.argv.slice(2);
const dryRun = !args.includes('--apply');

const DOMAIN = process.env.AGENT_EMAIL_DOMAIN || 'igcmarketing.local';
const DEFAULT_PASSWORD = process.env.AGENT_DEFAULT_PASSWORD || 'ChangeMe#2026';

const AGENTS = Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    return {
        email: `igc.marketing${n}@${DOMAIN}`,
        full_name: `IGC Marketing ${n}`,
        role: 'project_handler',
    };
});

async function main() {
    console.log('👥 Seeding calling-console agent accounts');
    console.log(`   env file: ${loadedEnvPath || 'not found'}`);
    console.log(`   Mode: ${dryRun ? 'DRY RUN (no writes)' : 'APPLY'}`);
    console.log(`   Email domain: ${DOMAIN}`);

    let created = 0;
    let skipped = 0;

    for (const agent of AGENTS) {
        const existing = await db.query('SELECT id FROM users WHERE email = $1', [agent.email]);
        if (existing.rows.length > 0) {
            console.log(`   • skip  ${agent.email} (already exists)`);
            skipped += 1;
            continue;
        }
        if (dryRun) {
            console.log(`   • would create ${agent.email}  (${agent.full_name}, ${agent.role})`);
            created += 1;
            continue;
        }
        const password_hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
        await db.query(
            `INSERT INTO users (email, password_hash, full_name, role, is_active)
             VALUES ($1, $2, $3, $4, true)`,
            [agent.email, password_hash, agent.full_name, agent.role]
        );
        console.log(`   ✓ created ${agent.email}  (${agent.full_name})`);
        created += 1;
    }

    console.log('');
    console.log(`Done. ${dryRun ? 'Would create' : 'Created'}: ${created}, skipped: ${skipped}.`);
    if (!dryRun && created > 0) {
        console.log(`Default password for new accounts: "${DEFAULT_PASSWORD}" — rotate it after first login.`);
    }
    if (dryRun) {
        console.log('Re-run with --apply to create the accounts.');
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('seed-agents failed:', err.message);
        process.exit(1);
    });
