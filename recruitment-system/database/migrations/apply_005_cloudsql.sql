-- ================================================================
-- Migration 005 (PostgreSQL): Add Extra Columns to Candidates Table
-- Target: Cloud SQL PostgreSQL (dewan-chatbot-1234:us-central1:recruitment-db)
-- Purpose: Support chatbot-sourced candidates with richer data
-- ================================================================

-- Connect to the correct database first
\c recruitment_db;

-- Add skills field (plain text - comma separated from chatbot)
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills TEXT;

-- Add experience years
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years SMALLINT;

-- Add highest qualification
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255);

-- Add whatsapp_phone (normalized E.164 format)
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(50);

-- Add chatbot_ref (maps to Python chatbot candidate ID)
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS chatbot_ref VARCHAR(100);

-- Add ad_ref (which Meta ad brought this candidate)
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ad_ref VARCHAR(100);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_candidates_whatsapp ON candidates(whatsapp_phone);
CREATE INDEX IF NOT EXISTS idx_candidates_ad_ref   ON candidates(ad_ref);

-- Verify columns were added
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'candidates'
ORDER BY ordinal_position;
