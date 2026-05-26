-- Idempotent: safe to re-run. Creates knowledge_base + companion tables
-- that were missing from production. Source: create_ai_tables.js
-- Applied 2026-05-26 to fix "relation knowledge_base does not exist" warning.

CREATE TABLE IF NOT EXISTS conversation_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID,
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    channel VARCHAR(50) DEFAULT 'whatsapp',
    state VARCHAR(50) DEFAULT 'greeting',
    current_field VARCHAR(50),
    collected_data JSONB DEFAULT '{}'::jsonb,
    missing_fields JSONB DEFAULT '[]'::jsonb,
    detected_language VARCHAR(10) DEFAULT 'en',
    language_confidence DECIMAL(3,2) DEFAULT 0.00,
    sentiment_score DECIMAL(3,2) DEFAULT 0.00,
    frustration_level INT DEFAULT 0,
    conversation_summary TEXT,
    last_kb_articles_used JSONB DEFAULT '[]'::jsonb,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_interaction_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    message_count INT DEFAULT 0,
    cv_attempts INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chatbot_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID,
    bot_name VARCHAR(100) DEFAULT 'Recruitment Assistant',
    bot_personality TEXT,
    require_cv_first BOOLEAN DEFAULT TRUE,
    auto_detect_language BOOLEAN DEFAULT TRUE,
    default_language VARCHAR(10) DEFAULT 'en',
    max_messages_before_handoff INT DEFAULT 20,
    frustration_threshold INT DEFAULT 7,
    ai_model VARCHAR(50) DEFAULT 'gpt-4o-mini',
    ai_temperature DECIMAL(2,1) DEFAULT 0.7,
    use_knowledge_base BOOLEAN DEFAULT TRUE,
    timezone VARCHAR(50) DEFAULT 'Asia/Colombo',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS knowledge_base (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID,
    category VARCHAR(100) NOT NULL,
    question_en TEXT NOT NULL,
    question_si TEXT,
    question_ta TEXT,
    answer_en TEXT NOT NULL,
    answer_si TEXT,
    answer_ta TEXT,
    keywords JSONB DEFAULT '[]'::jsonb,
    embedding_vector JSONB,
    priority INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    usage_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID
);

-- Show what got created (or already existed)
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('knowledge_base', 'conversation_sessions', 'chatbot_config')
ORDER BY table_name;
