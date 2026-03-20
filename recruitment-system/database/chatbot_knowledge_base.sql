-- ===============================================
-- CHATBOT KNOWLEDGE BASE SCHEMA (MySQL 8.0+)
-- WhatsApp Chatbot Enhancement for Recruitment System
-- ===============================================

-- ===============================================
-- KNOWLEDGE BASE TABLE
-- Stores FAQ entries with multilingual support
-- ===============================================
CREATE TABLE IF NOT EXISTS knowledge_base (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    category VARCHAR(100) NOT NULL COMMENT 'job_info, company, application_process, salary, requirements, general',
    
    -- Multilingual Questions
    question_en TEXT NOT NULL COMMENT 'English question/trigger phrase',
    question_si TEXT COMMENT 'Sinhala question',
    question_ta TEXT COMMENT 'Tamil question',
    
    -- Multilingual Answers
    answer_en TEXT NOT NULL COMMENT 'English answer',
    answer_si TEXT COMMENT 'Sinhala answer',
    answer_ta TEXT COMMENT 'Tamil answer',
    
    -- Search optimization
    keywords JSON DEFAULT ('[]') COMMENT 'Array of searchable keywords in all languages',
    embedding_vector JSON COMMENT 'Optional: Vector embedding for semantic search',
    
    -- Metadata
    priority INT DEFAULT 0 COMMENT 'Higher priority = shown first for matches',
    is_active BOOLEAN DEFAULT TRUE,
    usage_count INT DEFAULT 0 COMMENT 'Track how often this FAQ is used',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by CHAR(36),
    
    INDEX idx_kb_category (category),
    INDEX idx_kb_tenant (tenant_id),
    INDEX idx_kb_active (is_active),
    FULLTEXT INDEX idx_kb_search_en (question_en, answer_en),
    FULLTEXT INDEX idx_kb_search_si (question_si, answer_si),
    FULLTEXT INDEX idx_kb_search_ta (question_ta, answer_ta),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- CONVERSATION SESSIONS TABLE
-- Tracks chatbot conversation state per candidate
-- ===============================================
CREATE TABLE IF NOT EXISTS conversation_sessions (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    channel VARCHAR(50) DEFAULT 'whatsapp' COMMENT 'whatsapp, messenger, web',
    
    -- Conversation State Machine
    state VARCHAR(50) DEFAULT 'greeting' COMMENT 'greeting, cv_request, waiting_cv, processing_cv, collecting_info, complete, human_handoff',
    current_field VARCHAR(50) COMMENT 'Field currently being collected',
    
    -- Collected Application Data
    collected_data JSON DEFAULT ('{}') COMMENT 'Accumulated form data from conversation',
    missing_fields JSON DEFAULT ('[]') COMMENT 'List of fields still needed',
    
    -- Language & Sentiment Tracking
    detected_language VARCHAR(10) DEFAULT 'en' COMMENT 'en, si, ta',
    language_confidence DECIMAL(3,2) DEFAULT 0.00,
    sentiment_score DECIMAL(3,2) DEFAULT 0.00 COMMENT '-1.0 to 1.0 (negative to positive)',
    frustration_level INT DEFAULT 0 COMMENT '0-10 scale, triggers human handoff at high levels',
    
    -- Context for AI
    conversation_summary TEXT COMMENT 'AI-generated summary of conversation so far',
    last_kb_articles_used JSON DEFAULT ('[]') COMMENT 'IDs of KB articles used in recent responses',
    
    -- Timestamps
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_interaction_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    
    -- Metrics
    message_count INT DEFAULT 0,
    cv_attempts INT DEFAULT 0 COMMENT 'Number of CV upload attempts',
    
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
    INDEX idx_session_candidate (candidate_id),
    INDEX idx_session_state (state),
    INDEX idx_session_channel (channel),
    INDEX idx_session_last_interaction (last_interaction_at)
);

-- ===============================================
-- CHATBOT CONFIG TABLE
-- Tenant-specific chatbot customization
-- ===============================================
CREATE TABLE IF NOT EXISTS chatbot_config (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36) UNIQUE NOT NULL,
    
    -- Bot Identity
    bot_name VARCHAR(100) DEFAULT 'Recruitment Assistant',
    bot_personality TEXT DEFAULT 'Professional, friendly, and patient recruitment assistant',
    
    -- Customizable Greetings (JSON with en/si/ta keys)
    greeting_welcome JSON DEFAULT ('{"en": "Hello! Welcome to our recruitment service. I\\'m here to help you apply for overseas jobs. 🙏", "si": "ආයුබෝවන්! අපගේ බඳවා ගැනීමේ සේවාවට සාදරයෙන් පිළිගනිමු. 🙏", "ta": "வணக்கம்! எங்கள் ஆட்சேர்ப்பு சேவைக்கு வரவேற்கிறோம். 🙏"}'),
    greeting_cv_request JSON DEFAULT ('{"en": "Please share your CV (photo or PDF) so I can review your qualifications.", "si": "ඔබේ CV එක (ඡායාරූපය හෝ PDF) මෙහි share කරන්න.", "ta": "உங்கள் CV ஐ (புகைப்படம் அல்லது PDF) இங்கே பகிரவும்."}'),
    greeting_cv_received JSON DEFAULT ('{"en": "Thank you! I\\'ve received your CV. Let me review it... 📄", "si": "ස්තුතියි! ඔබේ CV එක ලැබුණා. 📄", "ta": "நன்றி! உங்கள் CV கிடைத்தது. 📄"}'),
    greeting_complete JSON DEFAULT ('{"en": "Excellent! Your application is complete. A recruiter will contact you within 2-3 business days. Good luck! 🌟", "si": "නියමයි! ඔබේ අයදුම්පත සම්පූර්ණයි. සුභ පැතුම්! 🌟", "ta": "அருமை! உங்கள் விண்ணப்பம் முடிந்தது. வாழ்த்துக்கள்! 🌟"}'),
    greeting_frustrated JSON DEFAULT ('{"en": "I understand this can be frustrating. Let me simplify - just tell me what you need help with. 💙", "si": "මට තේරෙනවා මෙය අපහසු විය හැකි බව. 💙", "ta": "புரிகிறது, இது கஷ்டமாக இருக்கலாம். 💙"}'),
    
    -- Behavior Settings
    require_cv_first BOOLEAN DEFAULT TRUE COMMENT 'Must upload CV before collecting other info',
    auto_detect_language BOOLEAN DEFAULT TRUE,
    default_language VARCHAR(10) DEFAULT 'en',
    max_messages_before_handoff INT DEFAULT 20 COMMENT 'Trigger human handoff after N messages',
    frustration_threshold INT DEFAULT 7 COMMENT 'Frustration level to trigger human handoff',
    
    -- Required Application Fields
    required_fields JSON DEFAULT ('["full_name", "phone", "email", "nic_no", "dob", "position_applied_for"]'),
    optional_fields JSON DEFAULT ('["passport_no", "address", "marital_status", "education", "experience"]'),
    
    -- AI Settings
    ai_model VARCHAR(50) DEFAULT 'gpt-4o-mini',
    ai_temperature DECIMAL(2,1) DEFAULT 0.7,
    use_knowledge_base BOOLEAN DEFAULT TRUE,
    
    -- Business Hours (for human handoff messaging)
    business_hours_start TIME DEFAULT '09:00:00',
    business_hours_end TIME DEFAULT '18:00:00',
    timezone VARCHAR(50) DEFAULT 'Asia/Colombo',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- ===============================================
-- SAMPLE DATA: DEFAULT KNOWLEDGE BASE ENTRIES
-- ===============================================
INSERT INTO knowledge_base (category, question_en, question_si, question_ta, answer_en, answer_si, answer_ta, keywords, priority) VALUES

-- Salary Questions
('salary', 
 'What is the salary?', 
 'වැටුප කීයද?', 
 'சம்பளம் என்ன?',
 'Salary depends on the specific job role and your experience. Typically ranges from 1500-3000 AED for entry-level positions. The exact amount will be confirmed during the interview process.',
 'වැටුප රැකියාව සහ ඔබේ පළපුරුද්ද මත රඳා පවතී. සාමාන්‍යයෙන් AED 1500-3000 පමණ වේ.',
 'சம்பளம் வேலை மற்றும் உங்கள் அனுபவத்தைப் பொறுத்தது. பொதுவாக AED 1500-3000.',
 '["salary", "pay", "wage", "වැටුප", "ගෙවීම", "சம்பளம்", "ஊதியம்", "money", "aed", "dirham"]',
 10),

-- Application Process
('application_process',
 'How do I apply?',
 'මම කොහොමද අයදුම් කරන්නේ?',
 'நான் எப்படி விண்ணப்பிப்பது?',
 'To apply, simply share your CV (photo or PDF) here. I will extract your details and guide you through completing your application.',
 'අයදුම් කිරීමට, ඔබේ CV එක (ඡායාරූපය හෝ PDF) මෙහි share කරන්න. මම ඔබේ විස්තර ලබාගෙන අයදුම්පත සම්පූර්ණ කිරීමට උදව් කරනවා.',
 'விண்ணப்பிக்க, உங்கள் CV ஐ இங்கே பகிரவும். நான் உங்கள் விவரங்களை பெற்று உதவுவேன்.',
 '["apply", "application", "how to", "process", "අයදුම්", "කොහොමද", "விண்ணப்பம்", "எப்படி"]',
 10),

-- Job Requirements
('requirements',
 'What are the requirements?',
 'අවශ්‍යතා මොනවාද?',
 'தேவைகள் என்ன?',
 'Requirements vary by job. Generally: Age 21-45, valid passport, and relevant experience. Specific requirements will be shared based on the position you apply for.',
 'අවශ්‍යතා රැකියාව අනුව වෙනස් වේ. සාමාන්‍යයෙන්: වයස 21-45, වලංගු ගමන් බලපත්‍රයක්, අදාළ පළපුරුද්ද.',
 'தேவைகள் வேலைக்கு ஏற்ப மாறும். பொதுவாக: வயது 21-45, செல்லுபடியாகும் பாஸ்போர்ட், தொடர்புடைய அனுபவம்.',
 '["requirements", "qualification", "eligibility", "need", "අවශ්‍ය", "සුදුසුකම්", "தகுதி", "தேவை"]',
 9),

-- Processing Time
('application_process',
 'How long does it take?',
 'කොච්චර කාලයක් ගතවෙනවද?',
 'எவ்வளவு நேரம் ஆகும்?',
 'After submitting your application, our team reviews it within 2-3 business days. If shortlisted, you will be contacted for an interview.',
 'ඔබේ අයදුම්පත ලැබුණු විට, අපේ කණ්ඩායම දින 2-3ක් ඇතුළත එය පරීක්ෂා කරනවා.',
 'உங்கள் விண்ணப்பம் கிடைத்தவுடன், எங்கள் குழு 2-3 நாட்களில் பரிசீலிக்கும்.',
 '["time", "long", "duration", "when", "කාලය", "කීයද", "நேரம்", "எப்போது"]',
 8);

-- ===============================================
-- INSERT DEFAULT CHATBOT CONFIG FOR DEMO TENANT
-- ===============================================
INSERT INTO chatbot_config (tenant_id, bot_name)
SELECT id, 'Dewan Assistant' FROM tenants WHERE subdomain = 'demo' LIMIT 1;
