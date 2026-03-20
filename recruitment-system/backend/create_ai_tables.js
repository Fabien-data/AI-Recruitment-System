require('dotenv').config();
const { pool } = require('./src/config/database');

async function migrate() {
    try {
        await pool.query(`
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

            ALTER TABLE cv_files ADD COLUMN IF NOT EXISTS is_latest BOOLEAN DEFAULT true;

            CREATE TABLE IF NOT EXISTS chatbot_config (
                id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
                tenant_id UUID,
                bot_name VARCHAR(100) DEFAULT 'Recruitment Assistant',
                bot_personality TEXT DEFAULT 'Professional, friendly, and patient recruitment assistant',
                greeting_welcome JSONB DEFAULT '{"en": "Hello! Welcome to our recruitment service. I''m here to help you apply for overseas jobs. 🙏", "si": "ආයුබෝවන්! අපගේ බඳවා ගැනීමේ සේවාවට සාදරයෙන් පිළිගනිමු. 🙏", "ta": "வணக்கம்! எங்கள் ஆட்சேர்ப்பு சேவைக்கு வரவேற்கிறோம். 🙏"}'::jsonb,
                greeting_cv_request JSONB DEFAULT '{"en": "Please share your CV (photo or PDF) so I can review your qualifications.", "si": "ඔබේ CV එක (ඡායාරූපය හෝ PDF) මෙහි share කරන්න.", "ta": "உங்கள் CV ஐ (புகைப்படம் அல்லது PDF) இங்கே பகிரவும்."}'::jsonb,
                greeting_cv_received JSONB DEFAULT '{"en": "Thank you! I''ve received your CV. Let me review it... 📄", "si": "ස්තුතියි! ඔබේ CV එක ලැබුණා. 📄", "ta": "நன்றி! உங்கள் CV கிடைத்தது. 📄"}'::jsonb,
                greeting_complete JSONB DEFAULT '{"en": "Excellent! Your application is complete. A recruiter will contact you within 2-3 business days. Good luck! 🌟", "si": "නියමයි! ඔබේ අයදුම්පත සම්පූර්ණයි. සුභ පැතුම්! 🌟", "ta": "அருமை! உங்கள் விண்ணப்பம் முடிந்தது. வாழ்த்துக்கள்! 🌟"}'::jsonb,
                greeting_frustrated JSONB DEFAULT '{"en": "I understand this can be frustrating. Let me simplify - just tell me what you need help with. 💙", "si": "මට තේරෙනවා මෙය අපහසු විය හැකි බව. 💙", "ta": "புரிகிறது, இது கஷ்டமாக இருக்கலாம். 💙"}'::jsonb,
                require_cv_first BOOLEAN DEFAULT TRUE,
                auto_detect_language BOOLEAN DEFAULT TRUE,
                default_language VARCHAR(10) DEFAULT 'en',
                max_messages_before_handoff INT DEFAULT 20,
                frustration_threshold INT DEFAULT 7,
                required_fields JSONB DEFAULT '["full_name", "phone", "email", "nic_no", "dob", "position_applied_for"]'::jsonb,
                optional_fields JSONB DEFAULT '["passport_no", "address", "marital_status", "education", "experience"]'::jsonb,
                ai_model VARCHAR(50) DEFAULT 'gpt-4o-mini',
                ai_temperature DECIMAL(2,1) DEFAULT 0.7,
                use_knowledge_base BOOLEAN DEFAULT TRUE,
                business_hours_start TIME DEFAULT '09:00:00',
                business_hours_end TIME DEFAULT '18:00:00',
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
        `);
        console.log("Migration successful");
    } catch (e) {
        console.error("Migration failed:", e);
    } finally {
        pool.end();
    }
}
migrate();
