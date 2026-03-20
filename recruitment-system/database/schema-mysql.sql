-- Recruitment System Database Schema (MySQL 8.0+)
-- Converted from PostgreSQL for Serverbyt MySQL hosting

-- ===============================================
-- TENANTS TABLE (Multi-tenancy for SaaS)
-- ===============================================
CREATE TABLE IF NOT EXISTS tenants (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    plan VARCHAR(50) DEFAULT 'basic',
    status VARCHAR(50) DEFAULT 'active',
    settings JSON DEFAULT ('{}'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ===============================================
-- CANDIDATES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS candidates (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255),
    source VARCHAR(50) NOT NULL COMMENT 'whatsapp, email, messenger, phone, walkin, web',
    preferred_language VARCHAR(10) DEFAULT 'en' COMMENT 'en, si, ta',
    status VARCHAR(50) DEFAULT 'new' COMMENT 'new, screening, interview, hired, rejected, future_pool',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_contact_at TIMESTAMP NULL,
    notes TEXT,
    tags JSON DEFAULT ('[]'),
    metadata JSON DEFAULT ('{}'),
    FULLTEXT INDEX idx_candidates_name (name),
    INDEX idx_candidates_phone (phone),
    INDEX idx_candidates_status (status),
    INDEX idx_candidates_source (source),
    INDEX idx_candidates_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- CV_FILES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS cv_files (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    file_url TEXT NOT NULL,
    file_name VARCHAR(255),
    file_size INT,
    file_type VARCHAR(50) COMMENT 'pdf, doc, docx, image',
    ocr_status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, processing, completed, failed',
    ocr_text LONGTEXT,
    parsed_data JSON DEFAULT ('{}'),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_cv_candidate (candidate_id),
    INDEX idx_cv_ocr_status (ocr_status)
);

-- ===============================================
-- JOBS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS jobs (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    title VARCHAR(255) NOT NULL,
    category VARCHAR(100) NOT NULL COMMENT 'security, hospitality, manufacturing, etc.',
    description TEXT,
    requirements JSON NOT NULL DEFAULT ('{}'),
    wiggle_room JSON DEFAULT ('{}'),
    status VARCHAR(50) DEFAULT 'active' COMMENT 'active, paused, closed, filled',
    positions_available INT DEFAULT 1,
    positions_filled INT DEFAULT 0,
    salary_range VARCHAR(100),
    location VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by CHAR(36),
    deadline DATE,
    project_id CHAR(36) NOT NULL,
    INDEX idx_jobs_status (status),
    INDEX idx_jobs_category (category),
    INDEX idx_jobs_tenant (tenant_id),
    INDEX idx_jobs_project (project_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- PROJECTS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS projects (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    title VARCHAR(255) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    industry_type VARCHAR(100) NOT NULL COMMENT 'Hypermarket, Restaurant, Construction, Healthcare, Hospitality, etc.',
    description TEXT,
    countries JSON NOT NULL DEFAULT ('[]'),
    status VARCHAR(50) DEFAULT 'planning' COMMENT 'planning, active, on_hold, completed, cancelled',
    priority VARCHAR(50) DEFAULT 'normal' COMMENT 'normal, high, urgent',
    total_positions INT DEFAULT 0,
    filled_positions INT DEFAULT 0,
    start_date DATE,
    interview_date DATE,
    end_date DATE,
    benefits JSON DEFAULT ('{}'),
    salary_info JSON DEFAULT ('{}'),
    contact_info JSON DEFAULT ('{}'),
    requirements JSON DEFAULT ('{}'),
    metadata JSON DEFAULT ('{}'),
    created_by CHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_projects_status (status),
    INDEX idx_projects_priority (priority),
    INDEX idx_projects_client_name (client_name),
    INDEX idx_projects_interview_date (interview_date),
    INDEX idx_projects_industry (industry_type),
    INDEX idx_projects_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- PROJECT_ASSIGNMENTS TABLE (User-Project Mapping)
-- ===============================================
CREATE TABLE IF NOT EXISTS project_assignments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    project_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    role VARCHAR(50) NOT NULL COMMENT 'owner, handler, agent, officer',
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by CHAR(36),
    UNIQUE KEY unique_project_user_role (project_id, user_id, role),
    INDEX idx_proj_assign_project (project_id),
    INDEX idx_proj_assign_user (user_id),
    INDEX idx_proj_assign_tenant (tenant_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- Add foreign key for jobs.project_id (REQUIRED - Jobs must belong to a project)
ALTER TABLE jobs ADD CONSTRAINT fk_jobs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- ===============================================
-- APPLICATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS applications (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    job_id CHAR(36) NOT NULL,
    status VARCHAR(50) DEFAULT 'applied' COMMENT 'applied, screening, certified, interview_scheduled, interviewed, selected, rejected, placed',
    match_score DECIMAL(5,2),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    certified_at TIMESTAMP NULL,
    certified_by CHAR(36),
    interview_datetime TIMESTAMP NULL,
    interview_location TEXT,
    interview_notes TEXT,
    rejection_reason TEXT,
    alternative_jobs_suggested JSON DEFAULT ('[]'),
    metadata JSON DEFAULT ('{}'),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE KEY unique_application (candidate_id, job_id),
    INDEX idx_app_candidate (candidate_id),
    INDEX idx_app_job (job_id),
    INDEX idx_app_status (status),
    INDEX idx_app_match_score (match_score),
    INDEX idx_app_tenant (tenant_id)
);

-- ===============================================
-- USERS TABLE (Recruiters/Handlers)
-- ===============================================
CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'recruiter' COMMENT 'admin, recruiter, supervisor',
    phone VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    assigned_jobs JSON DEFAULT ('[]'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL,
    metadata JSON DEFAULT ('{}'),
    INDEX idx_users_email (email),
    INDEX idx_users_role (role),
    INDEX idx_users_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- COMMUNICATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS communications (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    channel VARCHAR(50) NOT NULL COMMENT 'whatsapp, messenger, email, sms, phone, in_person',
    direction VARCHAR(20) NOT NULL COMMENT 'inbound, outbound',
    message_type VARCHAR(50) COMMENT 'text, voice, document, image',
    content TEXT,
    metadata JSON DEFAULT ('{}'),
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP NULL,
    read_at TIMESTAMP NULL,
    responded_at TIMESTAMP NULL,
    sent_by CHAR(36),
    call_recording_url TEXT,
    attachments JSON DEFAULT ('[]'),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_comm_candidate (candidate_id),
    INDEX idx_comm_channel (channel),
    INDEX idx_comm_sent_at (sent_at),
    INDEX idx_comm_tenant (tenant_id)
);

-- ===============================================
-- INTERVIEW_SCHEDULES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS interview_schedules (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    application_id CHAR(36) NOT NULL,
    scheduled_datetime TIMESTAMP NOT NULL,
    location TEXT,
    interviewer_id CHAR(36),
    duration_minutes INT DEFAULT 30,
    status VARCHAR(50) DEFAULT 'scheduled' COMMENT 'scheduled, confirmed, completed, cancelled, no_show',
    confirmation_sent_at TIMESTAMP NULL,
    reminder_sent_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    feedback TEXT,
    rating INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by CHAR(36),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    INDEX idx_interview_app (application_id),
    INDEX idx_interview_datetime (scheduled_datetime),
    INDEX idx_interview_status (status)
);

-- ===============================================
-- TRANSFER_REQUESTS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS transfer_requests (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    from_job_id CHAR(36),
    to_job_id CHAR(36) NOT NULL,
    requested_by CHAR(36) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, approved, rejected',
    reviewed_by CHAR(36),
    reviewed_at TIMESTAMP NULL,
    review_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_transfer_candidate (candidate_id),
    INDEX idx_transfer_status (status)
);

-- ===============================================
-- AUDIT_LOGS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    user_id CHAR(36),
    action VARCHAR(100) NOT NULL COMMENT 'create, update, delete, view, export',
    entity_type VARCHAR(50) NOT NULL COMMENT 'candidate, job, application, etc.',
    entity_id CHAR(36),
    changes JSON,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_entity (entity_type, entity_id),
    INDEX idx_audit_created_at (created_at)
);

-- ===============================================
-- TRANSLATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS translations (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    `key` VARCHAR(255) NOT NULL,
    language VARCHAR(10) NOT NULL COMMENT 'en, si, ta',
    value TEXT NOT NULL,
    context VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_translation (`key`, language),
    INDEX idx_translations_key (`key`)
);

-- ===============================================
-- NOTIFICATION_QUEUE TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS notification_queue (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    channel VARCHAR(50) NOT NULL COMMENT 'whatsapp, sms, email',
    template VARCHAR(100) NOT NULL,
    variables JSON DEFAULT ('{}'),
    scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, sent, failed, cancelled',
    sent_at TIMESTAMP NULL,
    error_message TEXT,
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_notif_status (status),
    INDEX idx_notif_scheduled (scheduled_for)
);

-- ===============================================
-- SAMPLE DATA FOR TESTING
-- ===============================================

-- Insert default tenant
INSERT INTO tenants (id, name, subdomain, email, plan) VALUES
(UUID(), 'Demo Company', 'demo', 'admin@demo.com', 'basic');

-- Insert sample jobs
INSERT INTO jobs (id, title, category, requirements, wiggle_room, status, positions_available) VALUES
(UUID(), 'Security Guard - Dubai', 'security', 
    '{"min_height_cm": 170, "max_height_cm": 190, "required_languages": ["English"], "min_age": 21, "max_age": 45, "licenses": ["security_license"]}',
    '{"height_tolerance_cm": 5, "age_tolerance_years": 2}',
    'active', 10
),
(UUID(), 'Hospitality Staff - Qatar', 'hospitality',
    '{"min_height_cm": 160, "required_languages": ["English"], "min_age": 21, "max_age": 40, "experience_years": 2}',
    '{"height_tolerance_cm": 3, "experience_tolerance_years": 1}',
    'active', 5
),
(UUID(), 'Factory Worker - Saudi Arabia', 'manufacturing',
    '{"required_languages": ["English"], "min_age": 21, "max_age": 45}',
    '{"age_tolerance_years": 3}',
    'active', 20
);

-- Insert sample translations
INSERT INTO translations (`key`, language, value, context) VALUES
('greeting', 'en', 'Hello! Welcome to our recruitment agency.', 'chatbot'),
('greeting', 'si', 'ආයුබෝවන්! අපගේ රැකියා නියෝජිතායතනය වෙත සාදරයෙන් පිළිගනිමු.', 'chatbot'),
('greeting', 'ta', 'வணக்கம்! எங்கள் ஆட்சேர்ப்பு நிறுவனத்திற்கு வரவேற்கிறோம்.', 'chatbot'),
('ask_name', 'en', 'What is your name?', 'chatbot'),
('ask_name', 'si', 'ඔබේ නම කුමක්ද?', 'chatbot'),
('ask_name', 'ta', 'உங்கள் பெயர் என்ன?', 'chatbot'),
('ask_position', 'en', 'Which position are you interested in?', 'chatbot'),
('ask_position', 'si', 'ඔබ කැමති රැකියාව කුමක්ද?', 'chatbot'),
('ask_position', 'ta', 'நீங்கள் எந்த வேலைக்கு ஆர்வமாக உள்ளீர்கள்?', 'chatbot');
