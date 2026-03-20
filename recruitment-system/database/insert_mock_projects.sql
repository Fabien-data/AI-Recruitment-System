-- Mock Projects Data Insert Statements
-- Run these in your database query canvas to add mock data to the projects table

-- 1. Dubai Mall Security Operations
INSERT INTO projects (
    title, client_name, industry_type, description, countries, status, priority, 
    total_positions, filled_positions, start_date, interview_date, end_date, 
    benefits, salary_info, contact_info, requirements
) VALUES (
    'Dubai Mall Security Operations',
    'Emaar Properties',
    'Security Services',
    'Comprehensive security services for Dubai Mall including patrol, surveillance, and customer assistance. Requires professional guards with excellent communication skills and experience in high-traffic commercial environments.',
    '["United Arab Emirates"]',
    'active',
    'high',
    25,
    8,
    '2024-03-15',
    '2024-02-28',
    '2025-03-15',
    '{"health_insurance": true, "accommodation": true, "transportation": "company_bus", "annual_leave": "30_days", "bonus": "performance_based"}',
    '{"base_salary": 3200, "currency": "AED", "payment_frequency": "monthly", "overtime_rate": 1.5, "allowances": ["food_allowance", "uniform_allowance"]}',
    '{"primary_contact": "Ahmed Al-Mansouri", "email": "ahmed.mansouri@emaar.com", "phone": "+971-4-362-7777", "department": "Security Operations", "address": "Dubai Mall, Downtown Dubai, UAE"}',
    '{"min_height": 170, "max_height": 190, "required_languages": ["English", "Arabic"], "min_age": 21, "max_age": 45, "experience_years": 2, "certifications": ["Security License", "First Aid"], "education": "High School", "skills": ["Customer Service", "Surveillance", "Emergency Response"]}'
);

-- 2. Qatar Luxury Hotel Operations
INSERT INTO projects (
    title, client_name, industry_type, description, countries, status, priority, 
    total_positions, filled_positions, start_date, interview_date, end_date, 
    benefits, salary_info, contact_info, requirements
) VALUES (
    'Qatar Luxury Hotel Operations',
    'Marriott International Qatar',
    'Hospitality',
    'Hospitality staff positions for 5-star hotel including front desk, housekeeping, food & beverage service, and guest relations. Focus on delivering exceptional customer experience.',
    '["Qatar"]',
    'active',
    'high',
    40,
    15,
    '2024-04-01',
    '2024-03-10',
    '2025-04-01',
    '{"health_insurance": true, "accommodation": true, "meals": "provided", "annual_leave": "28_days", "training": "continuous"}',
    '{"base_salary": 2800, "currency": "QAR", "payment_frequency": "monthly", "tips_included": true, "service_charge": 10}',
    '{"primary_contact": "Sarah Johnson", "email": "sarah.johnson@marriott.com", "phone": "+974-4000-8000", "department": "Human Resources", "address": "West Bay, Doha, Qatar"}',
    '{"min_height": 160, "required_languages": ["English"], "min_age": 21, "max_age": 40, "experience_years": 1, "education": "High School", "skills": ["Customer Service", "Multilingual Capability", "Professional Appearance"]}'
);

-- 3. Saudi Vision 2030 Manufacturing
INSERT INTO projects (
    title, client_name, industry_type, description, countries, status, priority, 
    total_positions, filled_positions, start_date, interview_date, end_date, 
    benefits, salary_info, contact_info, requirements
) VALUES (
    'Saudi Vision 2030 Manufacturing',
    'SABIC Industrial Solutions',
    'Manufacturing',
    'Manufacturing and production line positions for petrochemical facility. Includes machine operators, quality control inspectors, and production supervisors.',
    '["Saudi Arabia"]',
    'active',
    'medium',
    60,
    22,
    '2024-05-01',
    '2024-04-15',
    '2026-05-01',
    '{"health_insurance": true, "accommodation": true, "transportation": "company_transport", "annual_leave": "30_days", "pension": true}',
    '{"base_salary": 2500, "currency": "SAR", "payment_frequency": "monthly", "shift_allowance": 500, "hazard_pay": 300}',
    '{"primary_contact": "Mohammad Al-Rashid", "email": "mohammad.rashid@sabic.com", "phone": "+966-13-321-0000", "department": "Industrial Operations", "address": "Jubail Industrial City, Saudi Arabia"}',
    '{"required_languages": ["English"], "min_age": 21, "max_age": 45, "experience_years": 1, "certifications": ["Safety Training", "Machine Operation"], "education": "Technical Diploma", "physical_requirements": "Good health, ability to work in industrial environment"}'
);

