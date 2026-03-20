-- Migration: Add certification and transfer columns to applications table
-- Run this in phpMyAdmin on your youraccount_recruitment database

-- Add certification notes
ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS certification_notes TEXT NULL AFTER certified_by;

-- Add transfer tracking columns
ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS transferred_from_job_id CHAR(36) NULL AFTER certification_notes,
    ADD COLUMN IF NOT EXISTS transfer_reason TEXT NULL AFTER transferred_from_job_id;

-- Add updated_at column (missing from original schema)
ALTER TABLE applications
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER applied_at;

-- Add index for transfer lookups
ALTER TABLE applications
    ADD INDEX IF NOT EXISTS idx_app_transferred (transferred_from_job_id);

-- Verify
DESCRIBE applications;
