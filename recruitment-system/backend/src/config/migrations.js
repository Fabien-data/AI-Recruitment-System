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

/**
 * Run a one-time DATA migration (UPDATE/INSERT). Logs the affected row count and
 * never throws into startup — a WARN keeps the server booting (table-ownership
 * issues on Cloud SQL surface here as a WARN, never a crash). Idempotent by
 * construction: the WHERE clauses match only the legacy values they rewrite, so
 * re-running on already-migrated data is a no-op (0 rows).
 */
async function safeUpdate(sql, label) {
    try {
        const res = await query(sql, []);
        const n = res.rowCount != null ? res.rowCount : (res.rows ? res.rows.length : 0);
        logger.info(`  migration: OK  — ${label} (${n} row${n === 1 ? '' : 's'})`);
        return n;
    } catch (err) {
        logger.warn(`  migration: WARN — ${label}: ${err.message.split('\n')[0]}`);
        return -1;
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
        // photo_url was referenced by the photo-upload route and the
        // auto-assign job-candidates query but never added by any migration
        // or schema.sql — its absence made /api/auto-assign/job/:id/candidates
        // 500 ("column c.photo_url does not exist"), which the frontend
        // rendered as "Job Not Found" on the View Candidates page.
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS photo_url             TEXT`, 'candidates.photo_url'],
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

    // ── Migration 020: Knowledge Base Documents (chatbot doc ingestion) ──────
    // Recruiters upload PDF/DOCX/TXT into the KB. We parse + chunk on insert
    // and store each chunk in knowledge_document_chunks. The chatbot retrieves
    // matching chunks alongside the existing FAQ knowledge_base entries.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS knowledge_documents (
            id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id           UUID,
            title               TEXT         NOT NULL,
            original_filename   TEXT         NOT NULL,
            mime_type           TEXT         NOT NULL,
            file_size_bytes     BIGINT       NOT NULL,
            storage_url         TEXT,
            category            VARCHAR(100) NOT NULL DEFAULT 'general',
            status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
            parse_error         TEXT,
            chunk_count         INT          NOT NULL DEFAULT 0,
            uploaded_by         UUID         REFERENCES users(id) ON DELETE SET NULL,
            uploaded_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'knowledge_documents table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_kbdoc_status   ON knowledge_documents(status)`, 'idx_kbdoc_status');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_kbdoc_category ON knowledge_documents(category)`, 'idx_kbdoc_category');

    await safeAlter(`
        CREATE TABLE IF NOT EXISTS knowledge_document_chunks (
            id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            document_id  UUID         NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
            chunk_index  INT          NOT NULL,
            content      TEXT         NOT NULL,
            token_count  INT,
            keywords     JSONB        DEFAULT '[]'::jsonb,
            created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'knowledge_document_chunks table');
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_kbchunk_document ON knowledge_document_chunks(document_id)`,
        'idx_kbchunk_document'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_kbchunk_content_fts ON knowledge_document_chunks USING gin(to_tsvector('english', content))`,
        'idx_kbchunk_content_fts'
    );

    // ── Migration 021: Admin Observability — sections, permissions, sessions ──
    // Adds per-section CRUD permissions on top of the existing 4-role model and
    // wires session/view tracking so admins can audit user behaviour and print
    // KPI reports. Sections are a fixed lookup table seeded once; the four
    // legacy roles continue to work via role-default permissions in code.

    // sections lookup (seeded once, immutable in practice)
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS sections (
            key         VARCHAR(40)  PRIMARY KEY,
            name        VARCHAR(80)  NOT NULL,
            icon        VARCHAR(40)  NOT NULL,
            description TEXT,
            sort_order  SMALLINT     NOT NULL DEFAULT 100
        )
    `, 'sections table');

    await safeAlter(`
        INSERT INTO sections (key, name, icon, description, sort_order) VALUES
            ('dashboard',      'Dashboard',       'LayoutDashboard', 'System overview', 10),
            ('cv_manager',     'CV Manager',      'FileSearch',      'CV upload, parsing and matching', 20),
            ('jobs',           'Jobs',            'Briefcase',       'Open positions and requirements', 30),
            ('candidates',     'Candidates',      'Users',           'Candidate profiles and pipeline', 40),
            ('projects',       'Projects',        'FolderKanban',    'Recruitment projects', 50),
            ('applications',   'Applications',    'FileText',        'Job applications and statuses', 60),
            ('interviews',     'Interviews',      'CalendarDays',    'Interview scheduling', 70),
            ('communications', 'Communications',  'MessageSquare',   'Messaging and outreach', 80),
            ('analytics',      'Analytics',       'BarChart2',       'Reporting and KPIs', 90),
            ('knowledge_base', 'Knowledge Base',  'BookOpen',        'FAQ and documents for chatbot', 100),
            ('general_pool',   'General Pool',    'Database',        'Unassigned candidate pool', 120)
        ON CONFLICT (key) DO NOTHING
    `, 'sections seed');
    // NOTE: 'marketing_hub' section intentionally NOT seeded — the Marketing Hub
    // feature was removed (Migration 051 drops the row on existing DBs). The
    // underlying lead_* tables are kept because the 3CX call webhook writes to
    // them (see routes/webhooks-3cx.js).

    // per-user, per-section CRUD permissions
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS user_section_permissions (
            user_id     UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            section_key VARCHAR(40)   NOT NULL REFERENCES sections(key) ON DELETE CASCADE,
            can_view    BOOLEAN       NOT NULL DEFAULT FALSE,
            can_create  BOOLEAN       NOT NULL DEFAULT FALSE,
            can_edit    BOOLEAN       NOT NULL DEFAULT FALSE,
            can_delete  BOOLEAN       NOT NULL DEFAULT FALSE,
            updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            PRIMARY KEY (user_id, section_key)
        )
    `, 'user_section_permissions table');
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_usp_user ON user_section_permissions(user_id)`,
        'idx_usp_user'
    );

    // Enrich audit_logs (created in Migration 009) for session/section tracking.
    // Existing rows get NULL for these columns — downstream code tolerates this.
    const auditExtraCols = [
        [`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS session_id  UUID`,             'audit_logs.session_id'],
        [`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS section_key VARCHAR(40)`,      'audit_logs.section_key'],
        [`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER`,          'audit_logs.duration_ms'],
        [`CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_logs(session_id) WHERE session_id IS NOT NULL`, 'idx_audit_session'],
        [`CREATE INDEX IF NOT EXISTS idx_audit_user_section_date ON audit_logs(user_id, section_key, created_at DESC)`, 'idx_audit_user_section_date'],
    ];
    for (const [sql, label] of auditExtraCols) {
        await safeAlter(sql, label);
    }

    // Session lifecycle: one row per login, closed out on logout.
    // Used for avg session duration and as the FK target for audit_logs.session_id.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id      UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            login_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            logout_at    TIMESTAMPTZ,
            duration_ms  BIGINT,
            ip_address   TEXT,
            user_agent   TEXT
        )
    `, 'user_sessions table');
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_date ON user_sessions(user_id, login_at DESC)`,
        'idx_user_sessions_user_date'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_user_sessions_open ON user_sessions(user_id) WHERE logout_at IS NULL`,
        'idx_user_sessions_open'
    );

    // ── Migration 022: Pipeline v2 — pre_screened status, industry_types array ──
    // Adds the new lifecycle status step and the multi-industry array column.
    // applications.status is plain TEXT (no CHECK constraint) so pre_screened
    // is already accepted by the column itself — we only need the timestamp
    // tracker and the optional projects.industry_types backfill.
    //
    // Also patches a pre-existing schema gap: auto-assign.js has always
    // SELECTed (and INSERTed) applications.screening_details but the column
    // was never added by any migration or schema.sql, so /api/auto-assign/
    // job/:id/candidates returned 500 in prod ("column does not exist") and
    // the frontend rendered that as "Job Not Found". JSONB so the existing
    // JSON.parse callers keep working.
    const pipelineV2Cols = [
        [
            `ALTER TABLE applications ADD COLUMN IF NOT EXISTS prescreening_completed_at TIMESTAMPTZ`,
            'applications.prescreening_completed_at',
        ],
        [
            `ALTER TABLE applications ADD COLUMN IF NOT EXISTS prescreening_notes TEXT`,
            'applications.prescreening_notes',
        ],
        [
            `ALTER TABLE applications ADD COLUMN IF NOT EXISTS prescreening_rating SMALLINT`,
            'applications.prescreening_rating',
        ],
        [
            `ALTER TABLE applications ADD COLUMN IF NOT EXISTS screening_details JSONB DEFAULT '{}'::jsonb`,
            'applications.screening_details',
        ],
        [
            `ALTER TABLE projects ADD COLUMN IF NOT EXISTS industry_types JSONB DEFAULT '[]'::jsonb`,
            'projects.industry_types',
        ],
    ];
    for (const [sql, label] of pipelineV2Cols) {
        await safeAlter(sql, label);
    }

    // Backfill industry_types from the legacy industry_type column.
    // Idempotent: only updates rows where industry_types is still the empty
    // default but industry_type has a value.
    await safeAlter(
        `UPDATE projects
            SET industry_types = jsonb_build_array(industry_type)
          WHERE (industry_types IS NULL OR industry_types = '[]'::jsonb)
            AND industry_type IS NOT NULL
            AND industry_type <> ''`,
        'projects.industry_types backfill from industry_type',
    );

    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_projects_industry_types ON projects USING gin (industry_types)`,
        'idx_projects_industry_types (GIN)',
    );

    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_app_prescreened ON applications(prescreening_completed_at) WHERE prescreening_completed_at IS NOT NULL`,
        'idx_app_prescreened',
    );

    // ── Migration 023: interview description ──────────────────────────────────
    // Free-text note captured when scheduling an interview (extra details for
    // the candidate), surfaced in the WhatsApp invite (B016).
    await safeAlter(
        `ALTER TABLE interview_schedules ADD COLUMN IF NOT EXISTS description TEXT`,
        'interview_schedules.description',
    );

    // ── Migration 024: de-duplicate applications + enforce uniqueness ─────────
    // Legacy rows may hold duplicate (candidate_id, job_id) pairs created by
    // races/retries before the API-layer upsert landed. Keep the single
    // furthest-along application per pair, delete the rest. Idempotent: a clean
    // table deletes 0. On prod the table may be postgres-owned, so the DELETE
    // can be rejected ("must be owner") — safeAlter logs WARN and continues;
    // run scripts/dedupe-applications.js with the owner role as a fallback.
    await safeAlter(
        `DELETE FROM applications a
          USING (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY candidate_id, job_id
              ORDER BY CASE status
                WHEN 'placed'              THEN 8
                WHEN 'selected'            THEN 7
                WHEN 'interview_scheduled' THEN 6
                WHEN 'interviewed'         THEN 6
                WHEN 'pre_screened'        THEN 5
                WHEN 'certified'           THEN 4
                WHEN 'screening'           THEN 3
                WHEN 'reviewing'           THEN 2
                WHEN 'auto_assigned'       THEN 2
                WHEN 'applied'             THEN 2
                ELSE 1
              END DESC, applied_at ASC
            ) AS rn
            FROM applications
          ) d
          WHERE a.id = d.id AND d.rn > 1`,
        'dedupe applications (keep furthest-along per candidate+job)',
    );

    // Defensive: guarantee the unique index exists so new duplicates are
    // blocked at the DB level (it already ships in schema.sql:186).
    await safeAlter(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_unique ON applications(candidate_id, job_id)`,
        'idx_applications_unique',
    );

    // Speeds up the smart-scheduler per-interviewer/day load seed query.
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_iv_interviewer_datetime ON interview_schedules(interviewer_id, scheduled_datetime)`,
        'idx_iv_interviewer_datetime',
    );

    // Candidate-stage filtering (CV Manager / candidate list) is now hot.
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status)`,
        'idx_candidates_status',
    );

    // ── Migration 025: recurring interview-reminder cadence ───────────────────
    // The original reminder used a single reminder_sent_at marker (one-shot,
    // 24h before). The recurring cadence sends a nudge on each of the final 3
    // days before the interview + a distinct morning-of message, so it needs
    // per-day tracking. last_reminder_date = the date (Asia/Colombo) of the most
    // recent daily reminder (≤ one per day); dayof_reminder_sent_at marks the
    // separate interview-day reminder. NOTE: on prod interview_schedules may be
    // postgres-owned, so these ALTERs can be rejected ("must be owner") — that is
    // logged WARN and the reminder sweep degrades to the legacy one-shot path
    // (see interview-reminder.js). Run scripts/fix-interview-ownership.js to
    // enable the full cadence.
    const interviewReminderCols = [
        [`ALTER TABLE interview_schedules ADD COLUMN IF NOT EXISTS last_reminder_date     DATE`,        'interview_schedules.last_reminder_date'],
        [`ALTER TABLE interview_schedules ADD COLUMN IF NOT EXISTS reminder_count         SMALLINT DEFAULT 0`, 'interview_schedules.reminder_count'],
        [`ALTER TABLE interview_schedules ADD COLUMN IF NOT EXISTS dayof_reminder_sent_at TIMESTAMPTZ`, 'interview_schedules.dayof_reminder_sent_at'],
    ];
    for (const [sql, label] of interviewReminderCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 037: interview outcome (passed / failed / pending_review) ────
    // Structured hiring decision per interview (distinct from the 1–5 rating +
    // free-text feedback). NOTE: on prod interview_schedules may be postgres-
    // owned, so this ALTER can be rejected ("must be owner") — logged WARN; the
    // routes degrade gracefully (interviewHasOutcomeColumn gate). Run
    // scripts/fix-interview-ownership.js to enable persistence.
    await safeAlter(
        `ALTER TABLE interview_schedules ADD COLUMN IF NOT EXISTS outcome VARCHAR(20)`,
        'interview_schedules.outcome',
    );

    // ── Migration 026: job re-engagement waiting list ─────────────────────────
    // When a candidate wanted a role we had no opening for (they land in
    // general_pool with metadata.job_interest_stated), we proactively message
    // them when a matching job is later activated. interest_notified_at de-dupes
    // so a candidate is invited at most once per pool entry.
    await safeAlter(
        `ALTER TABLE general_pool ADD COLUMN IF NOT EXISTS interest_notified_at TIMESTAMPTZ`,
        'general_pool.interest_notified_at',
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_general_pool_unnotified ON general_pool(interest_notified_at) WHERE interest_notified_at IS NULL`,
        'idx_general_pool_unnotified',
    );

    // ── Migration 027: candidate_tasks (agent callback/follow-up tasks) ───────
    // Mirrors lead_follow_ups but for recruitment candidates: an agent schedules
    // "call back {candidate} on {due_at}". Surfaced in a due-tasks queue.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS candidate_tasks (
            id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            candidate_id   UUID         NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
            application_id UUID         REFERENCES applications(id) ON DELETE SET NULL,
            due_at         TIMESTAMPTZ  NOT NULL,
            note           TEXT,
            task_type      VARCHAR(40)  NOT NULL DEFAULT 'callback',
            status         VARCHAR(20)  NOT NULL DEFAULT 'pending',
            outcome        TEXT,
            assigned_to    UUID         REFERENCES users(id) ON DELETE SET NULL,
            created_by     UUID         REFERENCES users(id) ON DELETE SET NULL,
            completed_at   TIMESTAMPTZ,
            created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'candidate_tasks table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_candidate_tasks_due_pending ON candidate_tasks(due_at) WHERE status = 'pending'`, 'idx_candidate_tasks_due_pending');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_candidate_tasks_candidate ON candidate_tasks(candidate_id)`, 'idx_candidate_tasks_candidate');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_candidate_tasks_assignee ON candidate_tasks(assigned_to) WHERE status = 'pending'`, 'idx_candidate_tasks_assignee');

    // ── Migration 028: in-call presence (multi-agent calling console) ─────────
    // Lets an agent flag "I'm on a call with this candidate" so the other agents
    // see it live and don't double-call. Manual toggle (external dialer, no API).
    // Cleared on socket disconnect + a TTL sweep in server.js. recruitment_db only
    // — the Python chatbot maps a different candidates table (chatbot_db) and never
    // reads these columns.
    const callPresenceCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS call_status     VARCHAR(20)`, 'candidates.call_status'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS call_agent_id   UUID REFERENCES users(id) ON DELETE SET NULL`, 'candidates.call_agent_id'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS call_started_at TIMESTAMPTZ`, 'candidates.call_started_at'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_on_call ON candidates(call_agent_id) WHERE call_status = 'on_call'`, 'idx_candidates_on_call'],
    ];
    for (const [sql, label] of callPresenceCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 029: call disposition + contacted markers + shared-pool claim ─
    // `disposition` is the agent's call outcome / lead status (app-validated, no
    // CHECK so other writers can't trip it). `last_contacted_at` is dedicated to
    // AGENT contact — distinct from `last_contact_at`, which the bot/email/webhook
    // bump on every inbound. `claimed_by` lets an agent claim a chat to themselves
    // in the shared pool so the 5 agents don't collide.
    const triageCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS disposition       VARCHAR(24)`, 'candidates.disposition'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS disposition_at    TIMESTAMPTZ`, 'candidates.disposition_at'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS disposition_by    UUID REFERENCES users(id) ON DELETE SET NULL`, 'candidates.disposition_by'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ`, 'candidates.last_contacted_at'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS contacted_by      UUID REFERENCES users(id) ON DELETE SET NULL`, 'candidates.contacted_by'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS claimed_by        UUID REFERENCES users(id) ON DELETE SET NULL`, 'candidates.claimed_by'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS claimed_at        TIMESTAMPTZ`, 'candidates.claimed_at'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_disposition ON candidates(disposition) WHERE disposition IS NOT NULL`, 'idx_candidates_disposition'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_claimed_by ON candidates(claimed_by) WHERE claimed_by IS NOT NULL`, 'idx_candidates_claimed_by'],
    ];
    for (const [sql, label] of triageCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 030: call_logs (agent call/remark engagement log) ───────────
    // One row per logged call or standalone remark; powers the per-candidate call
    // log and the per-agent engagement rollup. General CRUD actions stay in
    // audit_logs — this table is specifically the calling-console engagement feed.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS call_logs (
            id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            candidate_id     UUID         NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
            agent_id         UUID         REFERENCES users(id) ON DELETE SET NULL,
            outcome          VARCHAR(24),
            disposition      VARCHAR(24),
            remark           TEXT,
            duration_seconds INTEGER,
            called_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'call_logs table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_call_logs_candidate  ON call_logs(candidate_id, called_at DESC)`, 'idx_call_logs_candidate');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_call_logs_agent_date ON call_logs(agent_id, called_at DESC)`, 'idx_call_logs_agent_date');

    // ── Migration 031: link a call log to the job it assigned + the reason ──────
    // When an agent advances a New candidate to Screening via the "Done" action
    // they pick a job/project; `job_id` records that assignment so the call log
    // can show "Assigned to <job> @ <project>". `reason` captures the structured
    // not-interested reason (Salary too low / Wrong location / …). Both nullable —
    // a plain remark-only log still works.
    const callLogAssignmentCols = [
        [`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS job_id         UUID REFERENCES jobs(id) ON DELETE SET NULL`, 'call_logs.job_id'],
        [`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE SET NULL`, 'call_logs.application_id'],
        [`ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS reason         VARCHAR(48)`, 'call_logs.reason'],
        [`CREATE INDEX IF NOT EXISTS idx_call_logs_job ON call_logs(job_id) WHERE job_id IS NOT NULL`, 'idx_call_logs_job'],
    ];
    for (const [sql, label] of callLogAssignmentCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 032: status-vocabulary standardization (UPGRADES.md #1 + #5) ──
    // Collapse the legacy application vocabulary onto the canonical 5, normalize
    // the candidate vocabulary onto the canonical 7, re-bucket CV-less candidates
    // back to New (the CV is the hard eligibility gate — #5), and retire
    // conversation_stage as a separate vocabulary (mirror it to status).
    //
    // Canonical candidate.status : new, screening, certified, interview_scheduled,
    //                              future_pool, merged, hired
    // Canonical application.status: screening, certified, interview_scheduled,
    //                              hired, rejected
    //
    // All UPDATEs are idempotent (they only match values they rewrite) and run via
    // safeUpdate so a table-ownership WARN can never abort startup.

    // (a) candidate-level 'rejected' is NOT a canonical candidate status — a
    //     decline maps to future_pool (re-engageable). CV-less ones get pulled to
    //     New by step (b) below, consistent with #5.
    await safeUpdate(
        `UPDATE candidates SET status = 'future_pool' WHERE status = 'rejected'`,
        '032a candidates rejected → future_pool'
    );

    // (b) [REMOVED 2026-06-08] This step used to re-bucket every CV-less candidate
    //     back to New. The CV hard-gate has been DROPPED (user decision — candidates
    //     reflect their real application stage regardless of CV; almost all prod
    //     candidates are agency-imported with offline CVs). Left in, this re-bucket
    //     reverted advanced candidates to New on EVERY boot, wiping their true stage
    //     (e.g. interview_scheduled 861 → 129). It is replaced by the self-healing
    //     re-derivation in step (d) below.

    // (c) collapse application.status legacy values onto the canonical 5.
    await safeUpdate(
        `UPDATE applications SET status = 'screening'
          WHERE status IN ('applied','auto_assigned','reviewing')`,
        '032c applications applied/auto_assigned/reviewing → screening'
    );
    await safeUpdate(
        `UPDATE applications SET status = 'certified' WHERE status = 'pre_screened'`,
        '032c applications pre_screened → certified'
    );
    await safeUpdate(
        `UPDATE applications SET status = 'interview_scheduled'
          WHERE status IN ('interviewed','selected')`,
        '032c applications interviewed/selected → interview_scheduled'
    );
    await safeUpdate(
        `UPDATE applications SET status = 'hired' WHERE status = 'placed'`,
        '032c applications placed → hired'
    );
    await safeUpdate(
        `UPDATE applications SET status = 'rejected' WHERE status = 'transferred'`,
        '032c applications transferred → rejected'
    );

    // (d) Self-healing candidate-stage re-derivation (replaces the old 032b CV
    //     re-bucket). Sets candidate.status (+ conversation_stage) to the FURTHEST
    //     non-rejected application stage, regardless of CV. Idempotent — only
    //     rewrites drifted rows — and runs every boot, so candidate.status can
    //     never fall behind the Applications page again (the recurring "counts are
    //     wrong / Interview Scheduled too low" bug). merged/hired are terminal;
    //     candidates with no forward application keep their status (future_pool
    //     parking preserved). This is the permanent form of the manual backfill.
    await safeUpdate(
        `UPDATE candidates c
            SET status = v.s, conversation_stage = v.s, updated_at = NOW()
           FROM (
                 SELECT a.candidate_id,
                        MAX(CASE
                              WHEN a.status IN ('interview_scheduled','interviewed','selected','placed') THEN 3
                              WHEN a.status IN ('certified','pre_screened') THEN 2
                              WHEN a.status IN ('screening','applied','auto_assigned','reviewing') THEN 1
                              ELSE 0 END) AS rnk
                   FROM applications a
                  GROUP BY a.candidate_id
                ) r,
                LATERAL (SELECT (CASE r.rnk WHEN 3 THEN 'interview_scheduled'
                                            WHEN 2 THEN 'certified'
                                            WHEN 1 THEN 'screening' END) AS s) v
          WHERE c.id = r.candidate_id
            AND r.rnk > 0
            AND c.status NOT IN ('merged','hired')
            AND c.status IS DISTINCT FROM v.s`,
        '032d candidate.status re-derived from furthest application'
    );

    // NOTE: conversation_stage is intentionally NOT mass-mirrored here. It is no
    // longer a status axis anywhere in the CRM (the active-chats + Messages filters
    // that keyed off it are removed in this release), so the chatbot may keep using
    // it as its own chat-flow indicator without conflicting with candidate.status.

    // (e) observability: surface any value still outside the canonical sets so a
    //     stray writer is caught in the deploy log (does not block startup).
    try {
        const strayCand = await query(
            `SELECT status, COUNT(*)::int AS n FROM candidates
              WHERE status IS NOT NULL
                AND status NOT IN ('new','screening','certified','interview_scheduled','future_pool','merged','hired')
              GROUP BY status`, []
        );
        if (strayCand.rows.length) {
            logger.warn(`  migration: 032 ⚠ candidates with non-canonical status remain: ${JSON.stringify(strayCand.rows)}`);
        }
        const strayApp = await query(
            `SELECT status, COUNT(*)::int AS n FROM applications
              WHERE status IS NOT NULL
                AND status NOT IN ('screening','certified','interview_scheduled','hired','rejected')
              GROUP BY status`, []
        );
        if (strayApp.rows.length) {
            logger.warn(`  migration: 032 ⚠ applications with non-canonical status remain: ${JSON.stringify(strayApp.rows)}`);
        }
    } catch (err) {
        logger.warn(`  migration: 032e stray-status audit skipped: ${err.message.split('\n')[0]}`);
    }

    // ── Migration 033: integrity constraints (UPGRADES.md #1 + #2) ─────────────
    // Best-effort CHECK constraints (added via safeAlter so an ownership failure
    // is a WARN, not a crash). Application-level validation is the primary guard;
    // these make the DB the backstop. Run AFTER 032 so existing rows validate.

    // users.role: normalize any legacy values first, then constrain to the 4 roles.
    await safeUpdate(
        `UPDATE users SET role = 'project_handler' WHERE role = 'recruiter'`,
        '033 users.role recruiter → project_handler'
    );
    await safeUpdate(
        `UPDATE users SET role = 'sourcing_department' WHERE role = 'supervisor'`,
        '033 users.role supervisor → sourcing_department'
    );
    await safeAlter(
        `ALTER TABLE users ADD CONSTRAINT users_role_chk
            CHECK (role IN ('admin','project_handler','marketing_agent','sourcing_department'))`,
        '033 users_role_chk'
    );

    // Realign the column default so it can never violate the new CHECK (the
    // legacy default 'applied' is no longer a permitted value).
    await safeAlter(
        `ALTER TABLE applications ALTER COLUMN status SET DEFAULT 'screening'`,
        "033 applications.status default → screening"
    );
    await safeAlter(
        `ALTER TABLE applications ADD CONSTRAINT applications_status_chk
            CHECK (status IN ('screening','certified','interview_scheduled','hired','rejected'))`,
        '033 applications_status_chk'
    );
    await safeAlter(
        `ALTER TABLE candidates ADD CONSTRAINT candidates_status_chk
            CHECK (status IS NULL OR status IN ('new','screening','certified','interview_scheduled','future_pool','merged','hired'))`,
        '033 candidates_status_chk'
    );

    // ── Migration 034: per-user workspace preferences ────────────────────────
    // A separate table (NOT a users column) on purpose: the `users` table is
    // postgres-owned, so ALTER TABLE users fails for recruitment_user (see the
    // 033 users_role_chk WARN). recruitment_user CAN create new tables, so the
    // per-user prefs live here. Stores a free-form JSON blob namespaced by
    // feature (e.g. { communications: {...}, ... }) — powers the persistent
    // Messages workspace (#3.0) and future saved-views.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS user_preferences (
            user_id    UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            prefs      JSONB        NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, '034 user_preferences table');

    // ── Migration 035: profile-picture source flag (#6) ──────────────────────
    // 'auto'  = set from a chatbot-detected person-photo (latest one refreshes it)
    // 'manual'= an agent uploaded it → LOCKED, auto never overwrites.
    // NULL    = no picture yet. candidates.photo_url already exists (migration 005).
    await safeAlter(
        `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS photo_source VARCHAR(10)`,
        '035 candidates.photo_source',
    );

    // ── Migration 036: semantic-match embeddings (#4a) ───────────────────────
    // Embeddings (OpenAI text-embedding-3-small, 1536 dims) stored as JSONB +
    // a content hash to detect staleness. We compute cosine similarity in JS at
    // shortlist time (tiny scale: ~900 CVs / ~14 jobs) — no pgvector needed, so
    // no CREATE EXTENSION privilege is required.
    const embedCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_embedding      JSONB`,        '036 candidates.cv_embedding'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_embedding_hash VARCHAR(64)`,  '036 candidates.cv_embedding_hash'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_embedding_at   TIMESTAMPTZ`,  '036 candidates.cv_embedding_at'],
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS embedding      JSONB`,        '036 jobs.embedding'],
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS embedding_hash VARCHAR(64)`,  '036 jobs.embedding_hash'],
        [`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS embedding_at   TIMESTAMPTZ`,  '036 jobs.embedding_at'],
    ];
    for (const [sql, label] of embedCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 037: hot-path indexes for list/analytics performance ───────
    // The Applications list filters/sorts on applications.status + applied_at;
    // the active-chats + analytics queries scan communications.sent_at. These
    // were the full-scan hot spots behind slow loads / laggy writes. Distinct
    // from existing indexes: candidates(status) [024], communications(candidate_id,
    // sent_at) [010] and the UNIQUE applications(candidate_id, job_id) [024] are
    // already covered. safeAlter degrades to a WARN if a table is postgres-owned.
    const perfIdx = [
        [`CREATE INDEX IF NOT EXISTS idx_applications_status     ON applications(status)`,         '037 idx_applications_status'],
        [`CREATE INDEX IF NOT EXISTS idx_applications_applied_at ON applications(applied_at DESC)`, '037 idx_applications_applied_at'],
        [`CREATE INDEX IF NOT EXISTS idx_communications_sent_at  ON communications(sent_at DESC)`,  '037 idx_communications_sent_at'],
    ];
    for (const [sql, label] of perfIdx) {
        await safeAlter(sql, label);
    }

    // ── Migration 038: WhatsApp reachability flag ────────────────────────────
    // Set when an interview/notification send comes back "not a WhatsApp user"
    // (Meta error 131026/131030). Used to sink unreachable candidates to the
    // bottom of lists and to export a manual-call CSV — so no application is
    // silently skipped when the candidate can't receive WhatsApp.
    const reachabilityCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_unreachable BOOLEAN NOT NULL DEFAULT FALSE`, '038 candidates.whatsapp_unreachable'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_last_error  TEXT`, '038 candidates.whatsapp_last_error'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_checked_at  TIMESTAMPTZ`, '038 candidates.whatsapp_checked_at'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_wa_unreachable ON candidates(whatsapp_unreachable)`, '038 idx_candidates_wa_unreachable'],
    ];
    for (const [sql, label] of reachabilityCols) {
        await safeAlter(sql, label);
    }

    // ── Migration 040: call_logs.action_type ─────────────────────────────────
    // Distinguish a genuine phone CALL from an agent ACTION (assign / certify /
    // schedule interview / follow-up / not-interested / note). Before this every
    // action was logged with a call `outcome`, so "calls logged" was inflated and
    // the engagement log read as if every action was a call. NULL = legacy row
    // (treated as 'call' for display). Indexed for the per-agent rollup.
    await safeAlter(
        `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS action_type VARCHAR(24)`,
        '040 call_logs.action_type'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_call_logs_agent_action ON call_logs(agent_id, action_type, called_at DESC)`,
        '040 idx_call_logs_agent_action'
    );

    // ── Migration 039: future projects ────────────────────────────────────────
    // A "future project" is a pipeline project an agent can transfer/assign a
    // candidate into before it's officially active. Lightweight inline roles
    // created under it use jobs.status='draft' (no extra column needed). Online-
    // safe: ADD COLUMN ... DEFAULT FALSE is metadata-only on Postgres 11+.
    await safeAlter(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS is_future BOOLEAN NOT NULL DEFAULT FALSE`,
        '039 projects.is_future'
    );

    // ── Migration 041: claim_sessions audit table ────────────────────────────
    // Claim/release used to only flip candidates.claimed_by/claimed_at, so a
    // release destroyed all history and engagement stats could never tell which
    // calls/messages happened DURING a claim. claim_sessions records every claim
    // window (who, when, how it ended). The partial unique index is the race
    // guard: a candidate can have at most one OPEN session at a time.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS claim_sessions (
            id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            candidate_id   UUID         NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
            agent_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            claimed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            released_at    TIMESTAMPTZ,
            released_by    UUID         REFERENCES users(id) ON DELETE SET NULL,
            release_reason VARCHAR(32)
        )
    `, '041 claim_sessions table');
    await safeAlter(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_claim_sessions_open ON claim_sessions(candidate_id) WHERE released_at IS NULL`,
        '041 uq_claim_sessions_open'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_claim_sessions_agent ON claim_sessions(agent_id, claimed_at DESC)`,
        '041 idx_claim_sessions_agent'
    );
    // Seed: open a session for every chat that is claimed right now, so current
    // holders keep an unbroken window across this deploy.
    await safeUpdate(`
        INSERT INTO claim_sessions (candidate_id, agent_id, claimed_at)
        SELECT c.id, c.claimed_by, COALESCE(c.claimed_at, NOW())
        FROM candidates c
        WHERE c.claimed_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM claim_sessions cs WHERE cs.candidate_id = c.id AND cs.released_at IS NULL)
    `, '041b seed open claim_sessions');

    // ── Migration 042: claim stamping on call_logs + communications ──────────
    // Write paths stamp the open claim_session id at INSERT time, freezing "did
    // this agent hold the claim when they did this?" — engagement stats then
    // filter on the stamp instead of reconstructing claim windows. No FK on
    // purpose: the id is for audit joins only, inserts stay cheap.
    await safeAlter(
        `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS claim_session_id UUID`,
        '042 call_logs.claim_session_id'
    );
    await safeAlter(
        `ALTER TABLE communications ADD COLUMN IF NOT EXISTS claim_session_id UUID`,
        '042 communications.claim_session_id'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_communications_agent_claimed ON communications(sent_by, sent_at DESC) WHERE claim_session_id IS NOT NULL`,
        '042 idx_communications_agent_claimed'
    );
    // Approximate backfill (user decision 2026-06-11): credit historic work that
    // falls inside a CURRENTLY OPEN claim window. Released claims left no trace,
    // so anything older stays unstamped — stats are exact from this deploy on.
    await safeUpdate(`
        UPDATE call_logs cl SET claim_session_id = cs.id
        FROM claim_sessions cs
        WHERE cl.claim_session_id IS NULL
          AND cs.released_at IS NULL
          AND cl.candidate_id = cs.candidate_id
          AND cl.agent_id = cs.agent_id
          AND cl.called_at >= cs.claimed_at
    `, '042b backfill call_logs.claim_session_id');
    await safeUpdate(`
        UPDATE communications cm SET claim_session_id = cs.id
        FROM claim_sessions cs
        WHERE cm.claim_session_id IS NULL
          AND cs.released_at IS NULL
          AND cm.direction = 'outbound'
          AND cm.sender_type = 'agent'
          AND cm.sent_by = cs.agent_id
          AND cm.candidate_id = cs.candidate_id
          AND cm.sent_at >= cs.claimed_at
    `, '042b backfill communications.claim_session_id');

    // ── Migration 043: user_notifications (admin → agent nudges) ─────────────
    // First PERSISTED per-user notification store (GET /api/notifications is
    // otherwise derived read-only signals). Powers the admin "nudge a
    // low-engagement agent" action: row here + live socket emit to agent:{id}.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS user_notifications (
            id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            type       VARCHAR(32)  NOT NULL DEFAULT 'nudge',
            title      VARCHAR(200) NOT NULL,
            body       TEXT,
            link       TEXT,
            created_by UUID         REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            read_at    TIMESTAMPTZ
        )
    `, '043 user_notifications table');
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, created_at DESC)`,
        '043 idx_user_notifications_user'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications(user_id) WHERE read_at IS NULL`,
        '043 idx_user_notifications_unread'
    );

    // ── Migration 044: engagement_targets (per-agent daily goals) ────────────
    // Admin-set daily expectations (calls / messages / pipeline actions) that
    // power the target-progress bars on the Engagement scorecards — the
    // "evaluate work against a known goal" half of the claim-aware stats.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS engagement_targets (
            user_id        UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            daily_calls    INT          NOT NULL DEFAULT 0,
            daily_messages INT          NOT NULL DEFAULT 0,
            daily_actions  INT          NOT NULL DEFAULT 0,
            updated_by     UUID         REFERENCES users(id) ON DELETE SET NULL,
            updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, '044 engagement_targets table');

    // ── Migration 045: pending_messages (deliver-on-reply queue) ─────────────
    // WhatsApp drops free-form messages outside the 24h customer-service
    // window. Instead of hard-failing those sends, we park them here and flush
    // them the moment the candidate next messages in (the inbound sync hook
    // calls services/pendingMessages.flushPendingForCandidate). communication_id
    // points at the original transcript row so the same bubble upgrades from
    // "queued" to real delivery ticks once the flush send succeeds.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS pending_messages (
            id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            candidate_id     UUID        NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
            communication_id UUID,
            kind             TEXT        NOT NULL DEFAULT 'agent',
            message          TEXT        NOT NULL,
            message_type     TEXT        DEFAULT 'text',
            media_url        TEXT,
            filename         TEXT,
            status           TEXT        NOT NULL DEFAULT 'pending',
            attempts         INT         NOT NULL DEFAULT 0,
            created_by       UUID,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            sending_at       TIMESTAMPTZ,
            sent_at          TIMESTAMPTZ,
            expires_at       TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
        )
    `, '045 pending_messages table');
    // sending_at lets the flusher reclaim rows orphaned in 'sending' when the
    // process died mid-send (a routine Cloud Run redeploy) — without it the
    // queued message would be lost forever.
    await safeAlter(
        `ALTER TABLE pending_messages ADD COLUMN IF NOT EXISTS sending_at TIMESTAMPTZ`,
        '045 pending_messages.sending_at'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_pending_messages_candidate ON pending_messages(candidate_id, status)`,
        '045 idx_pending_messages_candidate'
    );

    // ── Migration 046: users.approved (registration approval gate) ───────────
    // Self-registration must NOT let anyone pick their own role (privilege
    // escalation). New sign-ups are created approved=false + is_active=false and
    // an admin approves + assigns the real role. Existing users default to true
    // so nobody is locked out by this deploy.
    await safeAlter(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT true`,
        '046 users.approved'
    );

    // ── Migration 047: candidates soft-remove (reject & remove quick action) ──
    // The "Reject & remove" quick action hides a candidate from every list while
    // keeping the row for records/audit (reversible by an admin). Distinct from
    // 'Not interested' which parks the candidate in future_pool (re-engageable).
    await safeAlter(
        `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ`,
        '047 candidates.removed_at'
    );
    await safeAlter(
        `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS removed_by UUID`,
        '047 candidates.removed_by'
    );
    await safeAlter(
        `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS removed_reason TEXT`,
        '047 candidates.removed_reason'
    );
    await safeAlter(
        `CREATE INDEX IF NOT EXISTS idx_candidates_removed_at ON candidates(removed_at) WHERE removed_at IS NOT NULL`,
        '047 idx_candidates_removed_at'
    );

    // ── Migration 048: new permission sections (engagement, control_tower) ────
    // These pages existed but were gated under communications/projects, so they
    // never appeared as their own rows in the Edit-User permission matrix.
    await safeUpdate(`
        INSERT INTO sections (key, name, icon, description, sort_order) VALUES
            ('engagement',    'Engagement',    'Activity', 'Re-engagement, scorecards and agent activity', 85),
            ('control_tower', 'Control Tower', 'Radar',    'Live recruitment ops overview',                55)
        ON CONFLICT (key) DO NOTHING
    `, '048 seed engagement + control_tower sections');

    // ── Migration 049: permission_templates (reusable section-permission presets) ──
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS permission_templates (
            id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            name        VARCHAR(120) NOT NULL UNIQUE,
            description TEXT,
            permissions JSONB        NOT NULL,
            created_by  UUID         REFERENCES users(id) ON DELETE SET NULL,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, '049 permission_templates table');

    // ── Migration 050: one-shot backfill for permission OVERRIDE semantics ────
    // effectiveSectionPerms() changed from additive (baseline OR custom) to
    // override (custom row wins verbatim). Existing custom rows stored only the
    // *extras* beyond baseline, so under override they'd silently DROP baseline
    // access. Rewrite each existing custom row to its current effective value
    // (baseline OR existing) ONCE, so the semantic flip preserves access. Guarded
    // by a marker so a re-run can never re-inflate permissions an admin later
    // revoked through the new full-control UI.
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS migration_markers (
            key        TEXT        PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `, 'migration_markers table');
    try {
        const BACKFILL_KEY = 'perm_override_backfill_v1';
        const already = await query('SELECT 1 FROM migration_markers WHERE key = $1', [BACKFILL_KEY]);
        if (already.rows.length === 0) {
            const { roleDefault } = require('../middleware/sections');
            const rowsRes = await query(`
                SELECT usp.user_id, u.role, usp.section_key,
                       usp.can_view, usp.can_create, usp.can_edit, usp.can_delete
                FROM user_section_permissions usp
                JOIN users u ON u.id = usp.user_id
                WHERE u.role <> 'admin'
            `, []);
            let changed = 0;
            for (const r of rowsRes.rows) {
                const base = roleDefault(r.role, r.section_key);
                const eff = {
                    can_view:   !!base.can_view   || !!r.can_view,
                    can_create: !!base.can_create || !!r.can_create,
                    can_edit:   !!base.can_edit   || !!r.can_edit,
                    can_delete: !!base.can_delete || !!r.can_delete,
                };
                if (eff.can_view !== r.can_view || eff.can_create !== r.can_create ||
                    eff.can_edit !== r.can_edit || eff.can_delete !== r.can_delete) {
                    await query(
                        `UPDATE user_section_permissions
                         SET can_view = $3, can_create = $4, can_edit = $5, can_delete = $6, updated_at = NOW()
                         WHERE user_id = $1 AND section_key = $2`,
                        [r.user_id, r.section_key, eff.can_view, eff.can_create, eff.can_edit, eff.can_delete]
                    );
                    changed++;
                }
            }
            await query('INSERT INTO migration_markers (key) VALUES ($1) ON CONFLICT DO NOTHING', [BACKFILL_KEY]);
            logger.info(`  migration: OK  — 050 perm override backfill (${rowsRes.rows.length} rows scanned, ${changed} rewritten)`);
        } else {
            logger.info('  migration: skip — 050 perm override backfill (already applied)');
        }
    } catch (err) {
        logger.warn(`  migration: WARN — 050 perm override backfill: ${err.message.split('\n')[0]}`);
    }

    // ── Migration 051: remove the Marketing Hub permission section ────────────
    // The Marketing Hub feature was removed from the app. Deleting the section
    // row makes it disappear from the Edit-User permission matrix and the nav;
    // the FK cascade clears any user_section_permissions rows that referenced it.
    // The lead_* data tables are deliberately KEPT (the 3CX call webhook still
    // writes to lead_call_events / marketing_leads).
    await safeUpdate(
        `DELETE FROM sections WHERE key = 'marketing_hub'`,
        '051 remove marketing_hub section'
    );

    // ── Migration 052: unlink jobs when a project is deleted ──────────────────
    // Deleting a project now DETACHES its jobs (project_id → NULL) instead of
    // cascade-deleting them, so the jobs (and their applications / interviews)
    // survive. jobs.project_id was NOT NULL with an ON DELETE RESTRICT FK
    // (enforce_project_job_relationship.sql), which made the delete handler's
    // `UPDATE jobs SET project_id = NULL` 500 on the not-null constraint — i.e.
    // deleting any project that had jobs always failed. Make the column nullable
    // and switch the FK to ON DELETE SET NULL.
    await safeAlter(`ALTER TABLE jobs ALTER COLUMN project_id DROP NOT NULL`, '052 jobs.project_id drop NOT NULL');
    await safeAlter(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_project_id_fkey`, '052 drop jobs_project_id_fkey');
    await safeAlter(
        `ALTER TABLE jobs ADD CONSTRAINT jobs_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL`,
        '052 re-add jobs_project_id_fkey ON DELETE SET NULL'
    );

    // ── Migration 053: structured Future Pool categorization on candidates ────
    // The calling console's "Not interested" quick action became a structured
    // "Future Pool" action with three categories: future_project (a desired but
    // not-yet-created project — captures project name / job title / country),
    // overage (over the age limit, kept for future roles) and not_interested
    // (declined current projects). All three still move the candidate to the
    // canonical future_pool status (apps rejected, re-engageable); these columns
    // record WHY so pooled candidates are findable + assignable later. The decline
    // call log is now action_type = 'future_pool' (no new call_logs column — the
    // existing reason VARCHAR(48) holds a short summary).
    for (const [sql, label] of [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS future_pool_category     VARCHAR(32)`,  '053 candidates.future_pool_category'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS future_pool_project_name VARCHAR(160)`, '053 candidates.future_pool_project_name'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS future_pool_job_title    VARCHAR(160)`, '053 candidates.future_pool_job_title'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS future_pool_country      VARCHAR(100)`, '053 candidates.future_pool_country'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS future_pool_note         TEXT`,         '053 candidates.future_pool_note'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS future_pool_at           TIMESTAMPTZ`,  '053 candidates.future_pool_at'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS future_pool_by           UUID`,         '053 candidates.future_pool_by'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_future_pool_category ON candidates(future_pool_category) WHERE future_pool_category IS NOT NULL`, '053 idx_candidates_future_pool_category'],
    ]) {
        await safeAlter(sql, label);
    }

    logger.info('✅ Startup migrations complete.');
}

module.exports = { applyMigrations };
