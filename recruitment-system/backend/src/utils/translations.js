/**
 * Multilingual translation system
 * Supports English (en), Sinhala (si), Tamil (ta)
 */

const translations = {
    // Greetings
    greeting: {
        en: "Hello! Welcome to our recruitment agency.",
        si: "ආයුබෝවන්! අපගේ රැකියා නියෝජිතායතනය වෙත සාදරයෙන් පිළිගනිමු.",
        ta: "வணக்கம்! எங்கள் ஆட்சேர்ப்பு நிறுவனத்திற்கு வரவேற்கிறோம்."
    },
    
    // Questions
    ask_name: {
        en: "What is your name?",
        si: "ඔබේ නම කුමක්ද?",
        ta: "உங்கள் பெயர் என்ன?"
    },
    ask_phone: {
        en: "What is your phone number?",
        si: "ඔබේ දුරකථන අංකය කුමක්ද?",
        ta: "உங்கள் தொலைபேசி எண் என்ன?"
    },
    ask_position: {
        en: "Which position are you interested in?",
        si: "ඔබ කැමති රැකියාව කුමක්ද?",
        ta: "நீங்கள் எந்த வேலைக்கு ஆர்வமாக உள்ளீர்கள்?"
    },
    ask_cv: {
        en: "Please upload your CV.",
        si: "කරුණාකර ඔබේ CV එක upload කරන්න.",
        ta: "தயவுசெய்து உங்கள் CV ஐ பதிவேற்றவும்."
    },
    ask_height: {
        en: "What is your height? (in feet/inches or cm)",
        si: "ඔබේ උස කීයද? (අඩි/අඟල් හෝ cm වලින්)",
        ta: "உங்கள் உயரம் என்ன? (அடி/அங்குலம் அல்லது cm இல்)"
    },
    ask_english_level: {
        en: "How is your English level? (Basic/Intermediate/Fluent)",
        si: "ඔබේ ඉංග්‍රීසි මට්ටම කෙසේද? (මූලික/මධ්‍යම/වඩාත් දක්ෂ)",
        ta: "உங்கள் ஆங்கில அளவு எப்படி? (அடிப்படை/இடைநிலை/சரளமான)"
    },
    ask_experience: {
        en: "How many years of experience do you have?",
        si: "ඔබට අවුරුදු කීයක අත්දැකීම් තිබේද?",
        ta: "உங்களுக்கு எத்தனை வருட அனுபவம் உள்ளது?"
    },
    
    // Responses
    thank_you: {
        en: "Thank you for your interest! We will review your application and contact you soon.",
        si: "ඔබගේ උනන්දුව පිළිබඳ ස්තුතියි! අපි ඔබගේ අයදුම්පත සමාලෝචනය කර ඉක්මනින් ඔබව සම්බන්ධ කරගන්නෙමු.",
        ta: "உங்கள் ஆர்வத்திற்கு நன்றி! நாங்கள் உங்கள் விண்ணப்பத்தை மதிப்பாய்வு செய்து விரைவில் உங்களை தொடர்பு கொள்வோம்."
    },
    cv_received: {
        en: "We have received your CV. Our team will review it shortly.",
        si: "අපි ඔබගේ CV එක ලබා ගත්තා. අපේ කණ්ඩායම ඉක්මනින් ඒක සමාලෝචනය කරනවා.",
        ta: "உங்கள் CV ஐ நாங்கள் பெற்றுள்ளோம். எங்கள் குழு விரைவில் அதை மதிப்பாய்வு செய்யும்."
    },
    interview_scheduled: {
        en: "Your interview has been scheduled for {datetime} at {location}.",
        si: "ඔබගේ සම්මුඛ පරීක්ෂණය {datetime} දින {location} හිදී සැලසුම් කර ඇත.",
        ta: "உங்கள் நேர்காணல் {datetime} அன்று {location} இல் திட்டமிடப்பட்டுள்ளது."
    },
    interview_reminder: {
        en: "Reminder: You have an interview tomorrow at {datetime} at {location}.",
        si: "සිහි කැඳවීම: ඔබට හෙට {datetime} දින {location} හිදී සම්මුඛ පරීක්ෂණයක් තිබේ.",
        ta: "நினைவூட்டல்: நாளை {datetime} அன்று {location} இல் நேர்காணல் உள்ளது."
    },
    alternative_job_suggestion: {
        en: "You don't currently meet requirements for {jobTitle} due to {reason}. However, you're a great fit for {alternativeJob}. Would you like to apply?",
        si: "{reason} හේතුවෙන් ඔබ දැනට {jobTitle} සඳහා අවශ්‍යතා සපුරා නැත. කෙසේ වෙතත්, ඔබ {alternativeJob} සඳහා ඉතා සුදුසුයි. ඔබ අයදුම් කිරීමට කැමතිද?",
        ta: "{reason} காரணமாக நீங்கள் தற்போது {jobTitle} க்கான தேவைகளை பூர்த்தி செய்யவில்லை. இருப்பினும், நீங்கள் {alternativeJob} க்கு மிகவும் பொருத்தமானவர். விண்ணப்பிக்க விரும்புகிறீர்களா?"
    },
    
    // Errors
    error_generic: {
        en: "Sorry, something went wrong. Please try again.",
        si: "සමාවන්න, යමක් වැරදී ඇත. කරුණාකර නැවත උත්සාහ කරන්න.",
        ta: "மன்னிக்கவும், ஏதோ தவறு நடந்துவிட்டது. மீண்டும் முயற்சிக்கவும்."
    },
    error_unclear: {
        en: "I didn't quite understand that. Could you please rephrase?",
        si: "මට ඒක හරියට තේරුණේ නැහැ. ඔබට නැවත කියන්න පුළුවන්ද?",
        ta: "எனக்கு அது புரியவில்லை. மீண்டும் கூற முடியுமா?"
    },
    
    // Empathy responses
    empathy_job_loss: {
        en: "I understand this is a challenging time. We're here to help you find the right opportunity.",
        si: "මට තේරෙනවා මේක අභියෝගාත්මක කාලයක් කියලා. නිවැරදි අවස්ථාව සොයා ගැනීමට අපි ඔබට උදව් කරන්නම්.",
        ta: "இது சவாலான காலம் என்பதை நான் புரிந்துகொள்கிறேன். சரியான வாய்ப்பைக் கண்டறிய உங்களுக்கு உதவ நாங்கள் இங்கு இருக்கிறோம்."
    },
    transfer_to_human: {
        en: "Let me connect you with one of our recruitment specialists who can assist you better.",
        si: "ඔබට වඩා හොඳින් උදව් කළ හැකි අපගේ රැකියා විශේෂඥයෙකු සමඟ ඔබව සම්බන්ධ කරන්නම්.",
        ta: "உங்களுக்கு சிறப்பாக உதவக்கூடிய எங்கள் ஆட்சேர்ப்பு நிபுணர் ஒருவருடன் உங்களை இணைக்கிறேன்."
    }
};

/**
 * Get translation for a key in specified language
 */
function translate(key, language = 'en', variables = {}) {
    const translation = translations[key];
    
    if (!translation) {
        console.warn(`Translation key "${key}" not found`);
        return key;
    }
    
    let text = translation[language] || translation.en || key;
    
    // Replace variables like {datetime}, {location}, etc.
    Object.keys(variables).forEach(varKey => {
        text = text.replace(new RegExp(`{${varKey}}`, 'g'), variables[varKey]);
    });
    
    return text;
}

/**
 * Get all translations for a key
 */
function getTranslations(key) {
    return translations[key] || null;
}

/**
 * Add or update translation
 */
function addTranslation(key, languageObj) {
    translations[key] = { ...translations[key], ...languageObj };
}

module.exports = {
    translations,
    translate,
    getTranslations,
    addTranslation
};
