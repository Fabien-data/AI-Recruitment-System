-- ============================================================================
-- Migration 021: Admin Observability
-- ----------------------------------------------------------------------------
-- Adds per-section CRUD permissions on top of the existing 4-role model and
-- wires session/view tracking so admins can audit user behaviour and print
-- KPI reports. Documentation mirror — actual execution happens at startup via
-- backend/src/config/migrations.js using safeAlter() so everything is idempotent.
-- ============================================================================

-- ── sections lookup (seeded once) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sections (
    key         VARCHAR(40)  PRIMARY KEY,
    name        VARCHAR(80)  NOT NULL,
    icon        VARCHAR(40)  NOT NULL,
    description TEXT,
    sort_order  SMALLINT     NOT NULL DEFAULT 100
);

INSERT INTO sections (key, name, icon, description, sort_order) VALUES
    ('dashboard',      'Dashboard',       'LayoutDashboard', 'System overview', 10),
    ('cv_manager',     'CV Manager',      'FileSearch',      'CV upload, parsing and matching', 20),
    ('jobs',           'Jobs',            'Briefcase',       'Open positions and requirements', 30),
    ('candidates',     'Candidates',      'Users',           'Candidate profiles and pipeline', 40),
    ('projects',       'Projects',        'FolderKanban',    'Recruitment projects', 50),
    ('applications',   'Applications',    'FileText',        'Job applications and statuses', 60),
    ('interviews',     'Interviews',      'CalendarDays',    'Interview scheduling', 70),
    ('communications', 'Communications',  'MessageSquare',   'Messaging and outreach', 80),
    ('analytics',      'Analytics',       'BarChart2',       'Reporting and KPIs', 90),
    ('knowledge_base', 'Knowledge Base',  'BookOpen',        'FAQ and documents for chatbot', 100),
    ('marketing_hub',  'Marketing Hub',   'Megaphone',       'Lead intake and call handling', 110),
    ('general_pool',   'General Pool',    'Database',        'Unassigned candidate pool', 120)
ON CONFLICT (key) DO NOTHING;

-- ── per-user, per-section CRUD permissions ──────────────────────────────────
CREATE TABLE IF NOT EXISTS user_section_permissions (
    user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    section_key VARCHAR(40)  NOT NULL REFERENCES sections(key) ON DELETE CASCADE,
    can_view    BOOLEAN      NOT NULL DEFAULT FALSE,
    can_create  BOOLEAN      NOT NULL DEFAULT FALSE,
    can_edit    BOOLEAN      NOT NULL DEFAULT FALSE,
    can_delete  BOOLEAN      NOT NULL DEFAULT FALSE,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, section_key)
);
CREATE INDEX IF NOT EXISTS idx_usp_user ON user_section_permissions(user_id);

-- ── enrich audit_logs (created in Migration 009) ────────────────────────────
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS session_id  UUID;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS section_key VARCHAR(40);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
CREATE INDEX IF NOT EXISTS idx_audit_session
    ON audit_logs(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_user_section_date
    ON audit_logs(user_id, section_key, created_at DESC);

-- ── session lifecycle ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    login_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    logout_at    TIMESTAMPTZ,
    duration_ms  BIGINT,
    ip_address   TEXT,
    user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_date
    ON user_sessions(user_id, login_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_sessions_open
    ON user_sessions(user_id) WHERE logout_at IS NULL;
