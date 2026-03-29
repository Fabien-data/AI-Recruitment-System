-- =============================================================================
-- Maru I Works — Initial Job Seed
-- 5 Projects + 20 Popular Foreign Employment Jobs
-- =============================================================================
-- Run AFTER the schema is applied and at least one admin user exists.
-- Uses DO $$ blocks so it is idempotent — safe to run more than once.
-- =============================================================================

DO $$
DECLARE
    v_security_project_id  UUID;
    v_hospitality_project_id UUID;
    v_construction_project_id UUID;
    v_healthcare_project_id UUID;
    v_domestic_project_id  UUID;
    v_admin_id UUID;
BEGIN

-- ── Pick any existing admin to be the creator ─────────────────────────────────
SELECT id INTO v_admin_id FROM users WHERE role = 'admin' LIMIT 1;
IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'No admin user found. Create an admin user before running this seed.';
END IF;

-- ── Skip if already seeded (idempotent guard) ─────────────────────────────────
IF EXISTS (SELECT 1 FROM projects WHERE title = 'Gulf Security & Facilities') THEN
    RAISE NOTICE 'Seed already applied — skipping.';
    RETURN;
END IF;


-- =============================================================================
-- PROJECTS (5)
-- =============================================================================

INSERT INTO projects (id, title, client_name, industry_type, description, countries, status, priority,
    total_positions, benefits, salary_info, created_by)
VALUES (
    uuid_generate_v4(),
    'Gulf Security & Facilities',
    'Al Futtaim Group',
    'Security',
    'Security and facilities management roles across the UAE, Kuwait, and Qatar. Includes airport, mall, and corporate site postings.',
    '["UAE","Kuwait","Qatar"]'::jsonb,
    'active', 'high', 65,
    '{"accommodation":true,"food":true,"flight":true,"medical":true,"transport":true}'::jsonb,
    '{"min":700,"max":900,"currency":"USD"}'::jsonb,
    v_admin_id
) RETURNING id INTO v_security_project_id;

INSERT INTO projects (id, title, client_name, industry_type, description, countries, status, priority,
    total_positions, benefits, salary_info, created_by)
VALUES (
    uuid_generate_v4(),
    'Hospitality & Hotels Middle East',
    'Rotana Hotels',
    'Hospitality',
    'Housekeeping, F&B, front desk, and kitchen roles at 4-5 star hotels across UAE, Saudi Arabia, and Oman.',
    '["UAE","Saudi Arabia","Oman"]'::jsonb,
    'active', 'normal', 68,
    '{"accommodation":true,"food":true,"flight":true,"medical":false,"transport":true}'::jsonb,
    '{"min":500,"max":750,"currency":"USD"}'::jsonb,
    v_admin_id
) RETURNING id INTO v_hospitality_project_id;

INSERT INTO projects (id, title, client_name, industry_type, description, countries, status, priority,
    total_positions, benefits, salary_info, created_by)
VALUES (
    uuid_generate_v4(),
    'Construction & Skilled Trades Gulf',
    'Arabtec Construction',
    'Construction',
    'Skilled tradespeople for large construction and infrastructure projects in UAE and Qatar. Accommodation and transport included.',
    '["UAE","Qatar"]'::jsonb,
    'active', 'urgent', 110,
    '{"accommodation":true,"food":true,"flight":true,"medical":true,"transport":true}'::jsonb,
    '{"min":600,"max":1000,"currency":"USD"}'::jsonb,
    v_admin_id
) RETURNING id INTO v_construction_project_id;

INSERT INTO projects (id, title, client_name, industry_type, description, countries, status, priority,
    total_positions, benefits, salary_info, created_by)
VALUES (
    uuid_generate_v4(),
    'Healthcare Staffing Gulf',
    'NMC Healthcare',
    'Healthcare',
    'Registered nurses, healthcare assistants, and allied health professionals for private hospitals in UAE and Saudi Arabia.',
    '["UAE","Saudi Arabia"]'::jsonb,
    'active', 'high', 40,
    '{"accommodation":true,"food":false,"flight":true,"medical":true,"transport":false}'::jsonb,
    '{"min":900,"max":1500,"currency":"USD"}'::jsonb,
    v_admin_id
) RETURNING id INTO v_healthcare_project_id;

INSERT INTO projects (id, title, client_name, industry_type, description, countries, status, priority,
    total_positions, benefits, salary_info, created_by)
