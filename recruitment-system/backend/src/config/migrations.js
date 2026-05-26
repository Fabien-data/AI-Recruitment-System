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

    // ── Migration 006b: general_pool table ─────────────────────────────────
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS general_pool (
            id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            candidate_id  UUID         NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
            source        VARCHAR(50)  NOT NULL DEFAULT 'chatbot',
            metadata      JSONB,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'general_pool table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_general_pool_candidate ON general_pool(candidate_id)`, 'idx_general_pool_candidate');

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
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS attachments       TEXT[]`, 'communications.attachments'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS call_recording_url TEXT`, 'communications.call_recording_url'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS whatsapp_message_id VARCHAR(128)`, 'communications.whatsapp_message_id'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS metadata          JSONB DEFAULT '{}'::jsonb`, 'communications.metadata'],
        [`CREATE INDEX IF NOT EXISTS idx_comm_candidate_sent ON communications(candidate_id, sent_at DESC)`, 'idx_comm_candidate_sent'],
        [`CREATE INDEX IF NOT EXISTS idx_comm_wa_msg_id ON communications(whatsapp_message_id)`, 'idx_comm_wa_msg_id'],
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
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS conversation_stage    VARCHAR(64)`, 'candidates.conversation_stage'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_uploaded           BOOLEAN      NOT NULL DEFAULT FALSE`, 'candidates.cv_uploaded'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_status             VARCHAR(64)`, 'candidates.cv_status'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS last_interaction      TIMESTAMPTZ`, 'candidates.last_interaction'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_handoff ON candidates(is_human_handoff) WHERE is_human_handoff = TRUE`, 'idx_candidates_handoff'],
    ];
    for (const [sql, label] of handoffCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 011: AI escalation tracking ───────────────────────────────
    const escalationCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ai_status            VARCHAR(100)`, 'candidates.ai_status'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS requires_human       BOOLEAN      NOT NULL DEFAULT FALSE`, 'candidates.requires_human'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS escalated_at         TIMESTAMPTZ`, 'candidates.escalated_at'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS escalation_reason    TEXT`, 'candidates.escalation_reason'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_requires_human ON candidates(requires_human) WHERE requires_human = TRUE`, 'idx_candidates_requires_human'],
    ];
    for (const [sql, label] of escalationCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 012: chatbot_sync_outbox — realtime knowledge sync to bot ───
    // Outbox pattern: every job/project/FAQ change writes a row; a background
    // worker drains it and POSTs to the chatbot. Survives chatbot restarts,
    // retries with exponential backoff, and self-heals via the reconciler.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS chatbot_sync_outbox (
            id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            doc_id        VARCHAR(128) NOT NULL,
            doc_type      VARCHAR(32)  NOT NULL,
            operation     VARCHAR(16)  NOT NULL,
            payload       JSONB        NOT NULL,
            status        VARCHAR(16)  NOT NULL DEFAULT 'pending',
            attempts      INT          NOT NULL DEFAULT 0,
            last_error    TEXT,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            synced_at     TIMESTAMPTZ
        )
    `, 'chatbot_sync_outbox table');
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_outbox_pending ON chatbot_sync_outbox (status, updated_at) WHERE status IN ('pending','failed')`,
        'idx_outbox_pending'
    );
    await safeAlter(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_pending_per_doc ON chatbot_sync_outbox (doc_id, operation) WHERE status = 'pending'`,
        'idx_outbox_pending_per_doc'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_outbox_doc_synced ON chatbot_sync_outbox (doc_id, synced_at DESC) WHERE status = 'sent'`,
        'idx_outbox_doc_synced'
    );

    // ── Migration 013: urgent jobs + per-job required-fields schema ───────────
    // Lets recruiters flag a job as "urgent" so the chatbot can offer it when
    // no exact match exists for a candidate's stated preference, and lets each
    // job declare which intake fields are mandatory vs optional so the bot
    // asks the right questions for the right role.
    const jobSchemaCols = [
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN NOT NULL DEFAULT FALSE`, 'jobs.is_urgent'],
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_fields_schema JSONB DEFAULT '{}'::jsonb`, 'jobs.required_fields_schema'],
        [`CREATE INDEX IF NOT EXISTS idx_jobs_is_urgent ON jobs(is_urgent) WHERE is_urgent = TRUE`, 'idx_jobs_is_urgent'],
    ];
    for (const [sql, label] of jobSchemaCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 014: candidate remarks + preferences log for general pool ───
    // remarks: free-text note from chatbot when a lead is saved to the general
    //          pool without a specific job match (so we never lose them).
    // preferences_log: history of preferences declared across turns/sessions
    //          so recruiters can see the evolution of what the candidate wants.
    const candidatePoolCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS remarks TEXT`, 'candidates.remarks'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS preferences_log JSONB DEFAULT '[]'::jsonb`, 'candidates.preferences_log'],
    ];
    for (const [sql, label] of candidatePoolCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 015: Marketing Hub — lead_sources lookup ───────────────────
    // Reference table for lead-origin tagging (hotline_3cx, facebook_ad, etc.).
    // Created before marketing_leads because that table references it.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS lead_sources (
            id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            slug        VARCHAR(50)  NOT NULL UNIQUE,
            label       VARCHAR(120) NOT NULL,
            is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'lead_sources table');

    // Seed default lead sources (idempotent via ON CONFLICT)
    await safeAlter(`
        INSERT INTO lead_sources (slug, label) VALUES
            ('hotline_3cx',  'Hotline (3CX)'),
            ('facebook_ad',  'Facebook Ad'),
            ('referral',     'Referral'),
            ('walk_in',      'Walk-in'),
            ('chatbot',      'Chatbot'),
            ('other',        'Other')
        ON CONFLICT (slug) DO NOTHING
    `, 'lead_sources seed');

    // ── Migration 016: Marketing Hub — marketing_leads table ─────────────────
    // Raw leads captured by call-handling agents. Promoted into candidates via
    // an explicit convert step; until then they live exclusively in this table
    // so the recruitment pipeline stays clean.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS marketing_leads (
            id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            full_name               VARCHAR(255) NOT NULL,
            phone                   VARCHAR(50)  NOT NULL,
            nic                     VARCHAR(50),
            dob                     DATE,
            country                 VARCHAR(100),
            preferred_job_id        UUID         REFERENCES jobs(id) ON DELETE SET NULL,
            preferred_job_text      TEXT,
            remarks                 TEXT,
            source_id               UUID         REFERENCES lead_sources(id) ON DELETE SET NULL,
            campaign_ref            VARCHAR(100),
            stage                   VARCHAR(32)  NOT NULL DEFAULT 'new',
            lost_reason             TEXT,
            assigned_agent_id       UUID         REFERENCES users(id) ON DELETE SET NULL,
            converted_candidate_id  UUID         REFERENCES candidates(id) ON DELETE SET NULL,
            converted_at            TIMESTAMPTZ,
            last_contacted_at       TIMESTAMPTZ,
            created_by              UUID         REFERENCES users(id) ON DELETE SET NULL,
            created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'marketing_leads table');

    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_marketing_leads_phone        ON marketing_leads(phone)`, 'idx_marketing_leads_phone');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_marketing_leads_stage_agent  ON marketing_leads(stage, assigned_agent_id)`, 'idx_marketing_leads_stage_agent');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_marketing_leads_source_date  ON marketing_leads(source_id, created_at DESC)`, 'idx_marketing_leads_source_date');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_marketing_leads_converted    ON marketing_leads(converted_candidate_id) WHERE converted_candidate_id IS NOT NULL`, 'idx_marketing_leads_converted');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_marketing_leads_preferred_job ON marketing_leads(preferred_job_id) WHERE preferred_job_id IS NOT NULL`, 'idx_marketing_leads_preferred_job');

    // ── Migration 017: Marketing Hub — lead_documents table ──────────────────
    // CV + supporting docs (NIC, passport, etc.) attached to a lead.
    // Files live in GCS under marketing-leads/<lead_id>/; this row holds the URL.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS lead_documents (
            id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            lead_id      UUID         NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
            doc_type     VARCHAR(32)  NOT NULL DEFAULT 'other',
            url          TEXT         NOT NULL,
            name         VARCHAR(255) NOT NULL,
            mime_type    VARCHAR(100),
            size_bytes   BIGINT,
            uploaded_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
            uploaded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'lead_documents table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_lead_documents_lead ON lead_documents(lead_id)`, 'idx_lead_documents_lead');

    // ── Migration 018: Marketing Hub — lead_follow_ups table ─────────────────
    // Call-back reminders and tasks. The notifications service reads pending
    // rows where due_at <= NOW() to send WhatsApp/SMS reminders to the agent.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS lead_follow_ups (
            id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            lead_id       UUID         NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
            due_at        TIMESTAMPTZ  NOT NULL,
            note          TEXT,
            status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
            completed_at  TIMESTAMPTZ,
            created_by    UUID         REFERENCES users(id) ON DELETE SET NULL,
            created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'lead_follow_ups table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_due_pending ON lead_follow_ups(due_at) WHERE status = 'pending'`, 'idx_lead_follow_ups_due_pending');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_lead_follow_ups_lead         ON lead_follow_ups(lead_id)`, 'idx_lead_follow_ups_lead');

    // ── Migration 019: Marketing Hub — lead_call_events table ────────────────
    // Captures 3CX webhook events (ringing/pickup/ended). lead_id is nullable
    // because not every caller maps to an existing lead — unmatched calls are
    // still logged for analytics and later attribution.
    // Unique on (call_id, event_type) so 3CX retries cannot double-log.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS lead_call_events (
            id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            lead_id            UUID         REFERENCES marketing_leads(id) ON DELETE SET NULL,
            call_id            VARCHAR(128) NOT NULL,
            event_type         VARCHAR(32)  NOT NULL,
            caller_number      VARCHAR(50),
            agent_extension    VARCHAR(20),
            agent_user_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
            duration_seconds   INTEGER,
            recording_url      TEXT,
            raw_payload        JSONB,
            occurred_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'lead_call_events table');
    await safeAlter(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_call_events_unique ON lead_call_events(call_id, event_type)`, 'idx_lead_call_events_unique');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_lead_call_events_caller ON lead_call_events(caller_number)`, 'idx_lead_call_events_caller');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_lead_call_events_lead   ON lead_call_events(lead_id) WHERE lead_id IS NOT NULL`, 'idx_lead_call_events_lead');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_lead_call_events_occurred ON lead_call_events(occurred_at DESC)`, 'idx_lead_call_events_occurred');

    // ── Migration 020: jobs schema overhaul ──────────────────────────────────
    // Introduces structured urgency_level (replacing the is_urgent boolean),
    // country + country_code + domain (middle_east|europe) for geographic
    // targeting in the chatbot, and a new 4-value status enum
    // (active|inactive|complete|future) with pending_review kept as an
    // admin-only sub-state for low-confidence AI ingestions.
    //
    // Order matters: backfill data BEFORE adding CHECK constraints, otherwise
    // existing rows (paused/closed/filled) abort the constraint creation.
    // is_urgent is intentionally kept as a deprecated column for one release
    // so the chatbot Pinecone metadata (keyed on is_urgent today) keeps
    // working until the chatbot is redeployed reading urgency_level.

    // Step 1: add new columns (idempotent)
    const jobsOverhaulCols = [
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS urgency_level VARCHAR(20) NOT NULL DEFAULT 'normal'`, 'jobs.urgency_level'],
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS country       VARCHAR(100)`, 'jobs.country'],
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS country_code  CHAR(2)`, 'jobs.country_code'],
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS domain        VARCHAR(20)`, 'jobs.domain'],
    ];
    for (const [sql, label] of jobsOverhaulCols) {
        await safeAlter(sql, label);
    }

    // Step 2: backfill status values (run BEFORE adding CHECK).
    // UPDATEs are idempotent — WHERE clauses no longer match after first run.
    await safeAlter(`UPDATE jobs SET status = 'inactive' WHERE status = 'paused'`, 'jobs.status backfill paused→inactive');
    await safeAlter(`UPDATE jobs SET status = 'complete' WHERE status IN ('closed','filled')`, 'jobs.status backfill closed/filled→complete');

    // Step 3: backfill urgency_level from legacy is_urgent
    await safeAlter(
        `UPDATE jobs SET urgency_level = 'urgent' WHERE is_urgent = TRUE AND urgency_level = 'normal'`,
        'jobs.urgency_level backfill from is_urgent'
    );

    // Step 4: add CHECK constraints (safeAlter swallows "already exists")
    await safeAlter(
        `ALTER TABLE jobs ADD CONSTRAINT jobs_urgency_level_chk CHECK (urgency_level IN ('top_urgent','urgent','situational','normal'))`,
        'jobs_urgency_level_chk'
    );
    await safeAlter(
        `ALTER TABLE jobs ADD CONSTRAINT jobs_domain_chk CHECK (domain IS NULL OR domain IN ('middle_east','europe'))`,
        'jobs_domain_chk'
    );
    await safeAlter(
        `ALTER TABLE jobs ADD CONSTRAINT jobs_status_chk CHECK (status IN ('active','inactive','complete','future','pending_review'))`,
        'jobs_status_chk'
    );

    // Step 5: indexes (partial, only where useful)
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_jobs_urgency ON jobs(urgency_level) WHERE urgency_level <> 'normal'`,
        'idx_jobs_urgency'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_jobs_domain ON jobs(domain) WHERE domain IS NOT NULL`,
        'idx_jobs_domain'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_jobs_country_code ON jobs(country_code) WHERE country_code IS NOT NULL`,
        'idx_jobs_country_code'
    );

    // Step 6: drop the now-redundant idx_jobs_is_urgent (replaced by idx_jobs_urgency).
    // The is_urgent column itself stays for one release as a deprecated shim.
    await safeAlter(`DROP INDEX IF EXISTS idx_jobs_is_urgent`, 'drop idx_jobs_is_urgent');

    logger.info('✅ Startup migrations complete.');
}

module.exports = { applyMigrations };
