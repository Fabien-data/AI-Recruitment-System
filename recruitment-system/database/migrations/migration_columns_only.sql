-- Column additions only — run as recruitment_user who now owns these tables
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
