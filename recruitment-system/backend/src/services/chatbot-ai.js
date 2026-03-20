/**
 * Chatbot AI Service
 * 
 * Advanced AI module for the WhatsApp recruitment chatbot:
 * - Sentiment analysis
 * - Intent classification
 * - Contextual response generation
 * - Conversation state management
 * - Knowledge base integration
 */

const { pool } = require('../config/database');
const { createChatCompletion, detectLanguage: aiDetectLanguage } = require('../config/openai');
const { analyzeMessage, getGreeting, getFieldPrompt, buildLanguageContext } = require('./language-processor');
const { searchKnowledgeBase, buildKnowledgeContext, trackUsage } = require('./knowledge-base');

// Conversation States
const STATES = {
    GREETING: 'greeting',
    AWAITING_LANGUAGE_SELECTION: 'awaiting_language_selection',
    AWAITING_JOB_INTEREST: 'awaiting_job_interest',
    AWAITING_COUNTRY: 'awaiting_country',
    AWAITING_EXPERIENCE: 'awaiting_experience',
    CV_REQUEST: 'cv_request',
    WAITING_CV: 'waiting_cv',
    PROCESSING_CV: 'processing_cv',
    COLLECTING_INFO: 'collecting_info',
    COMPLETE: 'complete',
    HUMAN_HANDOFF: 'human_handoff'
};

// Intent Types
const INTENTS = {
    GREETING: 'greeting',
    LANGUAGE_SELECTION: 'language_selection',
    JOB_SELECTION: 'job_selection',
    COUNTRY_SELECTION: 'country_selection',
    EXPERIENCE_PROVIDED: 'experience_provided',
    QUESTION: 'question',
    CV_UPLOAD: 'cv_upload',
    PROVIDE_INFO: 'provide_info',
    PROFANITY: 'profanity',
    THANKS: 'thanks',
    GOODBYE: 'goodbye',
    HUMAN_REQUEST: 'human_request',
    UNKNOWN: 'unknown'
};

/**
 * Main chatbot response generator
 * @param {object} params - Input parameters
 * @returns {Promise<ChatbotResponse>}
 */
async function generateResponse(params) {
    const {
        message,
        candidateId,
        tenantId = null,
        channel = 'whatsapp',
        hasCV = false,
        sessionData = null
    } = params;

    // 1. Analyze the incoming message
    const analysis = await analyzeMessage(message);

    // 2. Classify intent
    const intent = await classifyIntent(message, analysis);

    // 3. Analyze sentiment
    const sentiment = await analyzeSentiment(message, analysis);

    // 4. Get or create conversation session
    let session = sessionData || await getOrCreateSession(candidateId, tenantId, channel);

    // 5. Update session with analysis
    session = await updateSession(session.id, {
        detected_language: analysis.language.detected,
        language_confidence: analysis.language.confidence,
        sentiment_score: sentiment.score,
        frustration_level: analysis.frustration.level,
        message_count: (session.message_count || 0) + 1
    });

    // 6. Check for frustration threshold / human handoff
    if (analysis.frustration.level >= 7 || intent === INTENTS.HUMAN_REQUEST) {
        return await handleHumanHandoff(session, analysis.language.detected);
    }

    // 7. Handle profanity with de-escalation
    if (intent === INTENTS.PROFANITY || analysis.profanity.hasProfanity) {
        return await handleProfanity(session, analysis.language.detected, sentiment);
    }

    // 8. Route based on state and intent
    let response;

    // Check conversational states first
    if (session.state === STATES.AWAITING_LANGUAGE_SELECTION) {
        response = await handleLanguageSelection(message, session, analysis);
    } else if (session.state === STATES.AWAITING_JOB_INTEREST) {
        response = await handleJobSelection(message, session, analysis);
    } else if (session.state === STATES.AWAITING_COUNTRY) {
        response = await handleCountrySelection(message, session, analysis);
    } else if (session.state === STATES.AWAITING_EXPERIENCE) {
        response = await handleExperienceSelection(message, session, analysis);
    } else {
        // Normal Intent Routing
        switch (intent) {
            case INTENTS.GREETING:
                response = await handleGreeting(session, analysis.language.detected, hasCV);
                break;

            case INTENTS.THANKS:
                response = await handleThanks(session, analysis.language.detected);
                break;

            case INTENTS.GOODBYE:
                response = await handleGoodbye(session, analysis.language.detected);
                break;

            case INTENTS.QUESTION:
                response = await handleQuestion(message, session, analysis.language.detected, tenantId);
                break;

            case INTENTS.PROVIDE_INFO:
                response = await handleInfoProvided(message, session, analysis);
                break;

            default:
                response = await handleContextualResponse(message, session, analysis, hasCV, tenantId);
        }
    }

    return {
        text: response.text,
        language: analysis.language.detected,
        intent,
        sentiment,
        sessionState: session.state,
        nextField: response.nextField || null,
        metadata: {
            analysis,
            kbArticlesUsed: response.kbArticlesUsed || []
        }
    };
}

