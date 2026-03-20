/**
 * Language Processor Service
 * 
 * Advanced trilingual support for the recruitment chatbot:
 * - Enhanced language detection (with slang pattern recognition)
 * - Message normalization
 * - Dynamic language switching
 * - Translation helpers
 */

const { pool } = require('../config/database');
const {
    normalizeSlang,
    detectLanguageFromPatterns,
    detectProfanity,
    detectFrustration,
    SINHALA_TRANSLITERATIONS,
    TAMIL_TRANSLITERATIONS
} = require('../utils/slang-dictionary');

// Language codes
const LANGUAGES = {
    ENGLISH: 'en',
    SINHALA: 'si',
    TAMIL: 'ta'
};

// Language display names
const LANGUAGE_NAMES = {
    en: { en: 'English', si: 'ඉංග්‍රීසි', ta: 'ஆங்கிலம்' },
    si: { en: 'Sinhala', si: 'සිංහල', ta: 'சிங்களம்' },
    ta: { en: 'Tamil', si: 'දෙමළ', ta: 'தமிழ்' }
};

/**
 * Analyze a message for language, sentiment, and content
 * @param {string} text - Input message
 * @returns {Promise<MessageAnalysis>}
 */
async function analyzeMessage(text) {
    // 1. Detect language using patterns
    const languageDetection = detectLanguageFromPatterns(text);

    // 2. Check for profanity
    const profanityCheck = detectProfanity(text);

    // 3. Check frustration level
    const frustrationCheck = detectFrustration(text);

    // 4. Normalize slang
    const normalizedText = normalizeSlang(text);

    // 5. Extract any transliterated words
    const transliterations = extractTransliterations(text);

    return {
        original: text,
        normalized: normalizedText,
        language: {
            detected: languageDetection.language,
            confidence: languageDetection.confidence,
            isMixed: languageDetection.mixed,
            scores: languageDetection.scores
        },
        profanity: profanityCheck,
        frustration: frustrationCheck,
        transliterations,
        metadata: {
            wordCount: text.split(/\s+/).length,
            hasUnicode: /[^\x00-\x7F]/.test(text),
            isQuestion: /\?|kohomad|mokakd|enna|eppadi|evlo|kiiyad/i.test(text)
        }
    };
}

/**
 * Extract transliterated words from text
 * @param {string} text - Input text
 * @returns {Array<{word: string, native: string, english: string, language: string}>}
 */
function extractTransliterations(text) {
    const words = text.toLowerCase().split(/\s+/);
    const found = [];

    for (const word of words) {
        // Check Sinhala transliterations
        if (SINHALA_TRANSLITERATIONS[word]) {
            found.push({
                word,
                native: SINHALA_TRANSLITERATIONS[word].si,
                english: SINHALA_TRANSLITERATIONS[word].en,
                language: 'si'
            });
        }
        // Check Tamil transliterations
        if (TAMIL_TRANSLITERATIONS[word]) {
            found.push({
                word,
                native: TAMIL_TRANSLITERATIONS[word].ta,
                english: TAMIL_TRANSLITERATIONS[word].en,
                language: 'ta'
            });
        }
    }

    return found;
}

/**
 * Get greeting in specified language
 * @param {string} greetingType - Type of greeting (welcome, cv_request, etc.)
 * @param {string} language - Language code (en, si, ta)
 * @param {string} tenantId - Optional tenant ID for custom greetings
 * @returns {Promise<string>}
 */
async function getGreeting(greetingType, language = 'en', tenantId = null) {
    try {
        // Try to get tenant-specific greeting
        if (tenantId) {
            const result = await pool.query(
                `SELECT greeting_${greetingType} as greeting FROM chatbot_config WHERE tenant_id = $1`,
                [tenantId]
            );

            if (result.rows && result.rows.length > 0 && result.rows[0].greeting) {
                const greetings = JSON.parse(result.rows[0].greeting);
                if (greetings[language]) {
                    return greetings[language];
                }
            }
        }

        // Fallback to default greetings
        return getDefaultGreeting(greetingType, language);
    } catch (error) {
        console.error('Error getting greeting:', error);
        return getDefaultGreeting(greetingType, language);
    }
}

