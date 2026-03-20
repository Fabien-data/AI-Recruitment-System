-- ================================================================
-- Migration 004: Ad Tracking Table
-- Purpose: Track Meta Click-to-WhatsApp campaigns per job/project
-- Run: Execute on MySQL (Serverbyt) and PostgreSQL (local dev)
-- ================================================================

-- ---------------------------------------------------------------
-- AD_TRACKING TABLE
-- Stores every generated WhatsApp ad link and tracks performance
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_tracking (
    id            CHAR(36)      NOT NULL DEFAULT (UUID()),
    ad_ref        VARCHAR(100)  NOT NULL COMMENT 'Unique short code used in WhatsApp START message e.g. job_abc123',
    job_id        CHAR(36)      NOT NULL,
    project_id    CHAR(36)      NOT NULL,
    campaign_name VARCHAR(255)  NULL     COMMENT 'Optional Meta campaign label e.g. Dubai Security March 2026',
    whatsapp_link TEXT          NOT NULL COMMENT 'Full wa.me deep link with encoded ref',
    clicks        INT           NOT NULL DEFAULT 0 COMMENT 'Number of times the link was clicked (tracked via Meta)',
    conversions   INT           NOT NULL DEFAULT 0 COMMENT 'Number of candidates who completed application via this link',
    is_active     TINYINT(1)    NOT NULL DEFAULT 1,
    created_by    CHAR(36)      NULL,
    created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_ad_ref (ad_ref),
    INDEX idx_ad_job (job_id),
    INDEX idx_ad_project (project_id),
    INDEX idx_ad_active (is_active),

    CONSTRAINT fk_ad_job     FOREIGN KEY (job_id)     REFERENCES jobs(id)     ON DELETE CASCADE,
    CONSTRAINT fk_ad_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------
-- PostgreSQL compatible version (auto-selected by adapter)
-- Uncomment this block if running on PostgreSQL / Supabase
-- ---------------------------------------------------------------
-- CREATE TABLE IF NOT EXISTS ad_tracking (
--     id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
--     ad_ref        VARCHAR(100)  NOT NULL UNIQUE,
--     job_id        UUID          NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
--     project_id    UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
--     campaign_name VARCHAR(255),
--     whatsapp_link TEXT          NOT NULL,
--     clicks        INT           NOT NULL DEFAULT 0,
--     conversions   INT           NOT NULL DEFAULT 0,
--     is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
--     created_by    UUID,
--     created_at    TIMESTAMP     NOT NULL DEFAULT NOW(),
--     updated_at    TIMESTAMP     NOT NULL DEFAULT NOW()
-- );
-- CREATE INDEX idx_ad_job     ON ad_tracking(job_id);
-- CREATE INDEX idx_ad_project ON ad_tracking(project_id);
-- CREATE INDEX idx_ad_ref     ON ad_tracking(ad_ref);
