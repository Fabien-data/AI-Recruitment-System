-- Migration Helper Script
-- This script helps migrate existing jobs to the new project-job hierarchy
-- Run this BEFORE applying the enforce_project_job_relationship.sql migration

-- ==========================================
-- STEP 1: Identify Orphaned Jobs
-- ==========================================
-- Check how many jobs don't have a project_id
SELECT 
    COUNT(*) as orphaned_jobs_count,
    STRING_AGG(DISTINCT category, ', ') as categories
FROM jobs 
WHERE project_id IS NULL;

-- List all orphaned jobs with details
SELECT 
    id,
    title,
    category,
    status,
    positions_available,
    created_at
FROM jobs 
WHERE project_id IS NULL
ORDER BY created_at DESC;

-- ==========================================
-- STEP 2: Create Default Project (if needed)
-- ==========================================
-- Only run this if you have orphaned jobs and want to assign them all to a default project
INSERT INTO projects (
    title,
    client_name,
    industry_type,
    description,
    countries,
    status,
    priority,
    total_positions,
    created_at,
    updated_at
)
VALUES (
    'General Recruitment Pool',
    'Various Clients',
    'General',
    'Default project for positions that were created before the project-job hierarchy was established.',
    '["UAE", "Qatar", "Oman", "Bahrain", "Saudi Arabia", "Kuwait"]'::jsonb,
    'active',
    'normal',
    0,
    NOW(),
    NOW()
)
RETURNING id, title;

-- ⚠️ IMPORTANT: Note the ID returned above and use it in the next step

-- ==========================================
-- STEP 3: Assign Orphaned Jobs to Default Project
-- ==========================================
-- Replace <DEFAULT_PROJECT_ID> with the ID from Step 2
-- BEFORE running, verify the project ID is correct:
SELECT id, title FROM projects WHERE title = 'General Recruitment Pool';

-- Then update orphaned jobs:
UPDATE jobs 
SET project_id = '<DEFAULT_PROJECT_ID>'  -- ⚠️ REPLACE THIS
WHERE project_id IS NULL;

-- Verify the update:
SELECT COUNT(*) as jobs_updated 
FROM jobs 
WHERE project_id = '<DEFAULT_PROJECT_ID>';

-- ==========================================
-- STEP 4: Alternative - Assign Jobs by Category
-- ==========================================
-- If you prefer to create different projects for different categories:

-- Create projects for each major category
DO $$
DECLARE
    security_project_id UUID;
    hospitality_project_id UUID;
    manufacturing_project_id UUID;
    healthcare_project_id UUID;
BEGIN
    -- Create Security Project
    INSERT INTO projects (title, client_name, industry_type, countries, status, priority)
    VALUES ('Security Positions', 'Various Clients', 'General', '["UAE", "Qatar"]'::jsonb, 'active', 'normal')
    RETURNING id INTO security_project_id;
    
    UPDATE jobs SET project_id = security_project_id 
    WHERE category ILIKE '%security%' AND project_id IS NULL;
    
    -- Create Hospitality Project
    INSERT INTO projects (title, client_name, industry_type, countries, status, priority)
    VALUES ('Hospitality Positions', 'Various Clients', 'Hospitality', '["UAE", "Qatar"]'::jsonb, 'active', 'normal')
    RETURNING id INTO hospitality_project_id;
    
    UPDATE jobs SET project_id = hospitality_project_id 
    WHERE category ILIKE '%hospitality%' AND project_id IS NULL;
    
    -- Create Manufacturing Project
    INSERT INTO projects (title, client_name, industry_type, countries, status, priority)
    VALUES ('Manufacturing Positions', 'Various Clients', 'Manufacturing', '["UAE"]'::jsonb, 'active', 'normal')
    RETURNING id INTO manufacturing_project_id;
    
    UPDATE jobs SET project_id = manufacturing_project_id 
    WHERE category ILIKE '%manufacturing%' AND project_id IS NULL;
    
    -- Create Healthcare Project
    INSERT INTO projects (title, client_name, industry_type, countries, status, priority)
    VALUES ('Healthcare Positions', 'Various Clients', 'Healthcare', '["UAE", "Qatar"]'::jsonb, 'active', 'normal')
    RETURNING id INTO healthcare_project_id;
    
    UPDATE jobs SET project_id = healthcare_project_id 
    WHERE category ILIKE '%healthcare%' OR category ILIKE '%nursing%' AND project_id IS NULL;
    
    RAISE NOTICE 'Projects created and jobs assigned by category';
END $$;

-- ==========================================
-- STEP 5: Final Verification
-- ==========================================
-- Check that NO jobs are without a project
SELECT COUNT(*) as remaining_orphaned_jobs 
FROM jobs 
WHERE project_id IS NULL;

-- This should return 0. If it returns > 0, you need to handle those jobs before proceeding.

-- Check project-job distribution
SELECT 
    p.title as project_title,
    p.client_name,
    COUNT(j.id) as job_count,
    SUM(j.positions_available) as total_positions,
    STRING_AGG(DISTINCT j.category, ', ') as categories
FROM projects p
LEFT JOIN jobs j ON p.id = j.project_id
GROUP BY p.id, p.title, p.client_name
ORDER BY job_count DESC;

-- ==========================================
-- STEP 6: Update Project Position Counts
-- ==========================================
-- After assigning jobs to projects, update the total_positions field

UPDATE projects p
SET total_positions = (
    SELECT COALESCE(SUM(j.positions_available), 0)
    FROM jobs j
    WHERE j.project_id = p.id
),
filled_positions = (
    SELECT COALESCE(SUM(j.positions_filled), 0)
    FROM jobs j
    WHERE j.project_id = p.id
)
WHERE p.id IN (
    SELECT DISTINCT project_id 
    FROM jobs 
    WHERE project_id IS NOT NULL
);

-- Verify position counts
SELECT 
    p.title,
    p.total_positions,
    p.filled_positions,
    COUNT(j.id) as actual_job_count,
    SUM(j.positions_available) as calculated_total
FROM projects p
LEFT JOIN jobs j ON p.id = j.project_id
GROUP BY p.id, p.title, p.total_positions, p.filled_positions
HAVING p.total_positions != COALESCE(SUM(j.positions_available), 0);

-- ==========================================
-- STEP 7: Ready for Migration
-- ==========================================
-- Once all the above checks pass (no orphaned jobs remain),
-- you can safely run: enforce_project_job_relationship.sql

-- Final check:
SELECT 
    'Ready for migration' as status,
    COUNT(CASE WHEN project_id IS NULL THEN 1 END) as orphaned_jobs,
    COUNT(CASE WHEN project_id IS NOT NULL THEN 1 END) as linked_jobs,
    COUNT(*) as total_jobs
FROM jobs;

-- ✅ If orphaned_jobs = 0, you're ready to proceed with the migration!
