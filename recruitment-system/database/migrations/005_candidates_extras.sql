-- ================================================================
-- Migration 005: Add Extra Columns to Candidates Table
-- Purpose: Support chatbot-sourced candidates with richer data
-- Run: Execute on MySQL (Serverbyt) and PostgreSQL (local dev)
-- ================================================================

-- ---------------------------------------------------------------
-- MySQL version
-- ---------------------------------------------------------------

-- Add skills field (plain text - comma separated from chatbot)
ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS skills             TEXT          NULL
        COMMENT 'Skills extracted from CV or chatbot intake'
    AFTER notes;

-- Add experience years
ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS experience_years   SMALLINT      NULL
        COMMENT 'Years of relevant experience'
    AFTER skills;

-- Add highest qualification
ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255) NULL
        COMMENT 'Highest academic/professional qualification'
    AFTER experience_years;

-- Add whatsapp_phone (normalized E.164 format)
ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS whatsapp_phone    VARCHAR(50)   NULL
        COMMENT 'Normalized WhatsApp phone in E.164 format e.g. +94771234567'
    AFTER phone;

-- Add chatbot_ref (maps to Python chatbot candidate ID)
ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS chatbot_ref       VARCHAR(100)  NULL
        COMMENT 'Internal chatbot candidate ID for cross-system linking'
    AFTER whatsapp_phone;

-- Add ad_ref (which Meta ad brought this candidate)
ALTER TABLE candidates
    ADD COLUMN IF NOT EXISTS ad_ref            VARCHAR(100)  NULL
        COMMENT 'Ad tracking ref code e.g. job_abc123 from Meta Click-to-WhatsApp'
    AFTER chatbot_ref;

-- Add index on whatsapp_phone for fast lookup during intake upsert
ALTER TABLE candidates
    ADD INDEX IF NOT EXISTS idx_candidates_whatsapp (whatsapp_phone);

-- Add index on ad_ref for analytics queries
ALTER TABLE candidates
    ADD INDEX IF NOT EXISTS idx_candidates_ad_ref (ad_ref);


-- ---------------------------------------------------------------
-- PostgreSQL compatible version (Cloud SQL / Supabase)
-- Applied 2026-03-04 via gcloud sql import sql as recruitment_user
-- (Ownership of candidates + applications transferred to recruitment_user first)
-- ---------------------------------------------------------------
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years SMALLINT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(50);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS chatbot_ref VARCHAR(100);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ad_ref VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_candidates_whatsapp ON candidates(whatsapp_phone);
CREATE INDEX IF NOT EXISTS idx_candidates_ad_ref   ON candidates(ad_ref);
