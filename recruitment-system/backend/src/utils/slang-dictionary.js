/**
 * Sri Lankan Slang & Dialect Dictionary
 * 
 * Comprehensive mapping of informal expressions in:
 * - Sri Lankan English (Singlish)
 * - Sinhala colloquialisms & transliterations
 * - Tamil colloquialisms & transliterations
 * 
 * Used for:
 * 1. Language detection enhancement
 * 2. Normalizing text before AI processing
 * 3. Profanity filtering
 */

// ============================================
// SRI LANKAN ENGLISH SLANG (SINGLISH)
// ============================================
const SINGLISH_PATTERNS = {
    // Common filler words to normalize/remove
    'no?': '',                          // Filler at end of sentences
    'men': '',                          // Casual filler "What men?"
    'machang': 'friend',                // Buddy/Friend
    'machan': 'friend',
    'macho': 'friend',
    'bro': 'friend',
    'aiya': 'brother',                  // Older brother/respectful
    'akka': 'sister',                   // Older sister
    'malli': 'younger brother',
    'nangi': 'younger sister',
    'uncle': 'sir',                     // Respectful term for older men
    'aunty': 'madam',                   // Respectful term for older women

    // Expressions
    'aiyo': 'oh',                       // Exclamation (distress/surprise)
    'aiyoo': 'oh',
    'aney': 'please',                   // Pleading
    'ane': 'please',
    'yakko': 'hey',                     // Informal greeting
    'yako': 'hey',
    'api': 'we',
    'oya': 'you',

    // Common phrases
    'can ah': 'is it possible',
    'got ah': 'do you have',
    'there ah': 'is it there',
    'like that': 'that way',
    'what to do': 'what can be done',
    'only no': 'right',
    'itself': 'only',                   // "Today itself" = "Today only"

    // Job-related slang
    'work eka': 'the job',
    'job eka': 'the job',
    'company eka': 'the company',
    'salary eka': 'the salary',
    'apply karanawa': 'to apply',

    // Affirmations
    'okay da': 'is it okay',
    'hondai': 'good',                   // Singlish-Sinhala mix
    'supiri': 'great',
};

// ============================================
// SINHALA TRANSLITERATIONS & COLLOQUIALISMS
// Romanized Sinhala commonly typed in chat
// ============================================
const SINHALA_TRANSLITERATIONS = {
    // Greetings
    'ayubowan': { si: 'ආයුබෝවන්', en: 'Hello/Welcome' },
    'kohomada': { si: 'කොහොමද', en: 'How are you?' },
    'kohomad': { si: 'කොහොමද', en: 'How are you?' },
    'hondai': { si: 'හොඳයි', en: 'Good/Fine' },
    'hondin': { si: 'හොඳින්', en: 'Well/Fine' },
    'istuti': { si: 'ස්තුතියි', en: 'Thank you' },
    'sthuthi': { si: 'ස්තුතියි', en: 'Thank you' },
    'bohoma sthuthi': { si: 'බොහොම ස්තුතියි', en: 'Thank you very much' },

    // Common words
    'eka': { si: 'එක', en: 'the/one' },
    'ewa': { si: 'ඒවා', en: 'those' },
    'mehema': { si: 'මෙහෙම', en: 'like this' },
    'ehema': { si: 'එහෙම', en: 'like that' },
    'api': { si: 'අපි', en: 'we' },
    'mama': { si: 'මම', en: 'I' },
    'oyata': { si: 'ඔයාට', en: 'to you' },
    'mata': { si: 'මට', en: 'to me' },
    'karanawa': { si: 'කරනවා', en: 'doing/to do' },
    'yanawa': { si: 'යනවා', en: 'going' },
    'enawa': { si: 'එනවා', en: 'coming' },
    'kiyanawa': { si: 'කියනවා', en: 'saying/to say' },
    'balanna': { si: 'බලන්න', en: 'look/see' },
    'thiyenawa': { si: 'තියෙනවා', en: 'have/there is' },
    'nehe': { si: 'නෑ', en: 'no/not' },
    'naa': { si: 'නෑ', en: 'no/not' },
    'ow': { si: 'ඔව්', en: 'yes' },
    'owwa': { si: 'ඔව්', en: 'yes' },

    // Job-related
    'rakiyawa': { si: 'රැකියාව', en: 'job' },
    'job eka': { si: 'ජොබ් එක', en: 'the job' },
    'wetupa': { si: 'වැටුප', en: 'salary' },
    'aydum karanawa': { si: 'අයදුම් කරනවා', en: 'applying' },
    'cv eka': { si: 'CV එක', en: 'the CV' },
    'passport eka': { si: 'පාස්පෝට් එක', en: 'the passport' },

    // Questions
    'mokakda': { si: 'මොකක්ද', en: 'what is it' },
    'monawada': { si: 'මොනවද', en: 'what' },
    'koheda': { si: 'කොහෙද', en: 'where' },
    'kawada': { si: 'කවදද', en: 'when' },
    'aei': { si: 'ඇයි', en: 'why' },
    'kiiyada': { si: 'කීයද', en: 'how much' },
    'kohomada karanney': { si: 'කොහොමද කරන්නේ', en: 'how to do' },
};

