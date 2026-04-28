-- Migration 010: Update user roles and add candidate photo_url
-- Run this once on production database

-- 1. Rename role values: recruiter → project_handler, supervisor → sourcing_department
UPDATE users SET role = 'project_handler'       WHERE role = 'recruiter';
UPDATE users SET role = 'sourcing_department'   WHERE role = 'supervisor';

-- 2. Add photo_url column to candidates (safe to run multiple times via ALTER … IF NOT EXISTS)
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);

-- 3. Verify
SELECT role, COUNT(*) FROM users GROUP BY role ORDER BY role;
