/**
 * Auto-Migration Module
 * =====================
 * Applies all pending schema column additions idempotently on startup.
 * All statements use IF NOT EXISTS so they are safe to re-run.
 *
 * Called once from server.js before the HTTP server starts.
 */

const { query } = require('./database');
const logger = require('../utils/logger');

/** Run a single DDL statement and swallow "already exists" noise. */
async function safeAlter(sql, label) {
    try {
        await query(sql, []);
        logger.info(`  migration: OK  — ${label}`);
        return true;
    } catch (err) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('already exists') || msg.includes('duplicate')) {
            logger.info(`  migration: skip — ${label} (already exists)`);
            return true;
        }
        logger.warn(`  migration: WARN — ${label}: ${err.message.split('\n')[0]}`);
        return false;
    }
}

async function applyMigrations() {
    logger.info('🔄 Running startup migrations...');

    // ── Migration 004: ad_tracking table ─────────────────────────────────────
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS ad_tracking (
            id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
            ad_ref        VARCHAR(100)  NOT NULL UNIQUE,
            job_id        UUID          NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
            project_id    UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            campaign_name VARCHAR(255),
            whatsapp_link TEXT          NOT NULL,
            clicks        INT           NOT NULL DEFAULT 0,
            conversions   INT           NOT NULL DEFAULT 0,
            is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
            created_by    UUID,
            created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
    `, 'ad_tracking table');

    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_job ON ad_tracking(job_id)`, 'idx_ad_job');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_project ON ad_tracking(project_id)`, 'idx_ad_project');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_ref ON ad_tracking(ad_ref)`, 'idx_ad_ref');

    // ── Migration 005: candidates extras ─────────────────────────────────────
    const candidateCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills               TEXT`, 'candidates.skills'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years      SMALLINT`, 'candidates.experience_years'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255)`, 'candidates.highest_qualification'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_phone        VARCHAR(50)`, 'candidates.whatsapp_phone'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS chatbot_ref           VARCHAR(100)`, 'candidates.chatbot_ref'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ad_ref                VARCHAR(100)`, 'candidates.ad_ref'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_whatsapp ON candidates(whatsapp_phone)`, 'idx_candidates_whatsapp'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_ad_ref   ON candidates(ad_ref)`, 'idx_candidates_ad_ref'],
    ];

    for (const [sql, label] of candidateCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 006: applications extras ───────────────────────────────────
    const applicationCols = [
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS certification_notes  TEXT`, 'applications.certification_notes'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS transferred_from_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL`, 'applications.transferred_from_job_id'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS transfer_reason      TEXT`, 'applications.transfer_reason'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW()`, 'applications.updated_at'],
        [`CREATE INDEX IF NOT EXISTS idx_app_transferred ON applications(transferred_from_job_id)`, 'idx_app_transferred'],
    ];

    for (const [sql, label] of applicationCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 007: duplicate detection support ────────────────────────────
    await safeAlter(
        `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES candidates(id) ON DELETE SET NULL`,
        'candidates.merged_into_id'
    );

    // ── Migration 008: interview_schedules table ──────────────────────────────
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS interview_schedules (
            id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            application_id      UUID         NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            scheduled_datetime  TIMESTAMPTZ  NOT NULL,
            location            TEXT,
            interviewer_id      UUID         REFERENCES users(id),
            duration_minutes    INTEGER      NOT NULL DEFAULT 30,
            status              TEXT         NOT NULL DEFAULT 'scheduled',
            confirmation_sent_at TIMESTAMPTZ,
            reminder_sent_at    TIMESTAMPTZ,
            completed_at        TIMESTAMPTZ,
            feedback            TEXT,
            rating              SMALLINT     CHECK (rating BETWEEN 1 AND 5),
            created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by          UUID         REFERENCES users(id)
        )
    `, 'interview_schedules table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_application ON interview_schedules(application_id)`, 'idx_iv_application');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_datetime    ON interview_schedules(scheduled_datetime)`, 'idx_iv_datetime');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_status      ON interview_schedules(status)`, 'idx_iv_status');

    // ── Migration 009: audit_logs table ──────────────────────────────────────
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     UUID         REFERENCES users(id),
            action      TEXT         NOT NULL,
            entity_type TEXT         NOT NULL,
            entity_id   UUID,
            changes     JSONB,
            ip_address  TEXT,
            user_agent  TEXT,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'audit_logs table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user      ON audit_logs(user_id)`, 'idx_audit_user');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_entity    ON audit_logs(entity_type, entity_id)`, 'idx_audit_entity');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created   ON audit_logs(created_at DESC)`, 'idx_audit_created');

    // ── Migration 010: Live Agent Chat support ────────────────────────────────
    // communications table: track who sent each message and the bot state at send time
    const commCols = [
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS sender_type       VARCHAR(20)  DEFAULT 'bot'`, 'communications.sender_type'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS sender_name       VARCHAR(255)`, 'communications.sender_name'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS chatbot_state     VARCHAR(100)`, 'communications.chatbot_state'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS detected_language VARCHAR(20)`, 'communications.detected_language'],
        [`CREATE INDEX IF NOT EXISTS idx_comm_candidate_sent ON communications(candidate_id, sent_at DESC)`, 'idx_comm_candidate_sent'],
    ];
    for (const [sql, label] of commCols) {
        await safeAlter(sql, label);
    }

    // candidates table: track live-agent handoff state
    const handoffCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS is_human_handoff      BOOLEAN      NOT NULL DEFAULT FALSE`, 'candidates.is_human_handoff'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS agent_id              UUID         REFERENCES users(id) ON DELETE SET NULL`, 'candidates.agent_id'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS handoff_at            TIMESTAMPTZ`, 'candidates.handoff_at'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS handoff_released_at   TIMESTAMPTZ`, 'candidates.handoff_released_at'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_handoff ON candidates(is_human_handoff) WHERE is_human_handoff = TRUE`, 'idx_candidates_handoff'],
    ];
    for (const [sql, label] of handoffCols) {
        await safeAlter(sql, label);
    }

    logger.info('✅ Startup migrations complete.');
}

module.exports = { applyMigrations };
