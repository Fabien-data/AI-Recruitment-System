-- Migration: Enforce Project-Job Relationship
-- Makes project_id mandatory for all jobs
-- Jobs must belong to a project

-- Step 1: Check for any jobs without a project_id
-- You may need to assign these to a default project first
SELECT id, title, category FROM jobs WHERE project_id IS NULL;

-- Step 2: Create a default "General" project if needed for orphaned jobs
-- Uncomment and run if you have jobs without projects
-- INSERT INTO projects (title, client_name, industry_type, description, status, priority)
-- VALUES ('General Recruitment', 'Various Clients', 'General', 'Default project for unassigned positions', 'active', 'normal')
-- RETURNING id;

-- Step 3: Assign orphaned jobs to the default project (replace <PROJECT_ID> with actual ID)
-- UPDATE jobs SET project_id = '<PROJECT_ID>' WHERE project_id IS NULL;

-- Step 4: Make project_id NOT NULL
ALTER TABLE jobs 
ALTER COLUMN project_id SET NOT NULL;

-- Step 5: Add check constraint to ensure project exists
-- This constraint is already enforced by the foreign key, but this makes it explicit
ALTER TABLE jobs
DROP CONSTRAINT IF EXISTS jobs_project_id_fkey,
ADD CONSTRAINT jobs_project_id_fkey 
  FOREIGN KEY (project_id) 
  REFERENCES projects(id) 
  ON DELETE RESTRICT; -- Prevent deleting projects with active jobs

-- Step 6: Update the ON DELETE behavior for better data integrity
-- Jobs should not be orphaned when a project is deleted
COMMENT ON CONSTRAINT jobs_project_id_fkey ON jobs IS 
'Jobs must belong to a project. Projects with jobs cannot be deleted unless jobs are reassigned or deleted first.';

-- Step 7: Create index if not exists
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);

-- Verification query
SELECT 
    p.title as project_title,
    COUNT(j.id) as job_count,
    COUNT(DISTINCT j.category) as unique_categories
FROM projects p
LEFT JOIN jobs j ON p.id = j.project_id
GROUP BY p.id, p.title
ORDER BY job_count DESC;