/**
 * Default greetings when no custom config exists
 */
function getDefaultGreeting(type, language) {
    const defaults = {
        welcome: {
            en: "Hello! Welcome to Dewan Recruitment. I'm here to help you apply for overseas jobs. 🙏",
            si: "ආයුබෝවන්! ඩිවාන් බඳවා ගැනීමේ සේවාවට සාදරයෙන් පිළිගනිමු. විදේශ රැකියා සඳහා අයදුම් කිරීමට මම ඔබට උදව් කරන්නම්. 🙏",
            ta: "வணக்கம்! டிவான் ஆட்சேர்ப்புக்கு வரவேற்கிறோம். வெளிநாட்டு வேலைகளுக்கு விண்ணப்பிக்க நான் உதவுவேன். 🙏"
        },
        language_selection: {
            en: "To continue, please choose your preferred language / ඉදිරියට යාමට ඔබ කැමති භාෂාව තෝරන්න / தொடர உங்களுக்கு விருப்பமான மொழியைத் தேர்ந்தெடுக்கவும்:\n\n1️⃣ English\n2️⃣ සිංහල\n3️⃣ தமிழ்",
            si: "To continue, please choose your preferred language / ඉදිරියට යාමට ඔබ කැමති භාෂාව තෝරන්න / தொடர உங்களுக்கு விருப்பமான மொழியைத் தேர்ந்தெடுக்கவும்:\n\n1️⃣ English\n2️⃣ සිංහල\n3️⃣ தமிழ்",
            ta: "To continue, please choose your preferred language / ඉදිරියට යාමට ඔබ කැමති භාෂාව තෝරන්න / தொடர உங்களுக்கு விருப்பமான மொழியைத் தேர்ந்தெடுக்கவும்:\n\n1️⃣ English\n2️⃣ සිංහල\n3️⃣ தமிழ்",
        },
        job_interest: {
            en: "What kind of job are you looking for? Any particular role or industry in mind? 🎯",
            si: "ඔබ සොයන්නේ කුමන ආකාරයේ රැකියාවක්ද? විශේෂිත ක්ෂේත්‍රයක් ගැන බලාපොරොත්තුවක් තිබෙනවද? 🎯",
            ta: "நீங்கள் எந்த வகையான வேலையை தேடுகிறீர்கள்? குறிப்பிட்ட துறை அல்லது பதவி ஏதேனும் மனதில் உள்ளதா? 🎯"
        },
        destination_country: {
            en: "Which country are you interested in working in? 🌍",
            si: "ඔබ සේවය කිරීමට කැමති කුමන රටකද? 🌍",
            ta: "நீங்கள் எந்த நாட்டில் வேலை செய்ய விரும்புகிறீர்கள்? 🌍"
        },
        experience_years: {
            en: "How many years of experience do you have in this field? 📊",
            si: "මෙම ක්ෂේත්‍රයේ ඔබට කොපමණ වසරක පළපුරුද්දක් තිබෙනවද? 📊",
            ta: "இந்தத் துறையில் உங்களுக்கு எத்தனை வருட அனுபவம் உள்ளது? 📊"
        },
        cv_request: {
            en: "Perfect! Almost there 😊 Could you please send me your CV? PDF or Word works great.",
            si: "ඉතා හොඳයි! අපි අවසන් අදියරේ සිටින්නේ 😊 කරුණාකර ඔබගේ CV එක එවන්න පුළුවන්ද? PDF හෝ Word ආකෘතිය වඩාත් සුදුසුයි.",
            ta: "மிக நன்று! நாம் இறுதி கட்டத்தை நெருங்கிவிட்டோம் 😊 தயவுசெய்து உங்கள் CV-யை அனுப்ப முடியுமா? PDF அல்லது Word வடிவம் சிறந்தது."
        },
        cv_received: {
            en: "Thank you! I've received your CV. Let me review it... 📄",
            si: "ස්තුතියි! ඔබේ CV එක ලැබුණා. මම එය පරීක්ෂා කරනවා... 📄",
            ta: "நன்றி! உங்கள் CV கிடைத்தது. நான் பார்க்கிறேன்... 📄"
        },
        complete: {
            en: "Excellent! Your application is complete. A recruiter will contact you within 2-3 business days. Good luck! 🌟",
            si: "නියමයි! ඔබේ අයදුම්පත සම්පූර්ණයි. දින 2-3ක් ඇතුළත බඳවා ගැනීමේ නිලධාරියෙක් ඔබව සම්බන්ධ කරගනී. සුභ පැතුම්! 🌟",
            ta: "அருமை! உங்கள் விண்ணப்பம் முடிந்தது. 2-3 நாட்களில் ஆட்சேர்ப்பாளர் தொடர்புகொள்வார். வாழ்த்துக்கள்! 🌟"
        },
        frustrated: {
            en: "I understand this can be frustrating. Let me simplify - just tell me what you need help with. 💙",
            si: "මට තේරෙනවා මෙය අපහසු විය හැකි බව. සරලව කියන්න - ඔබට කුමක් උදව් ඕනෑද? 💙",
            ta: "புரிகிறது, இது கஷ்டமாக இருக்கலாம். எளிமையாக சொல்லுங்கள் - என்ன உதவி வேண்டும்? 💙"
        },
        thanks_response: {
            en: "You're welcome! Is there anything else I can help with?",
            si: "සතුටුයි! තව මොකක් හරි උදව්වක් ඕනෙද?",
            ta: "மகிழ்ச்சி! வேறு ஏதாவது உதவி வேண்டுமா?"
        },
        goodbye: {
            en: "Goodbye! Feel free to message again if you need help. 👋",
            si: "ආයුබෝවන්! උදව් ඕනෙ නම් නැවත message කරන්න. 👋",
            ta: "பிரியாவிடை! உதவி தேவைப்பட்டால் மீண்டும் தொடர்புகொள்ளுங்கள். 👋"
        },
        ask_field: {
            full_name: {
                en: "What is your full name as shown on your passport?",
                si: "ඔබේ ගමන් බලපත්‍රයේ ඇති පූර්ණ නම කුමක්ද?",
                ta: "உங்கள் பாஸ்போர்ட்டில் உள்ள முழு பெயர் என்ன?"
            },
            phone: {
                en: "What is your contact phone number?",
                si: "ඔබේ දුරකථන අංකය කුමක්ද?",
                ta: "உங்கள் தொடர்பு தொலைபேசி எண் என்ன?"
            },
            email: {
                en: "What is your email address?",
                si: "ඔබේ email ලිපිනය කුමක්ද?",
                ta: "உங்கள் மின்னஞ்சல் முகவரி என்ன?"
            },
            nic_no: {
                en: "What is your NIC (National Identity Card) number?",
                si: "ඔබේ ජාතික හැඳුනුම්පත් අංකය කුමක්ද?",
                ta: "உங்கள் தேசிய அடையாள அட்டை எண் என்ன?"
            },
            passport_no: {
                en: "What is your passport number? (Reply 'N/A' if you don't have one yet)",
                si: "ඔබේ ගමන් බලපත් අංකය කුමක්ද? (නැත්නම් 'N/A' කියන්න)",
                ta: "உங்கள் பாஸ்போர்ட் எண் என்ன? (இல்லையென்றால் 'N/A' என்று பதிலளிக்கவும்)"
            },
            dob: {
                en: "What is your date of birth? (Format: YYYY-MM-DD, e.g., 1990-05-15)",
                si: "ඔබේ උපන් දිනය කුමක්ද? (ආකෘතිය: YYYY-MM-DD, උදා: 1990-05-15)",
                ta: "உங்கள் பிறந்த தேதி என்ன? (வடிவம்: YYYY-MM-DD, எ.கா., 1990-05-15)"
            },
            position_applied_for: {
                en: "Which position are you interested in applying for?",
                si: "ඔබ අයදුම් කිරීමට කැමති තනතුර කුමක්ද?",
                ta: "எந்த பதவிக்கு விண்ணப்பிக்க ஆர்வமாக உள்ளீர்கள்?"
            },
            address: {
                en: "What is your current address?",
                si: "ඔබේ වර්තමාන ලිපිනය කුමක්ද?",
                ta: "உங்கள் தற்போதைய முகவரி என்ன?"
            }
        }
    };

    if (type === 'ask_field') {
        return defaults.ask_field;
    }

    return defaults[type]?.[language] || defaults[type]?.en || "Hello! How can I help you?";
}