/**
 * Classify the intent of user message
 */
async function classifyIntent(message, analysis) {
    const lowerMessage = message.toLowerCase().trim();

    // Quick pattern matching first

    // Greeting patterns
    if (/^(hi|hello|hey|good\s*(morning|afternoon|evening)|ayubowan|vanakkam|kohomada)/i.test(lowerMessage)) {
        return INTENTS.GREETING;
    }

    // Thanks patterns
    if (/^(thank|thanks|thx|sthuti|istuti|nandri)/i.test(lowerMessage)) {
        return INTENTS.THANKS;
    }

    // Goodbye patterns
    if (/^(bye|goodbye|later|see you)/i.test(lowerMessage)) {
        return INTENTS.GOODBYE;
    }

    // Human request
    if (/\b(human|person|real person|agent|speak to someone|talk to someone|call me)\b/i.test(lowerMessage)) {
        return INTENTS.HUMAN_REQUEST;
    }

    // Profanity detected
    if (analysis.profanity.hasProfanity && analysis.profanity.severity === 'strong') {
        return INTENTS.PROFANITY;
    }

    // Question patterns
    if (/\?$/.test(lowerMessage) || /^(what|how|when|where|why|can|do|is|are|will|would)[\s\b]/i.test(lowerMessage)) {
        return INTENTS.QUESTION;
    }

    // Sinhala/Tamil question patterns
    if (/(kohomada|mokakda|kawada|kiiyada|enna|eppadi|evlo|enga|eppo)/i.test(lowerMessage)) {
        return INTENTS.QUESTION;
    }

    // If message looks like providing info (short, factual content)
    const words = message.split(/\s+/).length;
    if (words <= 10 && !analysis.metadata.isQuestion) {
        // Check if it looks like name, phone, email, date, etc.
        if (/^[\w\s.-]+$/i.test(message) ||
            /^\d+$/.test(message) ||
            /@/.test(message) ||
            /^\d{4}-\d{2}-\d{2}$/.test(message)) {
            return INTENTS.PROVIDE_INFO;
        }
    }

    return INTENTS.UNKNOWN;
}

/**
 * Analyze sentiment of the message
 */
async function analyzeSentiment(message, analysis) {
    // Use frustration detection from analysis
    let score = 0;

    if (analysis.frustration.isFrustrated) {
        score = -0.3 - (analysis.frustration.level * 0.07);
    } else if (analysis.profanity.hasProfanity) {
        score = analysis.profanity.severity === 'strong' ? -0.8 : -0.4;
    } else {
        // Positive indicators
        if (/thank|great|excellent|wonderful|nice|good|happy|sthuti|nandri|hondai/i.test(message)) {
            score = 0.5;
        }
        // Neutral
        else {
            score = 0.1;
        }
    }

    // Clamp to -1 to 1
    score = Math.max(-1, Math.min(1, score));

    return {
        score,
        label: score > 0.3 ? 'positive' : score < -0.3 ? 'negative' : 'neutral',
        indicators: analysis.frustration.indicators
    };
}

/**
 * Handle greeting intent
 */
async function handleGreeting(session, language, hasCV) {
    if (hasCV) {
        // Already has CV, continue with info collection
        await updateSession(session.id, { state: STATES.COLLECTING_INFO });
        const text = await getGreeting('welcome', language, session.tenant_id) + '\n\n' + await getGreeting('cv_received', language, session.tenant_id);
        return { text };
    } else {
        // Welcome and request language selection
        await updateSession(session.id, { state: STATES.AWAITING_LANGUAGE_SELECTION });
        const text = await getGreeting('welcome', language, session.tenant_id) + '\n\n' + await getGreeting('language_selection', language, session.tenant_id);
        return { text };
    }
}