// ============================================
// TAMIL TRANSLITERATIONS & COLLOQUIALISMS
// Romanized Tamil commonly typed in chat
// ============================================
const TAMIL_TRANSLITERATIONS = {
    // Greetings
    'vanakkam': { ta: 'வணக்கம்', en: 'Hello' },
    'nandri': { ta: 'நன்றி', en: 'Thank you' },
    'romba nandri': { ta: 'ரொம்ப நன்றி', en: 'Thank you very much' },

    // Common words
    'enna': { ta: 'என்ன', en: 'what' },
    'eppadi': { ta: 'எப்படி', en: 'how' },
    'enga': { ta: 'எங்கே', en: 'where' },
    'eppo': { ta: 'எப்போ', en: 'when' },
    'yaaru': { ta: 'யார்', en: 'who' },
    'enakku': { ta: 'எனக்கு', en: 'for me' },
    'unakku': { ta: 'உனக்கு', en: 'for you' },
    'naan': { ta: 'நான்', en: 'I' },
    'nee': { ta: 'நீ', en: 'you' },
    'aama': { ta: 'ஆமா', en: 'yes' },
    'illa': { ta: 'இல்ல', en: 'no' },
    'illai': { ta: 'இல்லை', en: 'no/not' },
    'seri': { ta: 'சரி', en: 'okay' },
    'sariya': { ta: 'சரியா', en: 'is it correct' },

    // Job-related
    'velai': { ta: 'வேலை', en: 'job/work' },
    'sambalam': { ta: 'சம்பளம்', en: 'salary' },
    'apply panna': { ta: 'அப்ளை பண்ண', en: 'to apply' },
    'company': { ta: 'கம்பெனி', en: 'company' },

    // Expressions
    'aiyo': { ta: 'ஐயோ', en: 'oh no' },
    'aiyayo': { ta: 'ஐயய்யோ', en: 'oh dear' },
    'paravala': { ta: 'பரவாயில்ல', en: 'no problem' },
    'theriyala': { ta: 'தெரியல', en: 'don\'t know' },
    'theriyum': { ta: 'தெரியும்', en: 'know' },
    'sollungo': { ta: 'சொல்லுங்க', en: 'please tell' },
    'konjam': { ta: 'கொஞ்சம்', en: 'a little' },

    // Questions
    'enna venum': { ta: 'என்ன வேணும்', en: 'what do you need' },
    'evlo': { ta: 'எவ்வளவு', en: 'how much' },
    'eppadi apply': { ta: 'எப்படி அப்ளை', en: 'how to apply' },
};

// ============================================
// PROFANITY & INAPPROPRIATE CONTENT FILTERS
// Words/patterns that indicate frustration
// ============================================
const PROFANITY_PATTERNS = {
    // English profanity (mild - common in frustrated messages)
    english: [
        'damn', 'hell', 'crap', 'stupid', 'idiot', 'useless',
        'waste', 'nonsense', 'rubbish', 'bullshit', 'wtf',
        'bloody', 'bastard', 'ass', 'shit'
    ],

    // Sinhala profanity indicators (romanized)
    sinhala: [
        'huththo', 'ponnaya', 'ballo', 'kariya', 'pakaya',
        'kari', 'pissu', 'betha', 'modaya'
    ],

    // Tamil profanity indicators (romanized)
    tamil: [
        'otha', 'thevdiya', 'punda', 'sunni', 'koothi',
        'loosu', 'muttal', 'kadama'
    ]
};

