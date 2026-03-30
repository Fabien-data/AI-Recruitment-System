-- Add AI supervisor human-intervention panic button fields

-- PostgreSQL
ALTER TABLE candidates
ADD COLUMN IF NOT EXISTS intervention_needed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS intervention_reason TEXT;

-- MySQL 8+
-- Run this block on MySQL deployments.
ALTER TABLE candidates
ADD COLUMN IF NOT EXISTS intervention_needed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS intervention_reason TEXT;