/**
 * Handle Language Selection
 */
async function handleLanguageSelection(message, session, analysis) {
    const text = message.toLowerCase().trim();
    let newLang = analysis.language.detected;

    if (text.includes('1') || text.includes('english')) newLang = 'en';
    else if (text.includes('2') || text.includes('sinhala') || text.includes('සිංහල')) newLang = 'si';
    else if (text.includes('3') || text.includes('tamil') || text.includes('தமிழ்')) newLang = 'ta';

    // Move to next state
    await updateSession(session.id, {
        state: STATES.AWAITING_JOB_INTEREST,
        detected_language: newLang
    });

    const promptText = await getGreeting('job_interest', newLang, session.tenant_id);
    return { text: promptText, language: newLang };
}

/**
 * Handle Job Interest
 */
async function handleJobSelection(message, session, analysis) {
    const collectedData = JSON.parse(session.collected_data || '{}');
    collectedData.job_interest = message.trim();

    await updateSession(session.id, {
        state: STATES.AWAITING_COUNTRY,
        collected_data: JSON.stringify(collectedData)
    });

    const text = await getGreeting('destination_country', session.detected_language, session.tenant_id);
    return { text };
}

/**
 * Handle Country Selection
 */
async function handleCountrySelection(message, session, analysis) {
    const collectedData = JSON.parse(session.collected_data || '{}');
    collectedData.destination_country = message.trim();

    await updateSession(session.id, {
        state: STATES.AWAITING_EXPERIENCE,
        collected_data: JSON.stringify(collectedData)
    });

    const text = await getGreeting('experience_years', session.detected_language, session.tenant_id);
    return { text };
}

/**
 * Handle Experience Selection
 */
async function handleExperienceSelection(message, session, analysis) {
    const collectedData = JSON.parse(session.collected_data || '{}');
    collectedData.experience_years_stated = message.trim();

    await updateSession(session.id, {
        state: STATES.CV_REQUEST,
        collected_data: JSON.stringify(collectedData)
    });

    const text = await getGreeting('cv_request', session.detected_language, session.tenant_id);
    return { text };
}

/**
 * Handle Thanks
 */
async function handleThanks(session, language) {
    const text = await getGreeting('thanks_response', language, session.tenant_id);
    return { text };
}

/**
 * Handle Goodbye
 */
async function handleGoodbye(session, language) {
    const text = await getGreeting('goodbye', language, session.tenant_id);
    return { text };
}

/**
 * Handle question using knowledge base
 */
async function handleQuestion(message, session, language, tenantId) {
    // Search knowledge base
    const kbResults = await searchKnowledgeBase(message, language, tenantId, 3);

    if (kbResults.length > 0) {
        // Track usage
        for (const result of kbResults) {
            await trackUsage(result.id);
        }

        // Get the best answer in the user's language
        const languageKey = language === 'si' ? 'answer_si' :
            language === 'ta' ? 'answer_ta' : 'answer_en';

        let answer = kbResults[0][languageKey] || kbResults[0].answer_en || kbResults[0].answer;

        // If no answer in the detected language, generate one using AI
        if (!answer && kbResults[0].answer_en) {
            answer = await generateLanguageResponse(kbResults[0].answer_en, language);
        }

        return {
            text: answer,
            kbArticlesUsed: kbResults.map(r => r.id)
        };
    }

    // No KB match - generate generic response
    const kbContext = buildKnowledgeContext(kbResults, language);

    const systemPrompt = `You are a professional recruitment assistant for a Sri Lankan agency.
${buildLanguageContext(language)}

The user asked a question that doesn't have a pre-defined answer in the knowledge base.
Provide a helpful, professional response. If you don't know, politely say so and suggest they upload their CV or ask about the application process.

Keep your response concise (2-3 sentences).`;

    const response = await createChatCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
    ]);

    return { text: response };
}

/**
 * Handle when user provides information
 */