-- 4. Kuwait Healthcare Support Services
INSERT INTO projects (
    title, client_name, industry_type, description, countries, status, priority, 
    total_positions, filled_positions, start_date, interview_date, end_date, 
    benefits, salary_info, contact_info, requirements
) VALUES (
    'Kuwait Healthcare Support Services',
    'Al-Sabah Medical District',
    'Healthcare',
    'Healthcare support positions including patient care assistants, medical equipment technicians, and facility maintenance staff.',
    '["Kuwait"]',
    'pending',
    'high',
    35,
    0,
    '2024-06-01',
    '2024-05-15',
    '2025-06-01',
    '{"health_insurance": true, "accommodation": true, "meals": "subsidized", "annual_leave": "35_days", "medical_allowance": true}',
    '{"base_salary": 400, "currency": "KWD", "payment_frequency": "monthly", "night_shift_allowance": 50, "medical_allowance": 30}',
    '{"primary_contact": "Dr. Fatima Al-Zahra", "email": "fatima.alzahra@sabahmedical.kw", "phone": "+965-2481-7777", "department": "Medical Administration", "address": "Sabah Medical District, Kuwait City"}',
    '{"required_languages": ["English", "Arabic"], "min_age": 22, "max_age": 50, "experience_years": 1, "certifications": ["Basic Life Support", "Healthcare Training"], "education": "Diploma in Healthcare or equivalent", "background_check": "required"}'
);

-- 5. Oman Tourism & Hospitality Development
INSERT INTO projects (
    title, client_name, industry_type, description, countries, status, priority, 
    total_positions, filled_positions, start_date, interview_date, end_date, 
    benefits, salary_info, contact_info, requirements
) VALUES (
    'Oman Tourism & Hospitality Development',
    'Omran Group',
    'Tourism',
    'Tourism and hospitality positions for new resort development including tour guides, hotel staff, restaurant service, and guest experience coordinators.',
    '["Oman"]',
    'planning',
    'medium',
    45,
    0,
    '2024-07-01',
    '2024-06-10',
    '2026-07-01',
    '{"health_insurance": true, "accommodation": true, "meals": "provided", "annual_leave": "30_days", "training_programs": true}',
    '{"base_salary": 500, "currency": "OMR", "payment_frequency": "monthly", "tips_permitted": true, "annual_bonus": "performance_based"}',
    '{"primary_contact": "Hassan Al-Baluchi", "email": "hassan.baluchi@omran.om", "phone": "+968-24-123456", "department": "Tourism Development", "address": "Muscat Hills, Muscat, Oman"}',
    '{"required_languages": ["English"], "preferred_languages": ["Arabic"], "min_age": 21, "max_age": 40, "experience_years": 1, "skills": ["Customer Service", "Cultural Awareness", "Communication"], "personality_traits": ["Friendly", "Professional", "Adaptable"]}'
);

-- 6. Bahrain Financial District Operations
INSERT INTO projects (
    title, client_name, industry_type, description, countries, status, priority, 
    total_positions, filled_positions, start_date, interview_date, end_date, 
    benefits, salary_info, contact_info, requirements
) VALUES (
    'Bahrain Financial District Operations',
    'Bahrain World Trade Center',
    'Corporate Services',
    'Corporate support services including office administration, security, cleaning, and maintenance for premium office buildings in Bahrain Financial Harbor.',
    '["Bahrain"]',
    'active',
    'low',
    30,
    18,
    '2024-03-01',
    '2024-02-15',
    '2025-03-01',
    '{"health_insurance": true, "transportation": "allowance", "annual_leave": "25_days", "training": "provided"}',
    '{"base_salary": 350, "currency": "BHD", "payment_frequency": "monthly", "overtime_available": true, "annual_increment": 5}',
    '{"primary_contact": "Amira Al-Khalifa", "email": "amira.khalifa@bwtc.bh", "phone": "+973-1721-1111", "department": "Facilities Management", "address": "Manama, Bahrain"}',
    '{"required_languages": ["English"], "min_age": 21, "max_age": 45, "education": "High School", "skills": ["Professional Demeanor", "Reliability", "Basic Computer Skills"]}'
);

-- Verification query to check inserted data
SELECT 
    id,
    title,
    client_name,
    industry_type,
    status,
    priority,
    total_positions,
    filled_positions,
    start_date,
    end_date
FROM projects
ORDER BY created_at DESC;