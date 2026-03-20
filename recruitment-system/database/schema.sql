-- Recruitment System Database Schema
-- PostgreSQL 14+

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For fuzzy text matching

-- ===============================================
-- CANDIDATES TABLE
-- ===============================================
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    email TEXT,
    source TEXT NOT NULL, -- 'whatsapp', 'email', 'messenger', 'phone', 'walkin', 'web'
    preferred_language TEXT DEFAULT 'en', -- 'en', 'si', 'ta'
    status TEXT DEFAULT 'new', -- 'new', 'screening', 'interview', 'hired', 'rejected', 'future_pool'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_contact_at TIMESTAMP,
    notes TEXT,
    tags TEXT[], -- Array of tags like ['urgent', 'excellent_english', 'height_borderline']
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for performance
CREATE INDEX idx_candidates_phone ON candidates(phone);
CREATE INDEX idx_candidates_email ON candidates(email);
CREATE INDEX idx_candidates_status ON candidates(status);
CREATE INDEX idx_candidates_source ON candidates(source);
CREATE INDEX idx_candidates_created_at ON candidates(created_at DESC);
CREATE INDEX idx_candidates_name_trgm ON candidates USING gin(name gin_trgm_ops);

-- ===============================================
-- CV_FILES TABLE
-- ===============================================
CREATE TABLE cv_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT, -- 'pdf', 'doc', 'docx', 'image'
    ocr_status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    ocr_text TEXT,
    parsed_data JSONB DEFAULT '{}'::jsonb, -- Structured extraction from LLM
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    is_primary BOOLEAN DEFAULT false
);

CREATE INDEX idx_cv_files_candidate ON cv_files(candidate_id);
CREATE INDEX idx_cv_files_ocr_status ON cv_files(ocr_status);

-- ===============================================
-- JOBS TABLE
-- ===============================================
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    category TEXT NOT NULL, -- 'security', 'hospitality', 'manufacturing', etc.
    description TEXT,
    requirements JSONB NOT NULL DEFAULT '{}'::jsonb, -- Min/max criteria
    wiggle_room JSONB DEFAULT '{}'::jsonb, -- Tolerance settings
    status TEXT DEFAULT 'active', -- 'active', 'paused', 'closed', 'filled'
    positions_available INTEGER DEFAULT 1,
    positions_filled INTEGER DEFAULT 0,
    salary_range TEXT,
    location TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID, -- Reference to users table
    deadline DATE
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_category ON jobs(category);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- ===============================================
-- PROJECTS TABLE
-- ===============================================
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    client_name TEXT NOT NULL,
    industry_type TEXT NOT NULL, -- 'Hypermarket', 'Restaurant', 'Construction', 'Healthcare', 'Hospitality', etc.
    description TEXT,
    countries JSONB NOT NULL DEFAULT '[]'::jsonb, -- ['UAE', 'Qatar', 'Oman', 'Bahrain', 'Saudi Arabia', 'Kuwait']
    status TEXT DEFAULT 'planning', -- 'planning', 'active', 'on_hold', 'completed', 'cancelled'
    priority TEXT DEFAULT 'normal', -- 'normal', 'high', 'urgent'
    total_positions INTEGER DEFAULT 0,
    filled_positions INTEGER DEFAULT 0,
    start_date DATE,
    interview_date DATE,
    end_date DATE,
    benefits JSONB DEFAULT '{}'::jsonb, -- { accommodation: true, transport: true, meals: true, visa: true, ticket: true }
    salary_info JSONB DEFAULT '{}'::jsonb, -- { min: 1500, max: 2000, currency: 'AED' }
    contact_info JSONB DEFAULT '{}'::jsonb, -- { whatsapp: '', email: '', address: '' }
    requirements JSONB DEFAULT '{}'::jsonb, -- Project-specific requirements
    metadata JSONB DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_priority ON projects(priority);
CREATE INDEX idx_projects_client_name ON projects(client_name);
CREATE INDEX idx_projects_interview_date ON projects(interview_date);
CREATE INDEX idx_projects_created_at ON projects(created_at DESC);
CREATE INDEX idx_projects_industry ON projects(industry_type);