async function handleInfoProvided(message, session, analysis) {
    // Get current field being collected
    const currentField = session.current_field;

    if (currentField) {
        // Validate and extract the field value
        const value = await extractFieldValue(message, currentField);

        if (value) {
            // Update collected data
            const collectedData = JSON.parse(session.collected_data || '{}');
            collectedData[currentField] = value;

            // Get next missing field
            const missingFields = JSON.parse(session.missing_fields || '[]');
            const nextFieldIndex = missingFields.indexOf(currentField);
            const nextField = missingFields[nextFieldIndex + 1] || null;

            await updateSession(session.id, {
                collected_data: JSON.stringify(collectedData),
                current_field: nextField
            });

            if (nextField) {
                // Ask for next field
                const prompt = getFieldPrompt(nextField, analysis.language.detected);
                return {
                    text: `✓ Got it!\n\n${prompt}`,
                    nextField
                };
            } else {
                // All fields collected
                await updateSession(session.id, { state: STATES.COMPLETE });
                const text = await getGreeting('complete', analysis.language.detected, session.tenant_id);
                return { text };
            }
        }
    }

    // Couldn't extract value, ask again
    const prompt = getFieldPrompt(currentField || 'full_name', analysis.language.detected);
    return {
        text: `I couldn't quite understand that. ${prompt}`,
        nextField: currentField
    };
}

/**
 * Handle contextual response (general flow)
 */
async function handleContextualResponse(message, session, analysis, hasCV, tenantId) {
    const language = analysis.language.detected;

    // Get knowledge base context
    const kbResults = await searchKnowledgeBase(message, language, tenantId, 2);
    const kbContext = buildKnowledgeContext(kbResults, language);

    // Build system prompt based on state
    let systemPrompt = `You are a professional recruitment assistant named "Dewan Assistant" for a Sri Lankan agency.

${buildLanguageContext(language)}

CURRENT STATE: ${session.state}
HAS CV: ${hasCV}
COLLECTED DATA: ${session.collected_data || '{}'}
MISSING FIELDS: ${session.missing_fields || '[]'}

${kbContext}

OBJECTIVES (Priority Order):
1. If no CV: Politely request CV upload (photo or PDF)
2. If CV exists but info missing: Ask for the next missing field one at a time
3. If user asks questions: Answer using knowledge base above
4. Always be patient, professional, and empathetic
5. Keep responses concise (2-4 sentences max)

IMPORTANT: 
- If user seems frustrated, acknowledge their feelings and simplify
- Never provide incorrect information
- If unsure, offer to connect with a human recruiter`;

    // Include conversation history
    const conversationHistory = await getRecentMessages(session.candidate_id, 5);

    const messages = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: message }
    ];

    const response = await createChatCompletion(messages);

    return {
        text: response,
        kbArticlesUsed: kbResults.map(r => r.id)
    };
}

/**
 * Handle profanity with de-escalation
 */
async function handleProfanity(session, language, sentiment) {
    // De-escalate with empathy
    const text = await getGreeting('frustrated', language, session.tenant_id);

    // Update frustration tracking
    await updateSession(session.id, {
        frustration_level: Math.min((session.frustration_level || 0) + 2, 10)
    });

    return { text };
}

/**
 * Handle human handoff request
 */
async function handleHumanHandoff(session, language) {
    await updateSession(session.id, { state: STATES.HUMAN_HANDOFF });

    const messages = {
        en: "I understand you'd like to speak with a human. A recruiter will contact you shortly during business hours (9 AM - 6 PM, Asia/Colombo). Thank you for your patience! 🙏",
        si: "ඔබ අපේ නියෝජිතයෙක් සමඟ කතා කිරීමට කැමති බව මට තේරෙනවා. ව්‍යාපාර වේලාවන්හිදී (පෙ.ව. 9 - ප.ව. 6) බඳවා ගැනීමේ නිලධාරියෙක් ඔබව සම්බන්ධ කරගනී. ස්තුතියි! 🙏",
        ta: "நீங்கள் ஒருவரிடம் பேச விரும்புகிறீர்கள் என்பது புரிகிறது. வணிக நேரங்களில் (காலை 9 - மாலை 6) ஒரு ஆட்சேர்ப்பாளர் உங்களைத் தொடர்புகொள்வார். நன்றி! 🙏"
    };

    return { text: messages[language] || messages.en };
}

/**
 * Extract field value from user message
 */
