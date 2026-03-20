-- Fix table ownership and add missing columns
-- Must run as postgres (Cloud SQL superuser)
ALTER TABLE candidates OWNER TO recruitment_user;
ALTER TABLE applications OWNER TO recruitment_user;

-- Now recruitment_user can ALTER these tables on each startup
-- The server's auto-migration will handle the column adds from here.
-- But add them here too for immediate effect:
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years SMALLINT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_phone VARCHAR(50);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS chatbot_ref VARCHAR(100);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ad_ref VARCHAR(100);
CREATE INDEX IF NOT EXISTS idx_candidates_whatsapp ON candidates(whatsapp_phone);
CREATE INDEX IF NOT EXISTS idx_candidates_ad_ref ON candidates(ad_ref);

ALTER TABLE applications ADD COLUMN IF NOT EXISTS certification_notes TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS transfer_reason TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_app_transferred ON applications(transferred_from_job_id);