-- ===============================================
-- PROJECT_ASSIGNMENTS TABLE (User-Project Mapping)
-- ===============================================
CREATE TABLE project_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL, -- 'owner', 'handler', 'agent', 'officer'
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_project_assignments_unique ON project_assignments(project_id, user_id, role);
CREATE INDEX idx_project_assignments_project ON project_assignments(project_id);
CREATE INDEX idx_project_assignments_user ON project_assignments(user_id);

-- Add project_id to jobs table (REQUIRED - Jobs must belong to a project)
ALTER TABLE jobs ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT;
CREATE INDEX idx_jobs_project ON jobs(project_id);

-- ===============================================
-- APPLICATIONS TABLE
-- ===============================================
CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'applied', -- 'applied', 'screening', 'certified', 'interview_scheduled', 'interviewed', 'selected', 'rejected', 'placed'
    match_score DECIMAL(3,2), -- 0.00 to 1.00
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    certified_at TIMESTAMP,
    certified_by UUID, -- Reference to users table
    interview_datetime TIMESTAMP,
    interview_location TEXT,
    interview_notes TEXT,
    rejection_reason TEXT,
    alternative_jobs_suggested UUID[], -- Array of job IDs
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_applications_candidate ON applications(candidate_id);
CREATE INDEX idx_applications_job ON applications(job_id);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_match_score ON applications(match_score DESC);
CREATE UNIQUE INDEX idx_applications_unique ON applications(candidate_id, job_id);

-- ===============================================
-- COMMUNICATIONS TABLE
-- ===============================================
CREATE TABLE communications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, -- 'whatsapp', 'messenger', 'email', 'sms', 'phone', 'in_person'
    direction TEXT NOT NULL, -- 'inbound', 'outbound'
    message_type TEXT, -- 'text', 'voice', 'document', 'image'
    content TEXT,
    metadata JSONB DEFAULT '{}'::jsonb, -- Store additional data like call duration, message IDs, etc.
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    responded_at TIMESTAMP,
    sent_by UUID, -- Reference to users table (for outbound)
    call_recording_url TEXT,
    attachments TEXT[] -- Array of file URLs
);

CREATE INDEX idx_communications_candidate ON communications(candidate_id);
CREATE INDEX idx_communications_channel ON communications(channel);
CREATE INDEX idx_communications_sent_at ON communications(sent_at DESC);

-- ===============================================
-- USERS TABLE (Recruiters/Handlers)
-- ===============================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'recruiter', -- 'admin', 'recruiter', 'supervisor'
    phone TEXT,
    is_active BOOLEAN DEFAULT true,
    assigned_jobs UUID[], -- Array of job IDs
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- ===============================================
-- INTERVIEW_SCHEDULES TABLE
-- ===============================================
CREATE TABLE interview_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    scheduled_datetime TIMESTAMP NOT NULL,
    location TEXT,
    interviewer_id UUID REFERENCES users(id),
    duration_minutes INTEGER DEFAULT 30,
    status TEXT DEFAULT 'scheduled', -- 'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'
    confirmation_sent_at TIMESTAMP,
    reminder_sent_at TIMESTAMP,
    completed_at TIMESTAMP,
    feedback TEXT,
    rating INTEGER, -- 1-5 scale
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_interview_schedules_application ON interview_schedules(application_id);
CREATE INDEX idx_interview_schedules_datetime ON interview_schedules(scheduled_datetime);
CREATE INDEX idx_interview_schedules_status ON interview_schedules(status);

-- ===============================================
-- TRANSFER_REQUESTS TABLE
-- ===============================================
CREATE TABLE transfer_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    from_job_id UUID REFERENCES jobs(id),
    to_job_id UUID NOT NULL REFERENCES jobs(id),
    requested_by UUID NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP,
    review_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transfer_requests_candidate ON transfer_requests(candidate_id);
CREATE INDEX idx_transfer_requests_status ON transfer_requests(status);

-- ===============================================
-- AUDIT_LOGS TABLE
-- ===============================================
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action TEXT NOT NULL, -- 'create', 'update', 'delete', 'view', 'export'
    entity_type TEXT NOT NULL, -- 'candidate', 'job', 'application', etc.
    entity_id UUID,
    changes JSONB, -- Store old and new values
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- ===============================================
-- TRANSLATIONS TABLE
-- ===============================================
CREATE TABLE translations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key TEXT NOT NULL,
    language TEXT NOT NULL, -- 'en', 'si', 'ta'
    value TEXT NOT NULL,
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key, language)
);

CREATE INDEX idx_translations_key ON translations(key);
CREATE INDEX idx_translations_language ON translations(language);