async function extractFieldValue(message, fieldName) {
    // Use AI to extract the specific field
    const systemPrompt = `Extract the value for "${fieldName}" from the user's message.
Return ONLY the extracted value, nothing else.
If the value is not provided or unclear, return "NONE".

Field types:
- full_name: Full name (e.g., "John Smith")
- phone: Phone number (digits, may include country code)
- email: Email address
- nic_no: Sri Lankan NIC number (old: 9 digits + V/X, new: 12 digits)
- passport_no: Passport number or "N/A"
- dob: Date in YYYY-MM-DD format
- position_applied_for: Job title/role
- address: Street address`;

    try {
        const response = await createChatCompletion([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
        ], { temperature: 0, max_tokens: 100 });

        const value = response.trim();
        return value === 'NONE' ? null : value;
    } catch (error) {
        console.error('Field extraction error:', error);
        return null;
    }
}

/**
 * Generate response in a specific language
 */
async function generateLanguageResponse(englishText, targetLanguage) {
    if (targetLanguage === 'en') return englishText;

    const languageNames = { si: 'Sinhala', ta: 'Tamil' };

    const response = await createChatCompletion([
        {
            role: 'system',
            content: `Translate the following text to ${languageNames[targetLanguage]}. Use native script. Keep the same meaning and tone.`
        },
        { role: 'user', content: englishText }
    ]);

    return response;
}

// ============================================
// SESSION MANAGEMENT
// ============================================

/**
 * Get or create conversation session
 */
async function getOrCreateSession(candidateId, tenantId = null, channel = 'whatsapp') {
    try {
        // Try to find existing active session
        const queriedSession = await pool.query(
            `SELECT * FROM conversation_sessions 
             WHERE candidate_id = $1 AND channel = $2 
             AND state != 'complete' AND state != 'human_handoff'
             ORDER BY last_interaction_at DESC LIMIT 1`,
            [candidateId, channel]
        );

        if (queriedSession.rows.length > 0) {
            return queriedSession.rows[0];
        }

        // Create new session
        const insertedSession = await pool.query(
            `INSERT INTO conversation_sessions 
             (candidate_id, tenant_id, channel, state, collected_data, missing_fields)
             VALUES ($1, $2, $3, 'greeting', '{}', '[]') RETURNING id`,
            [candidateId, tenantId, channel]
        );

        return {
            id: insertedSession.rows[0].id,
            candidate_id: candidateId,
            tenant_id: tenantId,
            channel,
            state: 'greeting',
            collected_data: '{}',
            missing_fields: '[]',
            detected_language: 'en',
            message_count: 0,
            frustration_level: 0
        };
    } catch (error) {
        console.error('Session management error:', error);
        throw error;
    }
}

/**
 * Update session
 */
async function updateSession(sessionId, updates) {
    const fields = [];
    const values = [];

    let paramIndex = 1;
    for (const [key, value] of Object.entries(updates)) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
    }

    values.push(sessionId);

    await pool.query(
        `UPDATE conversation_sessions SET ${fields.join(', ')}, last_interaction_at = NOW() WHERE id = $${paramIndex}`,
        values
    );

    // Return updated session
    const queriedSession = await pool.query('SELECT * FROM conversation_sessions WHERE id = $1', [sessionId]);
    return queriedSession.rows[0];
}

/**
 * Get recent messages for conversation context
 */
async function getRecentMessages(candidateId, limit = 10) {
    const queriedMessages = await pool.query(
        `SELECT content, direction 
         FROM communications 
         WHERE candidate_id = $1 AND message_type = 'text'
         ORDER BY sent_at DESC LIMIT $2`,
        [candidateId, limit]
    );

    return queriedMessages.rows.reverse().map(row => ({
        role: row.direction === 'inbound' ? 'user' : 'assistant',
        content: row.content
    }));
}

/**
 * Set missing fields based on CV data
 */
async function setMissingFields(sessionId, cvParsedData, requiredFields = null) {
    const defaultRequired = ['full_name', 'phone', 'email', 'nic_no', 'dob', 'position_applied_for'];
    const required = requiredFields || defaultRequired;

    const missing = required.filter(field => !cvParsedData[field]);

    await updateSession(sessionId, {
        collected_data: JSON.stringify(cvParsedData),
        missing_fields: JSON.stringify(missing),
        current_field: missing[0] || null,
        state: missing.length > 0 ? STATES.COLLECTING_INFO : STATES.COMPLETE
    });

    return missing;
}

module.exports = {
    STATES,
    INTENTS,
    generateResponse,
    classifyIntent,
    analyzeSentiment,
    getOrCreateSession,
    updateSession,
    setMissingFields
};