/**
 * Get field prompt in the specified language
 * @param {string} fieldName - Field to ask about
 * @param {string} language - Language code
 * @returns {string}
 */
function getFieldPrompt(fieldName, language = 'en') {
    const prompts = getDefaultGreeting('ask_field', language);
    return prompts[fieldName]?.[language] || prompts[fieldName]?.en || `Please provide your ${fieldName.replace(/_/g, ' ')}`;
}

/**
 * Translate a key to the specified language
 * @param {string} key - Translation key
 * @param {string} language - Language code
 * @param {string} tenantId - Optional tenant ID
 * @returns {Promise<string>}
 */
async function translate(key, language = 'en', tenantId = null) {
    try {
        const result = await pool.query(
            'SELECT value FROM translations WHERE "key" = $1 AND language = $2',
            [key, language]
        );

        if (result.rows && result.rows.length > 0) {
            return result.rows[0].value;
        }

        // Fallback to English
        if (language !== 'en') {
            const fallback = await pool.query(
                'SELECT value FROM translations WHERE "key" = $1 AND language = $2',
                [key, 'en']
            );
            if (fallback.rows && fallback.rows.length > 0) {
                return fallback.rows[0].value;
            }
        }

        return key; // Return key if no translation found
    } catch (error) {
        console.error('Translation error:', error);
        return key;
    }
}

