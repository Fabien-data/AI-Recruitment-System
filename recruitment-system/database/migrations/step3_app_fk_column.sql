-- Add the FK column that was also missing
ALTER TABLE applications ADD COLUMN IF NOT EXISTS transferred_from_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_app_transferred ON applications(transferred_from_job_id);