// ============================================
// FRUSTRATION INDICATORS
// Patterns that suggest user is frustrated
// ============================================
const FRUSTRATION_PATTERNS = [
    // Repeated punctuation
    /[!?]{2,}/,                     // "What??" "Hello!!!"
    /\.{3,}/,                       // "..."

    // All caps (shouting)
    /^[A-Z\s!?]{10,}$/,            // All caps messages

    // Specific phrases
    'not working',
    'doesn\'t work',
    'can\'t understand',
    'don\'t understand',
    'waste of time',
    'useless bot',
    'talk to human',
    'real person',
    'speak to someone',
    'this is stupid',
    'are you a bot',
    'kohomada therenne nehe',       // Sinhala: "doesn't understand"
    'gahapan',                      // Sinhala: "hit it" (frustration)
    'theriyala',                    // Tamil: "don't understand"
    'podhu waste',                  // Tamil: "total waste"
];

// ============================================
// LANGUAGE DETECTION HELPERS
// Patterns unique to each language
// ============================================
const LANGUAGE_PATTERNS = {
    sinhala: {
        // Sinhala Unicode range
        unicodeRange: /[\u0D80-\u0DFF]/,
        // Common Sinhala-only words (romanized)
        markers: ['eka', 'karanawa', 'thiyenawa', 'yanawa', 'enawa', 'oyata', 'mata', 'api', 'oya', 'mage', 'uge', 'ehema', 'mehema'],
        // Sinhala sentence endings
        endings: ['nne', 'nawa', 'wada', 'yako', 'yanna', 'wanna', 'ganna']
    },
    tamil: {
        // Tamil Unicode range
        unicodeRange: /[\u0B80-\u0BFF]/,
        // Common Tamil-only words (romanized)
        markers: ['enakku', 'unakku', 'naan', 'nee', 'panna', 'sollungo', 'theriyum', 'velai', 'aama', 'illai', 'enna', 'enga', 'eppo'],
        // Tamil sentence endings
        endings: ['nga', 'ngo', 'nunga', 'poma', 'lam', 'ko', 'inga']
    },
    english: {
        // Basic English detection
        markers: ['the', 'is', 'are', 'have', 'has', 'will', 'would', 'could', 'please', 'thank', 'hello', 'apply', 'job', 'work'],
        // English question words
        questions: ['what', 'where', 'when', 'how', 'why', 'who', 'which']
    }
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Normalize slang in a message to more formal language
 * @param {string} text - Input text
 * @returns {string} - Normalized text
 */
function normalizeSlang(text) {
    let normalized = text.toLowerCase();

    // Apply Singlish patterns
    for (const [slang, replacement] of Object.entries(SINGLISH_PATTERNS)) {
        const regex = new RegExp(`\\b${escapeRegex(slang)}\\b`, 'gi');
        normalized = normalized.replace(regex, replacement);
    }

    // Clean up extra spaces
    normalized = normalized.replace(/\s+/g, ' ').trim();

    return normalized;
}

/**
 * Detect if text contains profanity
 * @param {string} text - Input text
 * @returns {{ hasProfanity: boolean, language: string|null, severity: string }}
 */
function detectProfanity(text) {
    const lowerText = text.toLowerCase();

    for (const word of PROFANITY_PATTERNS.english) {
        if (lowerText.includes(word)) {
            return { hasProfanity: true, language: 'en', severity: 'mild' };
        }
    }

    for (const word of PROFANITY_PATTERNS.sinhala) {
        if (lowerText.includes(word)) {
            return { hasProfanity: true, language: 'si', severity: 'strong' };
        }
    }

    for (const word of PROFANITY_PATTERNS.tamil) {
        if (lowerText.includes(word)) {
            return { hasProfanity: true, language: 'ta', severity: 'strong' };
        }
    }

    return { hasProfanity: false, language: null, severity: 'none' };
}

/**
 * Detect frustration level from message
 * @param {string} text - Input text
 * @returns {{ isFrustrated: boolean, level: number, indicators: string[] }}
 */
function detectFrustration(text) {
    const indicators = [];
    let level = 0;

    // Check patterns
    for (const pattern of FRUSTRATION_PATTERNS) {
        if (pattern instanceof RegExp) {
            if (pattern.test(text)) {
                indicators.push('pattern_match');
                level += 2;
            }
        } else if (text.toLowerCase().includes(pattern)) {
            indicators.push(pattern);
            level += 3;
        }
    }

    // Check for profanity (adds to frustration)
    const profanityCheck = detectProfanity(text);
    if (profanityCheck.hasProfanity) {
        indicators.push('profanity');
        level += profanityCheck.severity === 'strong' ? 4 : 2;
    }

    // Cap at 10
    level = Math.min(level, 10);

    return {
        isFrustrated: level >= 3,
        level,
        indicators
    };
}

/**
 * Enhanced language detection using patterns
 * @param {string} text - Input text
 * @returns {{ language: string, confidence: number, mixed: boolean }}
 */
function detectLanguageFromPatterns(text) {
    const scores = { en: 0, si: 0, ta: 0 };

    // Check Unicode ranges (definitive)
    if (LANGUAGE_PATTERNS.sinhala.unicodeRange.test(text)) {
        scores.si += 10;
    }
    if (LANGUAGE_PATTERNS.tamil.unicodeRange.test(text)) {
        scores.ta += 10;
    }

    const lowerText = text.toLowerCase();
    const words = lowerText.split(/\s+/);

    // Check word markers
    for (const word of words) {
        if (LANGUAGE_PATTERNS.sinhala.markers.includes(word)) scores.si += 2;
        if (LANGUAGE_PATTERNS.tamil.markers.includes(word)) scores.ta += 2;
        if (LANGUAGE_PATTERNS.english.markers.includes(word)) scores.en += 1;
    }

    // Check endings
    for (const word of words) {
        for (const ending of LANGUAGE_PATTERNS.sinhala.endings) {
            if (word.endsWith(ending)) scores.si += 1;
        }
        for (const ending of LANGUAGE_PATTERNS.tamil.endings) {
            if (word.endsWith(ending)) scores.ta += 1;
        }
    }

    // Determine winner
    const maxScore = Math.max(scores.en, scores.si, scores.ta);
    let language = 'en';

    if (scores.si === maxScore && scores.si > 0) language = 'si';
    else if (scores.ta === maxScore && scores.ta > 0) language = 'ta';
    else if (scores.en === maxScore) language = 'en';

    // Check if mixed language
    const nonZeroScores = Object.values(scores).filter(s => s > 0).length;

    return {
        language,
        confidence: maxScore > 5 ? 0.9 : maxScore > 2 ? 0.7 : 0.5,
        mixed: nonZeroScores > 1,
        scores
    };
}

/**
 * Get translation of a transliterated word
 * @param {string} word - Transliterated word
 * @returns {{ original: string, native: string, english: string, language: string } | null}
 */
function getTransliteration(word) {
    const lowerWord = word.toLowerCase();

    if (SINHALA_TRANSLITERATIONS[lowerWord]) {
        return {
            original: word,
            native: SINHALA_TRANSLITERATIONS[lowerWord].si,
            english: SINHALA_TRANSLITERATIONS[lowerWord].en,
            language: 'si'
        };
    }

    if (TAMIL_TRANSLITERATIONS[lowerWord]) {
        return {
            original: word,
            native: TAMIL_TRANSLITERATIONS[lowerWord].ta,
            english: TAMIL_TRANSLITERATIONS[lowerWord].en,
            language: 'ta'
        };
    }

    return null;
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
    SINGLISH_PATTERNS,
    SINHALA_TRANSLITERATIONS,
    TAMIL_TRANSLITERATIONS,
    PROFANITY_PATTERNS,
    FRUSTRATION_PATTERNS,
    LANGUAGE_PATTERNS,
    normalizeSlang,
    detectProfanity,
    detectFrustration,
    detectLanguageFromPatterns,
    getTransliteration
};