VALUES (
    uuid_generate_v4(),
    'Domestic & Household Gulf',
    'Private Households',
    'Domestic',
    'Housemaids, drivers, caregivers, and cooks for private households in Kuwait, Saudi Arabia, and Oman.',
    '["Kuwait","Saudi Arabia","Oman"]'::jsonb,
    'active', 'normal', 95,
    '{"accommodation":true,"food":true,"flight":true,"medical":false,"transport":false}'::jsonb,
    '{"min":400,"max":600,"currency":"USD"}'::jsonb,
    v_admin_id
) RETURNING id INTO v_domestic_project_id;


-- =============================================================================
-- JOBS (20)
-- =============================================================================

-- ── SECURITY (4 jobs) ────────────────────────────────────────────────────────

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Security Guard',
    'security',
    'Provide security services at commercial premises, malls, and corporate offices in UAE. Uniform, meals, and accommodation provided.',
    '{"min_age":21,"max_age":45,"min_height_cm":170,"experience_years":0,"required_languages":["English"]}'::jsonb,
    30, 'AED 1,800 – 2,200/month', 'Dubai, UAE',
    'active', v_security_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Security Supervisor',
    'security',
    'Lead a team of 8–12 security guards at a major retail complex. Must have prior team-leader experience in security.',
    '{"min_age":25,"max_age":45,"min_height_cm":170,"experience_years":3,"required_languages":["English"]}'::jsonb,
    10, 'AED 2,500 – 3,000/month', 'Abu Dhabi, UAE',
    'active', v_security_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'CCTV Operator',
    'security',
    'Monitor CCTV systems in a control room. Basic computer and English communication skills required. Training provided.',
    '{"min_age":20,"max_age":40,"experience_years":0,"required_languages":["English"]}'::jsonb,
    15, 'AED 1,600 – 1,900/month', 'Kuwait City, Kuwait',
    'active', v_security_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Site Security Officer',
    'security',
    'Oversee security at a large construction site. Experience in site safety or security is preferred.',
    '{"min_age":22,"max_age":50,"min_height_cm":168,"experience_years":1}'::jsonb,
    20, 'QAR 1,500 – 2,000/month', 'Doha, Qatar',
    'active', v_security_project_id, v_admin_id
);

-- ── HOSPITALITY (4 jobs) ─────────────────────────────────────────────────────

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Room Attendant',
    'hospitality',
    'Clean and maintain hotel rooms to 5-star standards. Full training provided. No prior experience required.',
    '{"min_age":18,"max_age":40,"experience_years":0}'::jsonb,
    25, 'AED 1,200 – 1,500/month', 'Dubai, UAE',
    'active', v_hospitality_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Waiter / F&B Staff',
    'hospitality',
    'Serve guests at a hotel restaurant and bar. Basic English communication required. Friendly and presentable candidates preferred.',
    '{"min_age":18,"max_age":35,"experience_years":0,"required_languages":["English"]}'::jsonb,
    20, 'AED 1,300 – 1,600/month', 'Muscat, Oman',
    'active', v_hospitality_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Cook / Kitchen Helper',
    'hospitality',
    'Prepare food in a hotel kitchen. Experience in South Asian, continental, or Arabic cuisine preferred. Training available.',
    '{"min_age":20,"max_age":45,"experience_years":1}'::jsonb,
    15, 'AED 1,500 – 2,000/month', 'Dubai, UAE',
    'active', v_hospitality_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Hotel Receptionist',
    'hospitality',
    'Front desk duties at a 4-star hotel. Strong English and customer-service skills are essential. Presentable appearance required.',
    '{"min_age":20,"max_age":35,"experience_years":1,"required_languages":["English"]}'::jsonb,
    8, 'SAR 2,000 – 2,800/month', 'Riyadh, Saudi Arabia',
    'active', v_hospitality_project_id, v_admin_id
);