-- ===============================================
-- NOTIFICATION_QUEUE TABLE
-- ===============================================
CREATE TABLE notification_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, -- 'whatsapp', 'sms', 'email'
    template TEXT NOT NULL,
    variables JSONB DEFAULT '{}'::jsonb,
    scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending', -- 'pending', 'sent', 'failed', 'cancelled'
    sent_at TIMESTAMP,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notification_queue_status ON notification_queue(status);
CREATE INDEX idx_notification_queue_scheduled ON notification_queue(scheduled_for);

-- ===============================================
-- FUNCTIONS AND TRIGGERS
-- ===============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_candidates_updated_at BEFORE UPDATE ON candidates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to check for duplicate candidates
CREATE OR REPLACE FUNCTION check_duplicate_candidate()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM candidates 
        WHERE (phone = NEW.phone OR email = NEW.email) 
        AND id != NEW.id
    ) THEN
        RAISE EXCEPTION 'Duplicate candidate with same phone or email exists';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_duplicate_before_insert BEFORE INSERT ON candidates
    FOR EACH ROW EXECUTE FUNCTION check_duplicate_candidate();

-- ===============================================
-- SAMPLE DATA FOR TESTING
-- ===============================================

-- Insert sample job categories
INSERT INTO jobs (title, category, requirements, wiggle_room, status, positions_available) VALUES
('Security Guard - Dubai', 'security', 
    '{"min_height_cm": 170, "max_height_cm": 190, "required_languages": ["English"], "min_age": 21, "max_age": 45, "licenses": ["security_license"]}'::jsonb,
    '{"height_tolerance_cm": 5, "age_tolerance_years": 2}'::jsonb,
    'active', 10
),
('Hospitality Staff - Qatar', 'hospitality',
    '{"min_height_cm": 160, "required_languages": ["English"], "min_age": 21, "max_age": 40, "experience_years": 2}'::jsonb,
    '{"height_tolerance_cm": 3, "experience_tolerance_years": 1}'::jsonb,
    'active', 5
),
('Factory Worker - Saudi Arabia', 'manufacturing',
    '{"required_languages": ["English"], "min_age": 21, "max_age": 45}'::jsonb,
    '{"age_tolerance_years": 3}'::jsonb,
    'active', 20
);

-- Insert sample translations
INSERT INTO translations (key, language, value, context) VALUES
('greeting', 'en', 'Hello! Welcome to our recruitment agency.', 'chatbot'),
('greeting', 'si', 'ආයුබෝවන්! අපගේ රැකියා නියෝජිතායතනය වෙත සාදරයෙන් පිළිගනිමු.', 'chatbot'),
('greeting', 'ta', 'வணக்கம்! எங்கள் ஆட்சேர்ப்பு நிறுவனத்திற்கு வரவேற்கிறோம்.', 'chatbot'),
('ask_name', 'en', 'What is your name?', 'chatbot'),
('ask_name', 'si', 'ඔබේ නම කුමක්ද?', 'chatbot'),
('ask_name', 'ta', 'உங்கள் பெயர் என்ன?', 'chatbot'),
('ask_position', 'en', 'Which position are you interested in?', 'chatbot'),
('ask_position', 'si', 'ඔබ කැමති රැකියාව කුමක්ද?', 'chatbot'),
('ask_position', 'ta', 'நீங்கள் எந்த வேலைக்கு ஆர்வமாக உள்ளீர்கள்?', 'chatbot');

COMMENT ON TABLE candidates IS 'Stores candidate information from all sources';
COMMENT ON TABLE cv_files IS 'Stores CV file references and parsed data';
COMMENT ON TABLE jobs IS 'Job listings with requirements and tolerances';
COMMENT ON TABLE applications IS 'Links candidates to jobs with screening status';
COMMENT ON TABLE communications IS 'All communication history across channels';
COMMENT ON TABLE users IS 'System users (recruiters, admins)';
COMMENT ON TABLE interview_schedules IS 'Interview scheduling and tracking';
COMMENT ON TABLE transfer_requests IS 'Candidate transfer requests between jobs';
COMMENT ON TABLE audit_logs IS 'Security and compliance audit trail';
COMMENT ON TABLE translations IS 'Multilingual content storage';
COMMENT ON TABLE notification_queue IS 'Queued notifications for sending';