/**
 * Determine if we should switch languages based on user message
 * @param {string} currentLanguage - Current session language
 * @param {object} analysis - Message analysis result
 * @returns {{ shouldSwitch: boolean, newLanguage: string }}
 */
function shouldSwitchLanguage(currentLanguage, analysis) {
    // If high confidence detection differs from current, suggest switch
    if (analysis.language.confidence >= 0.8 &&
        analysis.language.detected !== currentLanguage &&
        !analysis.language.isMixed) {
        return {
            shouldSwitch: true,
            newLanguage: analysis.language.detected
        };
    }

    // Check for explicit language markers in Unicode
    if (analysis.metadata.hasUnicode) {
        // Sinhala Unicode range
        if (/[\u0D80-\u0DFF]/.test(analysis.original)) {
            return {
                shouldSwitch: currentLanguage !== 'si',
                newLanguage: 'si'
            };
        }
        // Tamil Unicode range
        if (/[\u0B80-\u0BFF]/.test(analysis.original)) {
            return {
                shouldSwitch: currentLanguage !== 'ta',
                newLanguage: 'ta'
            };
        }
    }

    return { shouldSwitch: false, newLanguage: currentLanguage };
}

/**
 * Build AI context with language awareness
 * @param {string} language - Target language
 * @param {object} sessionData - Conversation session data
 * @returns {string}
 */
function buildLanguageContext(language, sessionData = {}) {
    const languageInstructions = {
        en: `Respond in English. Be professional and clear.`,
        si: `Respond in Sinhala (සිංහල). Use Unicode Sinhala script. Be professional but friendly.
Example: "ආයුබෝවන්! ඔබේ අයදුම්පත සම්පූර්ණ කිරීමට මම උදව් කරන්නම්."`,
        ta: `Respond in Tamil (தமிழ்). Use Unicode Tamil script. Be professional but friendly.
Example: "வணக்கம்! உங்கள் விண்ணப்பத்தை முடிக்க நான் உதவுவேன்."`
    };

    return `
LANGUAGE: ${LANGUAGE_NAMES[language]?.en || 'English'}
INSTRUCTION: ${languageInstructions[language] || languageInstructions.en}

If the user writes in a different language, acknowledge it and respond in their language.
If the user uses romanized Sinhala/Tamil (like "kohomada" or "eppadi"), respond in native script if the language is clear.
`.trim();
}

module.exports = {
    LANGUAGES,
    LANGUAGE_NAMES,
    analyzeMessage,
    extractTransliterations,
    getGreeting,
    getDefaultGreeting,
    getFieldPrompt,
    translate,
    shouldSwitchLanguage,
    buildLanguageContext
};