-- ── CONSTRUCTION & TRADES (5 jobs) ───────────────────────────────────────────

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Mason / Bricklayer',
    'construction',
    'Skilled masonry work on residential and commercial buildings in Dubai. 2+ years experience required.',
    '{"min_age":20,"max_age":50,"experience_years":2}'::jsonb,
    40, 'AED 1,400 – 1,800/month', 'Dubai, UAE',
    'active', v_construction_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Electrician',
    'construction',
    'Install and maintain electrical systems in residential buildings. NVQ Level 3 or equivalent certification required.',
    '{"min_age":22,"max_age":50,"experience_years":2}'::jsonb,
    20, 'AED 1,800 – 2,500/month', 'Dubai, UAE',
    'active', v_construction_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Plumber',
    'construction',
    'Plumbing installation and maintenance for residential and commercial projects in Abu Dhabi.',
    '{"min_age":22,"max_age":50,"experience_years":1}'::jsonb,
    15, 'AED 1,600 – 2,200/month', 'Abu Dhabi, UAE',
    'active', v_construction_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Welder',
    'construction',
    'MIG/TIG welding for construction and steel-fabrication projects in Qatar. Welding certification preferred.',
    '{"min_age":22,"max_age":50,"experience_years":2}'::jsonb,
    15, 'QAR 1,800 – 2,400/month', 'Doha, Qatar',
    'active', v_construction_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Painter',
    'construction',
    'Interior and exterior painting for residential buildings. Roller, brush, and spray experience preferred.',
    '{"min_age":20,"max_age":50,"experience_years":1}'::jsonb,
    20, 'AED 1,300 – 1,700/month', 'Dubai, UAE',
    'active', v_construction_project_id, v_admin_id
);

-- ── HEALTHCARE (3 jobs) ──────────────────────────────────────────────────────

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Registered Nurse',
    'healthcare',
    'Patient care in a private hospital in Dubai. SLNC registration and minimum 2 years of clinical experience required.',
    '{"min_age":21,"max_age":45,"experience_years":2,"required_languages":["English"],"licenses":["SLNC"]}'::jsonb,
    20, 'AED 3,500 – 5,000/month', 'Dubai, UAE',
    'active', v_healthcare_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Healthcare Assistant',
    'healthcare',
    'Support registered nurses in patient care at a private hospital in Riyadh. Certificate in caregiving or basic nursing preferred.',
    '{"min_age":20,"max_age":45,"experience_years":0,"required_languages":["English"]}'::jsonb,
    15, 'SAR 2,000 – 2,800/month', 'Riyadh, Saudi Arabia',
    'active', v_healthcare_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Physiotherapist',
    'healthcare',
    'Registered physiotherapist for an outpatient clinic in Abu Dhabi. Degree plus valid license required.',
    '{"min_age":23,"max_age":45,"experience_years":2,"required_languages":["English"]}'::jsonb,
    5, 'AED 5,000 – 7,000/month', 'Abu Dhabi, UAE',
    'active', v_healthcare_project_id, v_admin_id
);

-- ── DOMESTIC / DRIVER (4 jobs) ────────────────────────────────────────────────

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Driver / Chauffeur',
    'driving',
    'Drive company or private vehicles in Dubai. Valid driving licence and a clean record required. Automatic and manual experience preferred.',
    '{"min_age":22,"max_age":50,"experience_years":2,"licenses":["driving"]}'::jsonb,
    25, 'AED 1,500 – 2,000/month', 'Dubai, UAE',
    'active', v_domestic_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Domestic Worker',
    'domestic',
    'Household cleaning, cooking, and child-care duties for a private family in Kuwait. Accommodation and food provided.',
    '{"min_age":21,"max_age":45,"experience_years":0}'::jsonb,
    50, 'KWD 70 – 90/month', 'Kuwait City, Kuwait',
    'active', v_domestic_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'Caregiver / Elder Care',
    'domestic',
    'Care for an elderly person in a private household in Saudi Arabia. Patient, compassionate candidates with basic first-aid knowledge preferred.',
    '{"min_age":22,"max_age":50,"experience_years":0}'::jsonb,
    20, 'SAR 1,200 – 1,600/month', 'Riyadh, Saudi Arabia',
    'active', v_domestic_project_id, v_admin_id
);

INSERT INTO jobs (title, category, description, requirements, positions_available, salary_range, location, status, project_id, created_by)
VALUES (
    'AC Technician',
    'technical',
    'Install and service air-conditioning units for residential and commercial buildings in Dubai. TVEC certificate preferred.',
    '{"min_age":20,"max_age":50,"experience_years":1}'::jsonb,
    15, 'AED 1,800 – 2,500/month', 'Dubai, UAE',
    'active', v_construction_project_id, v_admin_id
);

RAISE NOTICE 'Seed complete: 5 projects and 20 jobs inserted for Maru I Works.';

END $$;
