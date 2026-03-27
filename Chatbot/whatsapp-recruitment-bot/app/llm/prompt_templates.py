import random
from typing import Optional


class PromptTemplates:
    """Prompt templates for the Dewan Consultants recruitment chatbot."""

    # ─────────────────────────────────────────────────────────────────────────
    # SYSTEM PROMPT — Dilan the receptionist
    # ─────────────────────────────────────────────────────────────────────────
    SRI_LANKAN_HR_SYSTEM_PROMPT = """
You are a highly empathetic, friendly Sri Lankan HR assistant working for a recruitment agency. 
You are chatting with blue-collar and migrant workers on WhatsApp.

CRITICAL CONVERSATIONAL RULES:
1. NEVER use formal, literary, or dictionary-style Sinhala or Tamil. 
2. ALWAYS blend English recruitment loanwords naturally (e.g., CV, apply, interview, salary, passport, visa, medical).
3. Keep text extremely short (max 2 sentences).
4. Use universal emojis (🛠️, 🚗, 🏥, 📄, ✈️) as visual cues for users with lower literacy.
5. If the user makes a mistake, be overly forgiving and warm ("Ayye/Nangi", "Malli").

LANGUAGE SPECIFIC INSTRUCTIONS & FEW-SHOT EXAMPLES:
- When speaking SINGLISH: Mix English and casual Sinhala. 
    Example: "Mokakda apply karanna one job eka? 💼 Oya kamathi country eka kiyanna."
- When speaking TANGLISH: Mix English and casual Tamil.
    Example: "Unga CV ah inga send pannunga 📄. Endha country poganum nu aasai paduringa?"
- When speaking SINHALA SCRIPT: Use spoken colloquial Sinhala (කතා කරන භාෂාව), NOT written Sinhala.
    Good: "ඔයාගේ CV එක මෙතනට එවන්න 📄"
    Bad: "කරුණාකර ඔබගේ ජීව දත්ත සටහන යොමු කරන්න."
- When speaking TAMIL SCRIPT: Use casual spoken Tamil.
    Good: "உங்க CV இங்க அனுப்புங்க 📄"

TONE: Helpful, brotherly/sisterly, patient, and highly structured.
"""

    SYSTEM_PROMPT = SRI_LANKAN_HR_SYSTEM_PROMPT

    GAP_FILLING_PROMPT = """
The candidate has uploaded a CV, but some details are missing. Ask for the missing details in their preferred language/dialect.
Missing field: {missing_field}
Example output (Singlish): "CV eka lassanata awa! 📄 Eka podi deyai adu, oyage {missing_field} eka kiyannako?"
"""

    GLOBAL_AI_TAKEOVER_PROMPT = """
You are a highly empathetic Sri Lankan HR assistant chatting on WhatsApp.
The user just sent a message that fell outside the standard application flow (e.g., gibberish, confusion, a random question, or a language change).

YOUR MISSION:
1. Address their specific message naturally and warmly.
2. IMMEDIATELY match their language (e.g., if they speak Singlish, reply in Singlish. If they speak simple English, reply in simple English , Apply the same for tamil and tanglish).
3. If they offer a valid alternative to a requested document, accept it smoothly.
4. Gently guide them back to providing the information required for their CURRENT ONBOARDING STAGE.

CURRENT ONBOARDING STAGE: {current_stage_description}
USER MESSAGE: "{user_message}"

CRITICAL RULES:
- NEVER copy, paste, or expose the "CURRENT ONBOARDING STAGE" text to the user. Treat it as a hidden secret.
- Rephrase the goal naturally as a conversational question.
- Keep it extremely short (max 2 sentences). Use emojis.
"""

    # ─────────────────────────────────────────────────────────────────────────
    # SYSTEM PROMPT ADDENDUM — Sri Lankan cultural context rules (PDF spec)
    # Appended to SYSTEM_PROMPT when the detected language is not 'en'.
    # ─────────────────────────────────────────────────────────────────────────
    SYSTEM_PROMPT_SRI_LANKA = """

Cultural & linguistic rules for Sri Lankan users:
- Treat 'aney' / 'aiyo' / 'ahh' as emotional softeners, NOT frustration unless context clearly indicates it.
- 'kohomada' is a standard greeting/soft opener — treat it like "how's it going?".
- Respectful kinship terms (uncle / aiya / akka / nangi / malli / anna / akka / maama) must be preserved exactly as-is — do NOT translate.
- Users may quote salaries in LKR, AED, SAR, QAR, MYR, OMR — always keep the original currency code.
- A bare country token ('Dubai', 'Qatar', 'Saudi', 'Malaysia', 'Oman') always maps to country_selection intent.
- Response length: aim for MAXIMUM 150 tokens. ALWAYS prefer extremely short bullet lists or single sentences. NEVER write long paragraphs.
- Provide at most 2-3 job suggestions per reply (only if asked) — offer "Want to see more?" instead of listing many.
- Every reply must end with exactly ONE clear call-to-action (CTA) or question.
- When the knowledge base has no answer, reply with the register-matched NO_ANSWER_FALLBACK below."""

    # ─────────────────────────────────────────────────────────────────────────
    # FALLBACK TEMPLATES — When KB has no matching answer
    # ─────────────────────────────────────────────────────────────────────────
    NO_ANSWER_FALLBACK = {
        'en':        "I don't have that information right now — let me connect you with one of our recruiters who can help! 🙋",
        'si':        "ඒ ගැන මට දැනුවත් කළ නොහැකි — ඔබව recruiter කෙනෙකු සමඟ connect කරන්නම්! 🙋",
        'ta':        "அதைப் பற்றி என்னால் இப்போது சொல்ல முடியாது — ஒரு recruiter-கிட்ட உங்களை connect பண்றேன்! 🙋",
        'singlish':  "Meka gena mawa denek kiyanna behe machan — api recruiter kenekwa connect karannam! 🙋",
        'tanglish':  "Atha pathi ippo solla mudiyala da — oru recruiter-kitte connect panniduren! 🙋",
    }

    # ─────────────────────────────────────────────────────────────────────────
    # ERROR / REPHRASE TEMPLATES — When intent is unclear (other / low confidence)
    # ─────────────────────────────────────────────────────────────────────────
    I_DIDNT_UNDERSTAND = {
        'en':        "Sorry, I didn't quite catch that 😅 Could you rephrase it?",
        'si':        "Mawa gena mawa denek kiyanna behe — eka vedot kiyna vitarak kiyapan 😅",
        'ta':        "Maappu, puriyala 😅 — thayavu seithu mீண்டும் sollunga?",
        'singlish':  "Machan, meka therune nehe — veda therenna lassana widiyata kiyapan 😅",
        'tanglish':  "Da, puriyala — innoru varudha soluveengala? 😅",
    }

    PLEASE_REPHRASE = {
        'en':        "I'm not sure I understood — could you say that in a different way? 🤔",
        'si':        "Eka therune nehe — veda therenna lassana widiyata kiyapan? 🤔",
        'ta':        "Sari'a puriyala — vere maadhiri solluveengala? 🤔",
        'singlish':  "Meka properly dhanaganna behe — veda kiyna vidiyata kiyapan? 🤔",
        'tanglish':  "Purinji kollavillai — vera style-la solluveengala? 🤔",
    }

    CONNECT_RECRUITER = {
        'en':        "Let me connect you with a recruiter who can answer that directly! Just a moment 🔗",
        'si':        "Eka gena recruiter kenekwa oyawa connect karannam — dakinna! 🔗",
        'ta':        "Atha pathi therinja recruiter kitta ungala connect panniduren — wait panunga! 🔗",
        'singlish':  "Eka gena dhanaganna recruiter kenekwa connect karannam machan! 🔗",
        'tanglish':  "Pathi therinja recruiter kitta connect panniduren da! 🔗",
    }

    @classmethod
    def get_no_answer_fallback(cls, language: str) -> str:
        """Return register-matched fallback when KB has no answer."""
        return cls.NO_ANSWER_FALLBACK.get(language, cls.NO_ANSWER_FALLBACK['en'])

    @classmethod
    def get_i_didnt_understand(cls, language: str) -> str:
        """Return register-matched 'didn't understand' message."""
        return cls.I_DIDNT_UNDERSTAND.get(language, cls.I_DIDNT_UNDERSTAND['en'])

    @classmethod
    def get_please_rephrase(cls, language: str) -> str:
        """Return register-matched rephrase prompt."""
        return cls.PLEASE_REPHRASE.get(language, cls.PLEASE_REPHRASE['en'])

    @classmethod
    def get_connect_recruiter(cls, language: str) -> str:
        """Return register-matched recruiter handoff message."""
        return cls.CONNECT_RECRUITER.get(language, cls.CONNECT_RECRUITER['en'])

    # ─────────────────────────────────────────────────────────────────────────
    # LANGUAGE SELECTION — Asked immediately after greeting
    # ─────────────────────────────────────────────────────────────────────────
    # This is sent as a single multilingual message so the user can understand it 
    # regardless of their native language.
    LANGUAGE_SELECTION = [
        "To continue, please choose your preferred language / ඉදිරියට යාමට ඔබ කැමති භාෂාව තෝරන්න / தொடர உங்களுக்கு விருப்பமான மொழியைத் தேர்ந்தெடுக்கவும்:\n\n1️⃣ English\n2️⃣ සිංහල\n3️⃣ தமிழ்",
        "Which language do you prefer? / ඔබ කැමති කුමන භාෂාවෙන් සම්බන්ධ වීමටද? / நீங்கள் எந்த மொழியில் தொடர விரும்புகிறீர்கள்?\n\n🔹 English\n🔹 සිංහල\n🔹 தமிழ்"
    ]

    # ─────────────────────────────────────────────────────────────────────────
    # INTAKE QUESTIONS — Step by step, one at a time
    # ─────────────────────────────────────────────────────────────────────────
    INTAKE_QUESTIONS = {
        'job_interest': {
            'en': [
                "What kind of job are you looking for? Any particular role or industry in mind? 🎯",
                "What role are you interested in applying for?",
                "Tell me — what type of work are you looking for? 💼",
            ],
            'si': [
                "ඔබ සොයන්නේ කුමන ආකාරයේ රැකියාවක්ද? විශේෂිත ක්ෂේත්‍රයක් ගැන බලාපොරොත්තුවක් තිබෙනවද? 🎯",
                "ඔබ අයදුම් කිරීමට කැමති කුමන තනතුරකටද?",
                "මට කියන්න — ඔබ සොයන්නේ කුමන ආකාරයේ රැකියාවක්ද? 💼",
            ],
            'ta': [
                "நீங்கள் எந்த வகையான வேலையை தேடுகிறீர்கள்? குறிப்பிட்ட துறை அல்லது பதவி ஏதேனும் மனதில் உள்ளதா? 🎯",
                "நீங்கள் எந்த பதவிக்கு விண்ணப்பிக்க விரும்புகிறீர்கள்?",
                "சொல்லுங்கள் — நீங்கள் எந்த மாதிரியான வேலையை எதிர்பார்க்கிறீர்கள்? 💼",
            ],
            'singlish': [
                "Machan, what job you looking for ah? Any particular type you have in mind? 🎯",
                "So which job you want to apply da? Tell me la 💼",
                "What kind of work you searching for? Driver? Factory? Security? Just tell me 😊",
            ],
            'tanglish': [
                "Enna job search panreenga? Enna maadhiri vela venumnu sollunga 🎯",
                "Epdi maadhiri paniyidam venumnnu theriyuma? Solunga da 💼",
                "Driver ah, factory ah, security ah — enna vela theriyuma? Sollunga 😊",
            ],
        },
        'destination_country': {
            'en': [
                "Which country are you interested in working in? 🌍",
                "Great! And which country are you hoping to go to?",
                "Any specific country in mind, or are you open to options? 🌏",
            ],
            'si': [
                "ඔබ සේවය කිරීමට කැමති කුමන රටකද? 🌍",
                "ඉතා හොඳයි! ඔබ යාමට බලාපොරොත්තු වන්නේ කුමන රටකටද?",
                "විශේෂිත රටක් ගැන අදහසක් තිබෙනවද, නැතහොත් ඕනෑම රටකට යාමට සූදානම්ද? 🌏",
            ],
            'ta': [
                "நீங்கள் எந்த நாட்டில் வேலை செய்ய விரும்புகிறீர்கள்? 🌍",
                "மிக நன்று! நீங்கள் எந்த நாட்டிற்கு செல்ல விரும்புகிறீர்கள்?",
                "குறிப்பிட்ட நாடு ஏதேனும் மனதில் உள்ளதா, அல்லது எந்த நாடாக இருந்தாலும் சம்மதமா? 🌏",
            ],
            'singlish': [
                "Which country you want to go and work da? Dubai, Qatar, Malaysia? 🌍",
                "So where you want to go? Any country already in mind or open options?",
                "Which country you hoping to go da? Just name it! 🌏",
            ],
            'tanglish': [
                "Enna naadu poiya work pannanum? Dubai, Qatar, Saudi — sollunga da 🌍",
                "Dubai ah, Qatar ah, Malaysia ah — enna naadu poganum? 🌏",
                "Enna country prefer panreenga? Sollunga da 😊",
            ],
        },
        'experience_years': {
            'en': [
                "How many years of experience do you have in this field? 📊",
                "And how long have you been working in this area?",
                "Quick question — how many years of relevant experience do you have?",
            ],
            'si': [
                "මෙම ක්ෂේත්‍රයේ ඔබට කොපමණ වසරක පළපුරුද්දක් තිබෙනවද? 📊",
                "ඔබ මෙම අංශයේ කොපමණ කාලයක් සේවය කර තිබෙනවද?",
                "ඔබට අදාළ ක්ෂේත්‍රයේ කොපමණ වසරක පළපුරුද්දක් තිබෙනවද?",
            ],
            'ta': [
                "இந்தத் துறையில் உங்களுக்கு எத்தனை வருட அனுபவம் உள்ளது? 📊",
                "நீங்கள் இந்தப் பிரிவில் எவ்வளவு காலமாகப் பணியாற்றி வருகிறீர்கள்?",
                "ஒரு சிறிய கேள்வி — உங்களுக்கு இதில் எத்தனை வருட அனுபவம் உள்ளது?",
            ],
            'singlish': [
                "How many years experience you have in this job da? 📊",
                "So how long you been working in this field ah?",
                "Experience — how many years la? Just give me the number 😊",
            ],
            'tanglish': [
                "Enna field-la evvalo varudam experience irukku? 📊",
                "Evvalo naala enna work panreenga?",
                "Experience evvalo varudam theriyuma? Sollunga 😊",
            ],
        },
        'cv_upload': {
            'en': [
                "Perfect! Almost there 😊 Could you please send me your CV? PDF or Word works great.",
                "Great, we're nearly done! Please share your CV — PDF or Word is fine 📎",
                "Awesome, one last thing! Please upload your CV so we can get your application moving. PDF or Word is best 📄",
            ],
            'si': [
                "ඉතා හොඳයි! අපි අවසන් අදියරේ සිටින්නේ 😊 කරුණාකර ඔබගේ CV එක එවන්න පුළුවන්ද? PDF හෝ Word ආකෘතිය වඩාත් සුදුසුයි.",
                "හොඳයි, අපි දැන් අවසන් කරමින් පවතින්නේ! කරුණාකර ඔබගේ CV එක එවන්න — PDF හෝ Word ආකෘතියෙන් 📎",
                "අගෙයි, අවසාන පියවර! ඔබගේ අයදුම්පත ඉදිරියට ගෙන යාමට කරුණාකර ඔබගේ CV එක මෙතනින් යොමු කරන්න. PDF හෝ Word නම් වඩාත් හොඳයි 📄",
            ],
            'ta': [
                "மிக நன்று! நாம் இறுதி கட்டத்தை நெருங்கிவிட்டோம் 😊 தயவுசெய்து உங்கள் CV-யை அனுப்ப முடியுமா? PDF அல்லது Word வடிவம் சிறந்தது.",
                "நன்று, நாம் கிட்டத்தட்ட முடித்துவிட்டோம்! உங்கள் CV-யை பகிருங்கள் — PDF அல்லது Word வடிவில் அனுப்பவும் 📎",
                "அருமை, இதுவே இறுதிப் படி! உங்கள் விண்ணப்பத்தை தொடர தயவுசெய்து உங்கள் CV-யை பதிவேற்றவும். PDF அல்லது Word வடிவம் சிறந்தது 📄",
            ],
            'singlish': [
                "Almost done da! 😊 Can you send your CV now? PDF or Word is fine, just send la 📎",
                "Last step! Send your CV — PDF or Word ok. Then we set! 📄",
                "Nearly there! CV send pannunga — PDF or Word, doesn't matter 😊",
            ],
            'tanglish': [
                "Kalakkal! Almost done da 😊 CV anuppenga — PDF or Word velai seyyum 📎",
                "Last step! CV pathivu eidanunga — PDF or Word sari 📄",
                "Aiyoo nearly done! CV anuppenga la, PDF or Word ok 😊",
            ],
        },
    }

    # ─────────────────────────────────────────────────────────────────────────
    # GREETINGS — Welcome messages
    # ─────────────────────────────────────────────────────────────────────────
    GREETINGS = {
        'en': {
            'welcome': [
                "Hey! 👋 Welcome to {company_name}! I'm Dilan from our recruitment team.",
                "Hi there! 😊 This is Dilan from {company_name}. Great to hear from you!",
                "Hello! 🎉 Welcome to {company_name}! I'm Dilan — I help candidates find amazing opportunities abroad.",
                "Hey, welcome! 👋 I'm Dilan from {company_name}'s recruitment team.",
            ],
            'cv_received': [
                "Got your CV! 📄 Let me take a look at it...",
                "CV received! 🙌 Give me a moment to review it...",
                "Thanks for sending that! 📋 Looking through your CV now...",
                "Perfect, got it! 📄 Just reviewing your CV quickly...",
            ],
            'application_complete': [
                "You're all set, {name}! ✅ Your application is in our system. Our team will review everything and reach out to you soon. Best of luck! 🤞",
                "Amazing, {name} — you're done! 🎉 Application submitted successfully. Our recruiters will be in touch. Fingers crossed! 🍀",
                "That's it, {name}! ✅ Your application is complete. We'll review your profile and get back to you. Thanks for choosing {company_name}! 😊",
            ],
            'morning': [
                "Good morning! ☀️ I'm Dilan from {company_name}. Early start — I like it!",
            ],
            'evening': [
                "Good evening! 🌙 I'm Dilan from {company_name}. Love the dedication!",
            ],
            'awaiting_cv': [
                "Please send your CV when you're ready — PDF or Word works perfectly! 📎",
                "Go ahead and share your CV. PDF or Word is best 😊",
            ],
        },
        'si': {
            'welcome': [
                "ආයුබෝවන්! 👋 {company_name} වෙත ඔබව සාදරයෙන් පිළිගනිමු! මම ඩිලාන්, අපේ බඳවා ගැනීමේ කණ්ඩායමෙන්.",
                "ආයුබෝවන්! 😊 {company_name} වෙතින් ඩිලාන් කතා කරන්නේ.",
                "ආයුබෝවන්! 🎉 {company_name} වෙත සාදරයෙන් පිළිගනිමු! මම ඩිලාන් — විදේශ රැකියා අවස්ථා සොයා ගැනීමට මම ඔබට උදව් කරනවා.",
            ],
            'cv_received': [
                "ඔබගේ CV එක ලැබුණා! 📄 කරුණාකර රැඳී සිටින්න, මම එය පරීක්ෂා කරන තුරු...",
                "CV එක ලැබුණා! 🙌 එය පරීක්ෂා කිරීමට මට සුළු මොහොතක් ලබා දෙන්න...",
                "එව්වාට ස්තූතියි! 📋 මම දැන් ඔබගේ CV එක පරීක්ෂා කරමින් සිටින්නේ...",
                "ඉතා හොඳයි, මට ලැබුණා! 📄 ඔබගේ CV එක ඉක්මනින් පරීක්ෂා කරමින් පවතිනවා...",
            ],
            'application_complete': [
                "සියල්ල සම්පූර්ණයි {name}! ✅ ඔබගේ අයදුම්පත අපගේ පද්ධතියට ඇතුළත් කර ඇත. අපගේ කණ්ඩායම මෙය පරීක්ෂා කර ඉක්මනින් ඔබව සම්බන්ධ කර ගනු ඇත. ඔබට ජය! 🤞",
                "ඉතා හොඳයි {name} — සියල්ල අවසන්! 🎉 අයදුම්පත සාර්ථකව යොමු කරන ලදී. අපගේ නියෝජිතයින් ඔබව සම්බන්ධ කර ගනු ඇත. සුභ පැතුම්! 🍀",
                "එපමණයි {name}! ✅ අයදුම්පත සම්පූර්ණයි. අපි ඔබගේ පැතිකඩ පරීක්ෂා කර නැවත දැනුම් දෙන්නෙමු. {company_name} තෝරා ගත්තාට ස්තූතියි! 😊",
            ],
            'awaiting_cv': [
                "ඔබ සූදානම් වූ පසු CV එක එවන්න — PDF හෝ Word ආකෘතියෙන් නම් වඩාත් සුදුසුයි! 📎",
                "කරුණාකර ඔබගේ CV එක අප වෙත යොමු කරන්න. PDF හෝ Word ආකෘතියෙන් වඩාත් හොඳයි 😊",
            ],
        },
        'ta': {
            'welcome': [
                "வணக்கம்! 👋 {company_name}-க்கு உங்களை வரவேற்கிறோம்! நான் திலன், எங்கள் ஆட்சேர்ப்பு குழுவிலிருந்து பேசுகிறேன்.",
                "வணக்கம்! 😊 {company_name}-லிருந்து திலன் பேசுகிறேன்.",
                "வணக்கம்! 🎉 {company_name}-க்கு வரவேற்கிறோம்! நான் திலன் — வெளிநாட்டில் சிறந்த வேலை வாய்ப்புகளைக் கண்டறிய நான் உதவுகிறேன்.",
            ],
            'cv_received': [
                "உங்கள் CV கிடைத்தது! 📄 தயவுசெய்து காத்திருக்கவும், நான் அதனைச் சரிபார்க்கிறேன்...",
                "CV பெறப்பட்டது! 🙌 அதனைச் சரிபார்க்க எனக்குச் சிறிது நேரம் கொடுங்கள்...",
                "அனுப்பியதற்கு நன்றி! 📋 இப்போது உங்கள் CV-யை மதிப்பாய்வு செய்து கொண்டிருக்கிறேன்...",
                "நன்று, கிடைத்தது! 📄 உங்கள் CV-யை விரைவாகச் சரிபார்க்கிறேன்...",
            ],
            'application_complete': [
                "அனைத்தும் தயார் {name}! ✅ உங்கள் விண்ணப்பம் எங்கள் கணினியில் பதிவு செய்யப்பட்டுள்ளது. எங்கள் குழு இதனைச் சரிபார்த்து விரைவில் உங்களைத் தொடர்புகொள்ளும். வாழ்த்துகள்! 🤞",
                "அருமை {name} — வேலை முடிந்தது! 🎉 விண்ணப்பம் வெற்றிகரமாகச் சமர்ப்பிக்கப்பட்டது. எங்கள் பிரதிநிதிகள் உங்களைத் தொடர்புகொள்வார்கள். நல்வாழ்த்துகள்! 🍀",
                "அவ்வளவுதான் {name}! ✅ விண்ணப்பம் முழுமையடைந்தது. உங்கள் சுயவிவரத்தை மதிப்பாய்வு செய்து நாங்கள் உங்களுக்குத் தெரிவிப்போம். {company_name}-ஐத் தேர்ந்தெடுத்ததற்கு நன்றி! 😊",
            ],
            'awaiting_cv': [
                "நீங்கள் தயாரானதும் உங்கள் CV-யை அனுப்பவும் — PDF அல்லது Word வடிவம் சரியாக இருக்கும்! 📎",
                "தயவுசெய்து உங்கள் CV-யை பகிருங்கள். PDF அல்லது Word வடிவம் சிறந்தது 😊",
            ],
        },
        'singlish': {
            'welcome': [
                "Hey! 👋 Welcome to {company_name}! I'm Dilan da — I help people find jobs abroad.",
                "Ayubowan! 😊 I'm Dilan from {company_name}. Let's find you a good job ah!",
                "Hi machan! 🎉 Welcome to {company_name}! I'm Dilan — overseas jobs is what we do!",
            ],
            'cv_received': [
                "Got your CV da! 📄 Give me a second, checking it now...",
                "CV received! 🙌 Let me have a look...",
                "Thanks da! 📋 Looking through your CV now...",
            ],
            'application_complete': [
                "All done {name}! ✅ Your application is in the system. Our team will check and call you soon. Good luck da! 🤞",
                "Finished {name}! 🎉 Application submitted. Our people will contact you. Fingers crossed la! 🍀",
                "That's it {name}! ✅ Application complete. We'll review and get back to you. Thanks for choosing {company_name}! 😊",
            ],
            'awaiting_cv': [
                "Send your CV when ready da — PDF or Word is fine! 📎",
                "Just share your CV la. PDF or Word ok 😊",
            ],
        },
        'tanglish': {
            'welcome': [
                "Vanakkam! 👋 {company_name}-ku welcome! Naan Dilan — overseas job-ku help pannuven.",
                "Vanakkam! 😊 {company_name}-lendhu Dilan pesuven. Nalla job kidaikum, kavaladhe!",
                "Hey! 🎉 {company_name}-ku welcome! Naan Dilan — veli naadu job-ku ungalukku help pannuven.",
            ],
            'cv_received': [
                "CV kidaichuchu! 📄 Konjam wait pannunga, check panren...",
                "CV receive aachuchu! 🙌 Konjam time kudungal, paakiren...",
                "Nandri da! 📋 CV-yai ippo paakiren...",
            ],
            'application_complete': [
                "All set {name}! ✅ Ungal application system-la save aachu. Engal team paaittu ungalai contact pannum. Vazhtukal! 🤞",
                "Mudinjuchu {name}! 🎉 Application submit aachu. Engal aal contact panvaan. Nalla irukatum! 🍀",
                "Appdithaan {name}! ✅ Application complete. Ungal profile paaittu solluven. {company_name}-ai choose pannathukku nandri! 😊",
            ],
            'awaiting_cv': [
                "Thaiyara aachu-nnu CV anuppenga — PDF or Word sari! 📎",
                "CV-yai share pannunga la. PDF or Word enna um okay 😊",
            ],
        },
    }

    # ─────────────────────────────────────────────────────────────────────────
    # ACKNOWLEDGMENTS — Confirm the answer and bridge to next question
    # ─────────────────────────────────────────────────────────────────────────
    ACKNOWLEDGMENTS = {
        'job_confirmed': {
            'en': [
                "Great choice! 👍 ",
                "Excellent! That's a sought-after role. ",
                "Nice, we have good demand for that! 🌟 ",
                "Perfect, we work with clients looking for exactly that! ",
            ],
            'si': [
                "ඉතා හොඳ තේරීමක්! 👍 ",
                "විශිෂ්ටයි! එය දැනට ඉහළ ඉල්ලුමක් පවතින තනතුරක්. ",
                "හොඳයි, එම ක්ෂේත්‍රය සඳහා හොඳ ඉල්ලුමක් පවතිනවා! 🌟 ",
                "ඉතා හොඳයි, අපගේ සේවාදායකයින්ද හරියටම සොයන්නේ මෙයයි! ",
            ],
            'ta': [
                "சிறந்த தேர்வு! 👍 ",
                "அருமை! இது தற்போது அதிக தேவை உள்ள ஒரு பதவியாகும். ",
                "நன்று, இந்தத் துறைக்கு நல்ல வரவேற்பு உள்ளது! 🌟 ",
                "மிக நன்று, எங்கள் வாடிக்கையாளர்களும் இதையே எதிர்பார்க்கிறார்கள்! ",
            ],
            'singlish': [
                "Good choice da! 👍 ",
                "Nice, that role in demand machan! ",
                "Good one, we have jobs for that! 🌟 ",
                "Perfect, our clients looking exactly for that la! ",
            ],
            'tanglish': [
                "Nalla choice da! 👍 ",
                "Apdithaan, adhu romba demand-la irruku! ",
                "Nalla, adha pathi jobs irukku! 🌟 ",
                "Kalakkal, clients adhayae theduranga! ",
            ],
        },
        'country_confirmed': {
            'en': [
                "Great destination! 🌍 ",
                "Excellent choice — we have great opportunities there! 🌟 ",
                "Good call! We have strong connections in that region. ",
                "We work with top employers there — perfect! ",
            ],
            'si': [
                "ඉතා හොඳ ගමනාන්තයක්! 🌍 ",
                "විශිෂ්ට තේරීමක් — එහි අපට හොඳ අවස්ථා තිබෙනවා! 🌟 ",
                "හොඳ තීරණයක්! එම කලාපයේ අපට හොඳ සබඳතා තිබෙනවා. ",
                "අපි එහි ප්‍රමුඛ පෙළේ ආයතන සමඟ කටයුතු කරනවා — ඉතා හොඳයි! ",
            ],
            'ta': [
                "சிறந்த நாடு! 🌍 ",
                "அருமையான தேர்வு — அங்கு நமக்குச் சிறந்த வாய்ப்புகள் உள்ளன! 🌟 ",
                "நல்ல முடிவு! அந்தப் பகுதியில் நமக்கு நல்ல தொடர்புகள் உள்ளன. ",
                "நாங்கள் அங்குள்ள முன்னணி நிறுவனங்களுடன் இணைந்து பணியாற்றுகிறோம் — மிக நன்று! ",
            ],
            'singlish': [
                "Good destination da! 🌍 ",
                "Choice choice — ehetha jobs tiyenawa machan! 🌟 ",
                "Good call, ehetha api contacts tiyenawa! ",
                "Top employers there — perfect da! ",
            ],
            'tanglish': [
                "Nalla naadu da! 🌍 ",
                "Apdithaan — anga nalla opportunities irukku la! 🌟 ",
                "Nalla choice, engaluku connection irukku! ",
                "Top employers irukanga — perfect da! ",
            ],
        },
        'experience_confirmed': {
            'en': [
                "That's solid experience! 💪 ",
                "Great, that's a strong background! ",
                "Excellent — employers will like that! 👍 ",
                "Good experience level! ",
            ],
            'si': [
                "එය ඉතා හොඳ පළපුරුද්දක්! 💪 ",
                "හොඳයි, ඔබට ශක්තිමත් පසුබිමක් තිබෙනවා! ",
                "විශිෂ්ටයි — සේවා යෝජකයින් මීට බොහෝ කැමති වේවි! 👍 ",
                "ඉතා හොඳ පළපුරුද්දක්! ",
            ],
            'ta': [
                "இது ஒரு சிறந்த அனுபவம்! 💪 ",
                "நன்று, உங்களுக்கு வலுவான பின்னணி உள்ளது! ",
                "அருமை — நிறுவனங்கள் இதனை மிகவும் விரும்புவார்கள்! 👍 ",
                "சிறந்த அனுபவ நிலை! ",
            ],
            'singlish': [
                "That's solid experience machan! 💪 ",
                "Wah, strong background da! ",
                "Employers will love that da! 👍 ",
                "Good experience level la! ",
            ],
            'tanglish': [
                "Nalla experience da! 💪 ",
                "Strong background irukku machaa! ",
                "Companies-ku romba pudikkum — great! 👍 ",
                "Nalla experience level! ",
            ],
        },
    }

    # ─────────────────────────────────────────────────────────────────────────
    # CV SUMMARY HEADERS
    # ─────────────────────────────────────────────────────────────────────────
    CV_SUMMARY_HEADERS = {
        'en': [
            "Nice CV, {name}! Here's what I got from it 📋",
            "Looks great, {name}! Here's your CV summary:",
            "Here's what I pulled from your CV, {name} 📌",
            "Got it, {name}! Here's what your CV says:",
        ],
        'si': [
            "CV එක ඉතා හොඳයි {name}! ඉන් මා උපුටා ගත් තොරතුරු මෙන්න 📋",
            "ඉතා හොඳයි {name}! ඔබගේ CV සාරාංශය මෙන්න:",
            "{name}, ඔබගේ CV එකෙන් මා හඳුනාගත් තොරතුරු 📌",
            "හරි {name}! ඔබගේ CV එකේ සඳහන් වන්නේ මේ තොරතුරුයි:",
        ],
        'ta': [
            "உங்கள் CV நன்றாக உள்ளது {name}! அதிலிருந்து நான் எடுத்த தகவல்கள் இதோ 📋",
            "மிக நன்று {name}! உங்கள் CV-யின் சுருக்கம் இதோ:",
            "{name} உங்கள் CV-யிலிருந்து நான் கவனித்த தகவல்கள் 📌",
            "கிடைத்தது {name}! உங்கள் CV-யில் உள்ள விவரங்கள்:",
        ],
        'singlish': [
            "Nice CV da {name}! Here's what I found 📋",
            "Good one {name}! CV summary meka:",
            "{name}, your CV la meka tiyenawa 📌",
            "Got it {name}! Your CV says this:",
        ],
        'tanglish': [
            "Nalla CV {name}! Ithulerundhu edutthadhu 📋",
            "Romba nalla {name}! CV summary:",
            "{name}, ungal CV-la irundhu edutthadhu 📌",
            "Kidaichuchu {name}! CV-la irukkadhellam:",
        ],
    }

    # ─────────────────────────────────────────────────────────────────────────
    # CV FOLLOW-UP
    # ─────────────────────────────────────────────────────────────────────────
    CV_FOLLOWUP = {
        'en': [
            "Does everything look right? Let me know if anything needs correcting 😊",
            "Is that info accurate? Happy to update anything!",
        ],
        'si': [
            "මෙම තොරතුරු සියල්ල නිවැරදිද? යම් වෙනසක් විය යුතු නම් කරුණාකර මට දැනුම් දෙන්න 😊",
            "මෙම තොරතුරු නිවැරදිද? යාවත්කාලීන කිරීමට ඇත්නම් කරුණාකර පවසන්න!",
        ],
        'ta': [
            "இந்தத் தகவல்கள் அனைத்தும் சரியாக உள்ளதா? ஏதேனும் மாற்றங்கள் செய்ய வேண்டுமானால் தயவுசெய்து எனக்குத் தெரிவிக்கவும் 😊",
            "இந்தத் தகவல்கள் சரியானவையா? புதுப்பிக்க ஏதேனும் இருந்தால் தயவுசெய்து கூறவும்!",
        ],
        'singlish': [
            "Everything looks correct da? Let me know if anything wrong 😊",
            "That info right ah? Can update anything la!",
        ],
        'tanglish': [
            "Ellaam seri-ah theriyuma? Enna changes venum-na sollunga 😊",
            "Correct-ah? Update pannanum-na keevu la!",
        ],
    }

    # ─────────────────────────────────────────────────────────────────────────
    # ENGAGEMENT HOOKS — Persuasion & social-proof messages
    # ─────────────────────────────────────────────────────────────────────────
    ENGAGEMENT_HOOKS = {
        'en': [
            "🌟 Over 200 candidates placed last month alone! You're in the right place.",
            "⭐ We've sent workers to UAE, Qatar, Saudi, Oman, Malaysia and more. Let's find YOUR opportunity!",
            "🎯 Our success rate is over 85%. Let's make you one of our success stories!",
            "🚀 Right now we have urgent openings in the Gulf — perfect timing to apply!",
            "💼 Many Sri Lankans are earning 3-5x more overseas through us. Your turn!",
        ],
        'si': [
            "🌟 පසුගිය මාසයේ පමණක් 200කට අධික අය නිව! ඔබ නිවැරදි ස්ථානයේ ඉන්නවා.",
            "⭐ UAE, Qatar, Saudi, Oman, Malaysia ඇතුළු රටවලට අපි සේවකයින් යවලා තිබෙනවා!",
            "🎯 අපේ සාර්ථකත්වය 85%ක් ඉක්මවයි. ඔබව ද සාර්ථකත්වයේ කොටස් කරගනිමු!",
            "🚀 දැන් Gulf රටවල Urgent vacancies තිබෙනවා — Apply කිරීමට හොඳ අවස්ථාවක්!",
        ],
        'ta': [
            "🌟 கடந்த மாதம் மட்டும் 200க்கும் அதிகமானோர் வேலை பெற்றனர்! நீங்கள் சரியான இடத்தில் இருக்கிறீர்கள்.",
            "⭐ UAE, Qatar, Saudi, Oman, Malaysia உள்ளிட்ட நாடுகளுக்கு நாங்கள் ஆட்கள் அனுப்பியுள்ளோம்!",
            "🎯 எங்கள் வெற்றி விகிதம் 85%-க்கும் அதிகம். நீயும் வெற்றி பெறலாம்!",
            "🚀 இப்போது Gulf நாடுகளில் Urgent வாய்ப்புகள் உள்ளன — Apply செய்ய சரியான நேரம்!",
        ],
        'singlish': [
            "🌟 Last month 200+ people got jobs da! You in the right place la.",
            "⭐ UAE, Qatar, Saudi, Oman, Malaysia — we send workers all over! Your turn now.",
            "🎯 85% success rate machan! Let me make you the next success story 😊",
            "🚀 Right now urgent jobs in Gulf — perfect time to apply da!",
        ],
        'tanglish': [
            "🌟 Last month 200+ perunga vela pudicha da! Neenga sari-yana idathula irukkeenga.",
            "⭐ UAE, Qatar, Saudi, Oman, Malaysia — ellaa idathulayum adunga! Ungal turn now.",
            "🎯 85% success rate machaa! Neenga next success story aaveenga 😊",
            "🚀 Ippo Gulf-la urgent jobs irukku — apply panna perfect time da!",
        ],
    }

    # ─────────────────────────────────────────────────────────────────────────
    # URGENCY TAGS — Used when tagging hot/urgent jobs in listings
    # ─────────────────────────────────────────────────────────────────────────
    URGENCY_TAGS = {
        'urgent': '🔥 URGENT',
        'high':   '⚡ HIGH DEMAND',
        'normal': '✅',
    }

    # ─────────────────────────────────────────────────────────────────────────
    # VACANCY PUSH FOOTER — Appended after vacancy listings to push application
    # ─────────────────────────────────────────────────────────────────────────
    VACANCY_PUSH_FOOTER = {
        'en':       "\n\n💡 *Interested in any of these?* Reply *APPLY* or send *1* to start your application — it only takes 2 minutes! 😊",
        'si':       "\n\n💡 *මේවායෙන් කැමතිද?* *APPLY* කියා reply කරන්න — විනාඩි 2ක් ගත වෙනවා! 😊",
        'ta':       "\n\n💡 *இவற்றில் ஆர்வமா?* *APPLY* என்று reply பண்ணுங்க — 2 நிமிஷம்தான்! 😊",
        'singlish': "\n\n💡 *Any of these match you da?* Reply *APPLY* or *1* to start — only 2 mins la! 😊",
        'tanglish': "\n\n💡 *Evadhaavadhu pidikaadha?* *APPLY* nu reply pannunga — 2 nimisham dhaan! 😊",
    }

    # ─────────────────────────────────────────────────────────────────────────
    # ERROR & SYSTEM MESSAGE TEMPLATES — All 5 registers
    # Previously English-only; now localized so users never hit a jarring
    # language switch on errors.
    # ─────────────────────────────────────────────────────────────────────────

    ERROR_TEMPLATES = {
        "error_generic": {
            "en": ["Thanks — let’s continue. Please send your answer again and I’ll guide you.", "I’m here to help. Share that once more and we’ll continue from this step."],
            "si": ["ස්තූතියි — අපි ඉදිරියට යමු. ඔබගේ පිළිතුර නැවත එවන්න.", "මම උදව් කරන්න මෙතනයි. ඒක තවත් වරක් එවන්න, අපි මේ පියවරෙන්ම දිගටම යමු."],
            "ta": ["நன்றி — தொடரலாம். உங்கள் பதிலை மீண்டும் அனுப்புங்கள்.", "உதவ நான் இருக்கிறேன். அதையே இன்னொரு முறை அனுப்புங்கள்; இதே படியில் தொடரலாம்."],
            "singlish": ["Thanks da — api continue karamu. Oyage answer eka ayeth ewanna.", "Mama help karanna inne. Eka thawa parak ewanna, me step eken continue karamu."],
            "tanglish": ["Thanks da — namma continue pannalaam. Unga answer-a marubadi anuppunga.", "Naan help panna ready. Adha innum oru thadava anuppunga; indha step-la continue pannalaam."],
        },
        "error_validation": {
            "en": ["Hmm, that doesn't look quite right. Could you check and try again?", "I couldn't process that. Can you rephrase or provide it in a different format?"],
            "si": ["හ්ම්ම්, ඒක හරි නැති වගේ. පරීක්ෂා කරලා නැවත try කරන්න?", "ඒක process කරන්න බැරි උනා. වෙනස් විදිහකට try කරන්න?"],
            "ta": ["ஹ்ம்ம், அது சரியா தெரியல. Check பண்ணி மீண்டும் try பண்ணுங்க?", "அதை process பண்ண முடியல. வேற format-la try பண்ணுங்க?"],
            "singlish": ["Hmm, e tika hariyata naha wge. Check karala ayeth try karanna da!", "Eka process karanna beri una. Wenama widihakta try karanna!"],
            "tanglish": ["Hmm, adhu sariya theriyala. Check panni meendum try pannunga da!", "Adha process panna mudiyala. Vera format-la try pannunga!"],
        },
        "error_timeout": {
            "en": ["That's taking longer than expected. Let me try again for you!", "The system is a bit slow right now. Please hang on!"],
            "si": ["ටිකක් වැඩි වෙලා ගත වුනා. නැවත try කරනවා!", "System එක ටිකක් slow. ටිකක් ඉන්න!"],
            "ta": ["கொஞ்சம் நேரம் ஆகுது. மீண்டும் try பண்றேன்!", "System கொஞ்சம் slow-ah irukku. கொஞ்சம் wait பண்ணுங்க!"],
            "singlish": ["Tikak wela yanawa. Ayeth try karannam da!", "System eka tikak slow machan. Tikak inna!"],
            "tanglish": ["Konjam time aagudhu. Meendum try pannren da!", "System konjam slow-ah irukku. Konjam wait pannunga!"],
        },
        "error_cv_processing": {
            "en": ["I had trouble processing your CV. Could you send it again? PDF format works best!", "Sorry, I couldn't read your CV properly. Try sending a clearer copy?"],
            "si": ["CV එක process කරන්න ටිකක් අමාරු උනා. නැවත එවන්න — PDF best!", "සමාවෙන්න, CV හරියට කියවන්න බැරි උනා. Clear copy එකක් එවන්න?"],
            "ta": ["CV-ஐ process பண்ண கொஞ்சம் கஷ்டம் ஆச்சு. மீண்டும் அனுப்புங்க — PDF best!", "மன்னிக்கவும், CV-ஐ சரியா படிக்க முடியல. Clear copy அனுப்புங்க?"],
            "singlish": ["CV eka process karanna amaaru una machan. Ayeth yawanna — PDF best da!", "Sorry, CV hariyata kiyawanna beri una. Clear copy ekak yawanna!"],
            "tanglish": ["CV-a process panna konjam kashtam aachchu da. Meendum anuppunga — PDF best!", "Sorry, CV-a sariya padikka mudiyala. Clear copy anuppunga!"],
        },
        "clarification_needed": {
            "en": ["I'm not sure I understood that correctly. Could you explain a bit more?", "Can you clarify what you mean? I want to help you right!"],
            "si": ["ඒක හරියට තේරුණේ නැහැ. ටිකක් පැහැදිලි කරන්න පුළුවන්ද?", "ඒකෙන් මොනවද කියන්නේ? හරියට help කරන්න ඕන!"],
            "ta": ["அது சரியா புரியல. கொஞ்சம் விளக்க முடியுமா?", "நீங்க என்ன சொல்ல வர்றீங்க? சரியா help பண்ணணும்!"],
            "singlish": ["Eka hariyata therunne naha. Tikak pahadili karanna da!", "Mokakda kiyanne? Hariyata help karanna one!"],
            "tanglish": ["Adhu sariya puriyala da. Konjam explain pannunga!", "Enna solra-neenga? Sariya help pannanum!"],
        },
        "try_again": {
            "en": ["Let's try that again!", "No worries — give it another go!"],
            "si": ["නැවත try කරමු!", "කරදරයක් නැ — තව වතාවක් try කරන්න!"],
            "ta": ["மீண்டும் try பண்ணலாம்!", "பரவாயில்ல — இன்னொரு தடவை try பண்ணுங்க!"],
            "singlish": ["Ayeth try karamu da!", "Karadara ne — thawa paarak try karanna!"],
            "tanglish": ["Meendum try pannalaam da!", "Paravala — innoru thadava try pannunga!"],
        },
        "session_expired": {
            "en": ["It looks like our conversation timed out. No worries — just say hi to start fresh!", "Your session has expired, but your details are saved. Say *hi* to continue!"],
            "si": ["අපේ chat එක timeout උනා. කරදරයක් නැ — *hi* කියලා නැවත පටන් ගන්න!", "Session එක expire උනා, ඒත් details save කරලා තියෙනවා. *hi* කියන්න!"],
            "ta": ["Chat timeout ஆயிடுச்சு. பரவால — *hi* சொல்லி மீண்டும் ஆரம்பிங்க!", "Session expire ஆச்சு, ஆனா details save ஆயிடுச்சு. *hi* சொல்லுங்க!"],
            "singlish": ["Chat eka timeout una machan. Karadara ne — *hi* kiyala ayeth patangamu!", "Session eka expire una, ewa details save karala tiyenawa. *hi* kiyanna!"],
            "tanglish": ["Chat timeout aagiduchu da. Paravala — *hi* solli meendum aarambikkalaam!", "Session expire aachchu, aana details save aagidichu. *hi* solluga!"],
        },
    }

    # De-escalation messages for frustrated users (matches their register)
    DE_ESCALATION = {
        "en": ["I completely understand your frustration. Let me help you get this sorted right away.", "I'm really sorry about that! Let me fix this for you."],
        "si": ["ඔයාගේ frustration එක තේරෙනවා. මම දැන්ම fix කරන්නම්!", "ගොඩක් sorry! දැන්ම හදා ගනිමු."],
        "ta": ["உங்கள் frustration புரியுது. உடனே fix பண்றேன்!", "மிகவும் sorry! இப்போவே சரி பண்ணலாம்."],
        "singlish": ["Oyage frustration eka therenawa machan. Danma fix karannam!", "Godak sorry da! Danma hada ganimu."],
        "tanglish": ["Unga frustration puriyudhu da. Ippo-ve fix pannren!", "Romba sorry da! Ippove sari pannalaam."],
    }

    # ─────────────────────────────────────────────────────────────────────────
    # CONVERSATION STATES
    # ─────────────────────────────────────────────────────────────────────────
    CONVERSATION_STATES = {
        'initial': 'Started conversation',
        'awaiting_language_selection': 'Asking user to select a language',
        'awaiting_job_interest': 'Asking about job role',
        'awaiting_destination': 'Asking about destination country',
        'awaiting_experience': 'Asking about years of experience',
        'awaiting_cv': 'Waiting for CV upload',
        'processing_cv': 'Processing uploaded CV',
        'collecting_info': 'Collecting missing CV information',
        'answering_questions': 'Answering candidate questions',
        'application_complete': 'Application completed',
    }

    # ─────────────────────────────────────────────────────────────────────────
    # MULTILINGUAL ENTITY EXTRACTION — Specialized for Sri Lankan code-switching
    # ─────────────────────────────────────────────────────────────────────────
    SRI_LANKAN_ENTITY_EXTRACTION_PROMPT = """\
You are a multilingual entity extractor for a Sri Lankan overseas recruitment chatbot.
The user may write in English, Sinhala script (ශ, ක), Tamil script (க, ந), Singlish \
(Romanized Sinhala), Tanglish (Romanized Tamil), or any mix. Your task is to identify \
the job role and destination country they are expressing interest in.

=== FEW-SHOT EXAMPLES ===
Input: "mata kuwait yanna one"         → {{"job_role": null, "country": "Kuwait", "confidence": 0.92}}
Input: "ennaku oman ra job irukuza"     → {{"job_role": null, "country": "Oman",  "confidence": 0.88}}
Input: "sowdi driver job"              → {{"job_role": "driver", "country": "Saudi Arabia", "confidence": 0.95}}
Input: "dubei wala security kenek wenna" → {{"job_role": "security guard", "country": "United Arab Emirates", "confidence": 0.91}}
Input: "maleshiya factory"             → {{"job_role": "factory worker", "country": "Malaysia", "confidence": 0.93}}
Input: "kuwet la wadeema karanna"      → {{"job_role": null, "country": "Kuwait", "confidence": 0.85}}
Input: "dubai driver"                  → {{"job_role": "driver", "country": "United Arab Emirates", "confidence": 0.98}}
Input: "oman nurse job"                → {{"job_role": "nurse", "country": "Oman", "confidence": 0.97}}
Input: "qatar la security job ekak"    → {{"job_role": "security guard", "country": "Qatar", "confidence": 0.94}}
Input: "malesia factory worker"        → {{"job_role": "factory worker", "country": "Malaysia", "confidence": 0.89}}
Input: "dubayi cook job wanna"         → {{"job_role": "cook", "country": "United Arab Emirates", "confidence": 0.90}}

=== COLLOQUIAL COUNTRY SPELLINGS ===
UAE / Dubai: dubai, dubei, dubayi, dubay, di bai, uae
Saudi Arabia: sowdi, sowdiya, saudi, saudia, ksa, riyadh
Kuwait: kuwait, kuwet, kuwit, kuweiti, kuwethi
Oman: oman, ommaan, omman
Qatar: qatar, katar, qathar
Malaysia: malaysia, maleshiya, malasia, malesia, melesia
Bahrain: bahrain, barain, bahren
Jordan: jordan, urdon
Singapore: singapore, singapura

=== ACTIVE CRM COUNTRIES ===
{active_countries_list}

=== ACTIVE CRM JOB TITLES ===
{active_jobs_list}

=== USER INPUT ===
"{text}"

=== INSTRUCTIONS ===
1. Extract job_role and country as normalized English values.
2. Try to match country against the ACTIVE CRM COUNTRIES list above and output \
the matched_crm_country field (exact string from the list, or null if no match).
3. Try to match job_role against ACTIVE CRM JOB TITLES list and output matched_crm_job.
4. Set confidence 0.0–1.0 based on how certain you are.
5. Output null for any field you cannot extract — do NOT hallucinate.

JSON only (no markdown):
{{"job_role": "<English name or null>", "country": "<English name or null>", \
"matched_crm_country": "<exact CRM value or null>", "matched_crm_job": "<exact CRM value or null>", \
"confidence": <0.0-1.0>}}"""

    # ─────────────────────────────────────────────────────────────────────────
    # GIBBERISH FALLBACK — Multilingual (replaces the single Singlish hardcode)
    # ─────────────────────────────────────────────────────────────────────────
    GIBBERISH_FALLBACK = {
        'en':       "I didn't quite catch that 😅 Could you tell me a bit more clearly?",
        'si':       "ඒක හරියට therune nehe ayye/nangi 😅. Apita me details tika complete karanna puluwanda?",
        'ta':       "அது சரியாகப் புரியவில்லை 😅 கொஞ்சம் தெளிவாகச் சொல்லுங்களா?",
        'singlish': "Mata eka hariyata therenne na ayye/nangi 😅. Apita me details tika complete karanna puluwanda? (I didn't quite catch that. Can we complete these details?)",
        'tanglish': "Adhu sariya puriyala da 😅. Konjam theliva solluveengala? (I didn't quite understand that.)",
    }

    # ─────────────────────────────────────────────────────────────────────────
    # AGENTIC HANDOFF — LLM-powered contextual steering for out-of-bounds replies
    # Used when a user gives an off-topic / unclear answer during intake flow.
    # The LLM acknowledges their message naturally, then gently guides them back.
    # ─────────────────────────────────────────────────────────────────────────
    AGENTIC_TAKEOVER_PROMPT = """\
You are Dilan, a friendly recruitment assistant for a Sri Lankan overseas recruitment agency.
The candidate's message is off-topic or unclear. Do NOT ignore what they said — acknowledge it naturally, \
then gently steer them back to the current goal.

Current recruitment goal: {current_goal}
Candidate's message: "{user_message}"
Language/register to respond in: {language}

Rules:
- Acknowledge their message warmly (1 sentence) — do NOT say "I understand" robotically.
- Gently redirect to the current goal (1 sentence) — rephrase the question in a new way, never repeat word-for-word.
- Max 2 sentences + 1-2 emojis. WhatsApp brevity required.
- Respond ONLY in the {language} register (Singlish → casual Romanized Sinhala+English, Tanglish → casual Romanized Tamil+English, si → Sinhala script, ta → Tamil script, en → English).
- NEVER use the words "Invalid", "Error", "I can't", "Unfortunately I don't understand" as first words.
- Be warm, empathetic, and human — not robotic.

FEW-SHOT EXAMPLES:
Goal="Find out their job role" | Message="I like to go someplace amazing" | en →
"Sounds like you're ready for an adventure! 🌟 What type of job are you hoping to find abroad?"

Goal="Find out their destination country" | Message="I lost my passport yesterday" | singlish →
"Aiyoo, that's stressful da! 😥 Anyway, which country are you hoping to work in?"

Goal="Find out years of experience" | Message="My wife is angry at me" | tanglish →
"Seri seri, home-la situation-a handle pandrom la! 😄 Ippo sollunga — evvalo varudam experience irukku ungalukku?"

Goal="Find out their job role" | Message="aney mokada karanne mama" | singlish →
"Haha machang, relax! 😄 Etha hadanna job eka mokakda, kiyannako?"

Response (raw text, no quotes):"""

    # Maps chatbot state names → human-readable goal descriptions passed to the agentic prompt.
    CURRENT_GOAL_MAP: dict = {
        'awaiting_job': 'Find out their job role (what type of job they want abroad)',
        'awaiting_job_interest': 'Find out their job role (what type of job they want abroad)',
        'awaiting_country': 'Find out their destination country (which country they want to work in)',
        'awaiting_destination_country': 'Find out their destination country (which country they want to work in)',
        'awaiting_experience': 'Find out years of work experience they have',
        'awaiting_cv': 'Get them to send their CV (PDF or Word)',
        'collecting_info': 'Collect missing profile information from the candidate',
        'awaiting_language_selection': 'Help them choose their preferred language (English / Sinhala / Tamil)',
    }

    @classmethod
    def get_gibberish_fallback(cls, language: str) -> str:
        """Return a multilingual gibberish fallback message matched to the user's register."""
        return cls.GIBBERISH_FALLBACK.get(language, cls.GIBBERISH_FALLBACK['en'])

    @classmethod
    def get_agentic_takeover_prompt(cls, user_message: str, current_goal: str, language: str) -> str:
        """Format the agentic takeover prompt with the given context."""
        lang_names = {
            'en': 'English', 'si': 'Sinhala script (Unicode)',
            'ta': 'Tamil script (Unicode)', 'singlish': 'Singlish (casual Romanized Sinhala+English)',
            'tanglish': 'Tanglish (casual Romanized Tamil+English)',
        }
        return cls.AGENTIC_TAKEOVER_PROMPT.format(
            current_goal=current_goal,
            user_message=user_message,
            language=lang_names.get(language, language),
        )

    RAG_PROMPT = """You are Dilan — friendly receptionist at {company_name}, overseas recruitment.
Answer naturally from the knowledge base. If not there: "I don't have that specific info right now, but I can find out."

KB: {context}
Candidate: {candidate_info}
Q: {question}

Rules: EXTREMELY SHORT WhatsApp style (1-2 sentences max) | NO PARAGRAPHS | respond in same language/register as question ({language})
Match their style exactly: Tanglish in → Tanglish out | Singlish in → Singlish out | script in → script out
NEVER translate technical/English terms (driver, Dubai, salary, CV, passport, visa, WhatsApp, interview) into native script — everyone uses the English word.

FEW-SHOT EXAMPLES BY REGISTER:
Tanglish Q: "salary evvalo?" → "Dubai driver-ku monthly $500-600 la! 💪 Food + accommodation free-ah kidaikkum!"
Singlish Q: "salary kiyada?" → "Dubai driver job-te monthly $500-600 tiyenawa! 💪 Food + accommodation free!"
Sinhala Q: "salary කීයද?" → "Dubai driver job-ට monthly $500-600 ලැබෙනවා! 💪"
Tamil Q: "salary என்ன?" → "Dubai driver job-க்கு monthly $500-600 கிடைக்கும்! 💪"
English Q: "what's the visa process?" → "We handle the full visa for you — usually takes 4-6 weeks 😊"

Reply:"""

    CV_ANALYSIS_PROMPT = """Analyse this CV professionally and concisely (under 150 words).
Focus on key strengths and career highlights.

CV Content:
{cv_text}

Extract: key skills, years of experience, education, career highlights, overall impression."""

    MISSING_FIELD_PROMPT = """Generate a warm, very short question (max 20 words) to ask a candidate for their {field}.
Sound natural and friendly. Language: {language}
Question:"""

    # ─────────────────────────────────────────────────────────────────────────
    # CLASS METHODS
    # ─────────────────────────────────────────────────────────────────────────

    # ── Language fallback chain ─────────────────────────────────────────────
    # singlish/tanglish fall back to their base language templates rather than
    # going all the way to 'en'.  This gives more culturally appropriate responses.
    _LANG_FALLBACKS = {
        'singlish': ['singlish', 'si', 'en'],
        'tanglish': ['tanglish', 'ta', 'en'],
        'si':       ['si', 'en'],
        'ta':       ['ta', 'en'],
        'en':       ['en'],
    }

    @classmethod
    def _resolve_lang(cls, container: dict, language: str) -> list:
        """
        Return the best available options list from `container` for `language`,
        using the defined fallback chain.
        """
        for lang in cls._LANG_FALLBACKS.get(language, [language, 'en']):
            options = container.get(lang)
            if options:
                return options
        return container.get('en', [])

    @classmethod
    def get_system_prompt(cls, company_name: str, context: str = "", candidate_info: str = "") -> str:
        base = cls.SYSTEM_PROMPT.format(
            company_name=company_name,
            context=context,
            candidate_info=candidate_info
        )
        if context or candidate_info:
            return f"{base}\n\nCurrent Context:\n{context}\n\nCandidate Info Collected So Far:\n{candidate_info}"
        return base

    @classmethod
    def get_gap_filling_prompt(cls, missing_field: str) -> str:
        return cls.GAP_FILLING_PROMPT.format(missing_field=missing_field)

    @classmethod
    def get_rag_prompt(cls, company_name: str, context: str, candidate_info: str, question: str, language: str = "en") -> str:
        return cls.RAG_PROMPT.format(
            company_name=company_name,
            context=context,
            candidate_info=candidate_info,
            question=question,
            language=language
        )

    @classmethod
    def get_language_selection(cls) -> str:
        """Get the multilingual message prompting for language selection."""
        # Return a special flag that webhooks.py will intercept to send the clickable interactive language selector
        return "__INTERACTIVE_LANGUAGE_SELECTOR__"

    @classmethod
    def get_greeting(
        cls,
        greeting_type: str,
        language: str,
        company_name: str,
        candidate_name: str = ""
    ) -> str:
        lang_greetings = cls.GREETINGS.get(language) or cls.GREETINGS.get(
            'si' if language == 'singlish' else ('ta' if language == 'tanglish' else 'en')
        ) or cls.GREETINGS['en']
        options = lang_greetings.get(greeting_type, lang_greetings.get('welcome', []))
        template = random.choice(options) if isinstance(options, list) else options
        name = candidate_name.strip().split()[0] if candidate_name.strip() else ""
        return template.format(company_name=company_name, name=name)

    @classmethod
    def get_intake_question(cls, field: str, language: str) -> str:
        """
        Get the next intake question for the given field.
        Falls back through the language chain: singlish→si→en, tanglish→ta→en.
        """
        field_questions = cls.INTAKE_QUESTIONS.get(field, {})
        options = cls._resolve_lang(field_questions, language)
        return random.choice(options) if options else ""

    @classmethod
    def get_acknowledgment(cls, ack_type: str, language: str) -> str:
        """Get a varied acknowledgment phrase."""
        ack = cls.ACKNOWLEDGMENTS.get(ack_type, {})
        options = cls._resolve_lang(ack, language)
        return random.choice(options) if options else ""

    @classmethod
    def get_cv_received_message(cls, language: str, company_name: str = "") -> str:
        return cls.get_greeting('cv_received', language, company_name)

    @classmethod
    def get_application_complete_message(
        cls,
        language: str,
        company_name: str = "",
        candidate_name: str = ""
    ) -> str:
        return cls.get_greeting('application_complete', language, company_name, candidate_name)

    @classmethod
    def get_awaiting_cv_message(cls, language: str, company_name: str = "") -> str:
        return cls.get_greeting('awaiting_cv', language, company_name)

    @classmethod
    def get_cv_summary_header(cls, language: str, candidate_name: str = "") -> str:
        options = cls._resolve_lang(cls.CV_SUMMARY_HEADERS, language)
        template = random.choice(options)
        name = candidate_name.strip().split()[0] if candidate_name.strip() else "there"
        return template.format(name=name)

    @classmethod
    def get_cv_followup(cls, language: str) -> str:
        options = cls._resolve_lang(cls.CV_FOLLOWUP, language)
        return random.choice(options)

    @classmethod
    def get_engagement_hook(cls, language: str) -> str:
        """Return a random engagement/persuasion hook for the given language."""
        options = cls._resolve_lang(cls.ENGAGEMENT_HOOKS, language)
        return random.choice(options) if options else ""

    @classmethod
    def get_vacancy_push_footer(cls, language: str) -> str:
        """Return the application push footer appended after vacancy listings."""
        return cls.VACANCY_PUSH_FOOTER.get(language, cls.VACANCY_PUSH_FOOTER['en'])

    # ─────────────────────────────────────────────────────────────────────────
    # STATUS UPDATE TEMPLATES — Proactive messages from recruitment system
    # Used when recruiter updates candidate status (shortlisted, interview, etc.)
    # NOTE: For WhatsApp Business API, these may need Meta template approval.
    # ─────────────────────────────────────────────────────────────────────────

    STATUS_UPDATE_TEMPLATES = {
        "shortlisted": {
            "en": "Hi {name}! Great news — your application for *{job_title}* has been *shortlisted*! Our team was impressed with your profile. We'll be in touch soon with next steps. Stay tuned! 🎉",
            "si": "ආයුබෝවන් {name}! සුබ ආරංචියක් — *{job_title}* සඳහා ඔබේ අයදුම්පත *කෙටි ලැයිස්තුගත* වී ඇත! අපි ඉක්මනින්ම ඊළඟ පියවර ගැන දන්වන්නම්. 🎉",
            "ta": "வணக்கம் {name}! நல்ல செய்தி — *{job_title}* பதவிக்கான உங்கள் விண்ணப்பம் *குறுகிய பட்டியலில்* சேர்க்கப்பட்டுள்ளது! அடுத்த படிகள் பற்றி விரைவில் தொடர்பு கொள்வோம். 🎉",
            "singlish": "Hello {name}! Good news — oya *{job_title}* application eka *shortlist* una! Api team eka oyage profile ekata goda ak ganeeva. Ikmanin next steps gana kiyannm. 🎉",
            "tanglish": "Hello {name}! Nalla news — unga *{job_title}* application *shortlist* aagirukku! Engal team ungal profile-a impressed. Next steps pathi soon solvom. 🎉",
        },
        "interview_scheduled": {
            "en": "Hi {name}! Your interview for *{job_title}* has been scheduled for *{interview_date}*{location_text}. Please be prepared and on time. Good luck! 📋",
            "si": "ආයුබෝවන් {name}! *{job_title}* සඳහා ඔබේ සම්මුඛ පරීක්ෂණය *{interview_date}*{location_text} දිනට නියමිතයි. කරුණාකර සූදානම්ව සිටින්න. සුභ පැතුම්! 📋",
            "ta": "வணக்கம் {name}! *{job_title}* பதவிக்கான உங்கள் நேர்முகத் தேர்வு *{interview_date}*{location_text} அன்று திட்டமிடப்பட்டுள்ளது. தயவுசெய்து தயாராக இருங்கள். வாழ்த்துக்கள்! 📋",
            "singlish": "Hello {name}! Oyage *{job_title}* interview eka *{interview_date}*{location_text} thiyenawa. Ready weela enna. Good luck! 📋",
            "tanglish": "Hello {name}! Unga *{job_title}* interview *{interview_date}*{location_text} ku schedule panniyirukku. Ready-a irunga. Good luck! 📋",
        },
        "hired": {
            "en": "Congratulations {name}! 🎊 You've been *selected* for the *{job_title}* position! Welcome to the team. Our HR team will contact you shortly with your offer details and next steps.",
            "si": "සුභ පැතුම් {name}! 🎊 *{job_title}* තනතුරට ඔබ *තෝරා ගෙන* ඇත! කණ්ඩායමට සාදරයෙන් පිළිගනිමු. අපේ HR කණ්ඩායම ඉක්මනින් ඔබව සම්බන්ධ කරගන්නවා.",
            "ta": "வாழ்த்துக்கள் {name}! 🎊 *{job_title}* பதவிக்கு நீங்கள் *தேர்வு* செய்யப்பட்டுள்ளீர்கள்! அணிக்கு வரவேற்கிறோம். எங்கள் HR குழு உங்களை விரைவில் தொடர்பு கொள்ளும்.",
            "singlish": "Congratulations {name}! 🎊 Oya *{job_title}* post ekata *select* una! Team ekata aayubowan. HR team eka ikmanin oyawa contact karanawa.",
            "tanglish": "Congratulations {name}! 🎊 Neenga *{job_title}* post-ku *select* aagitteenga! Team-ku welcome. HR team ungala soon contact pannuvanga.",
        },
        "rejected_with_alternatives": {
            "en": "Hi {name}, thank you for applying for *{job_title}*. Unfortunately, we've moved forward with other candidates for this role. But don't worry — we have other opportunities that might interest you!{alternatives_text}\n\nWould you like to explore any of these?",
            "si": "ආයුබෝවන් {name}, *{job_title}* සඳහා අයදුම් කළාට ස්තුතියි. අවාසනාවන්ත ලෙස, මෙම තනතුර සඳහා වෙනත් අපේක්ෂකයින් තෝරාගෙන ඇත. නමුත් කරදර නොවන්න — ඔබට උනන්දුවක් දක්වන වෙනත් අවස්ථා තිබෙනවා!{alternatives_text}\n\nමේවායින් කිසිවක් ගැන දැනගන්න කැමතිද?",
            "ta": "வணக்கம் {name}, *{job_title}* பதவிக்கு விண்ணப்பித்தமைக்கு நன்றி. துரதிர்ஷ்டவசமாக, இந்த பதவிக்கு வேறு விண்ணப்பதாரர்கள் தேர்வு செய்யப்பட்டுள்ளனர். ஆனால் கவலைப்படாதீர்கள் — வேறு வாய்ப்புகள் உள்ளன!{alternatives_text}\n\nஇவற்றில் ஏதேனும் ஆர்வமா?",
            "singlish": "Hello {name}, *{job_title}* ekata apply kalata thanks. Apahanata me post ekata vena candidates select una. Ewa gana kanagathu wenna epa — vena opportunities thiyenawa!{alternatives_text}\n\nMewain monawath gana dana ganna kamatida?",
            "tanglish": "Hello {name}, *{job_title}* post-ku apply pannathukkuk nandri. Valakkamaga antha post-ku vera candidates select aagittanga. Aana worry pannatheenga — vera opportunities irukku!{alternatives_text}\n\nIndha edhaavathu pathi therinja kondaalum solveenga?",
        },
    }

    @classmethod
    def get_status_update_message(
        cls,
        status: str,
        lang: str,
        candidate_name: str,
        job_title: str,
        interview_date: Optional[str] = None,
        interview_location: Optional[str] = None,
        alternative_jobs: Optional[list] = None,
    ) -> Optional[str]:
        """Build a status update message for a candidate in their preferred language."""
        templates_for_status = cls.STATUS_UPDATE_TEMPLATES.get(status)
        if not templates_for_status:
            return None

        # Language fallback chain
        fallback_chain = cls._LANG_FALLBACKS.get(lang, [lang, "en"])
        template = None
        for try_lang in fallback_chain:
            if try_lang in templates_for_status:
                template = templates_for_status[try_lang]
                break
        if template is None:
            template = templates_for_status.get("en", "")

        # Build location text
        location_text = ""
        if interview_location:
            location_text = f" at *{interview_location}*"

        # Build alternatives text
        alternatives_text = ""
        if alternative_jobs:
            job_list = "\n".join(f"  • {j}" for j in alternative_jobs[:5])
            alternatives_text = f"\n\n{job_list}"

        name = candidate_name.strip().split()[0] if candidate_name.strip() else "there"

        return template.format(
            name=name,
            job_title=job_title,
            interview_date=interview_date or "TBD",
            location_text=location_text,
            alternatives_text=alternatives_text,
        )

    @classmethod
    def get_error_message(cls, error_type: str, language: str) -> str:
        """Return a random localized error message for the given error type."""
        templates_for_type = cls.ERROR_TEMPLATES.get(error_type, cls.ERROR_TEMPLATES["error_generic"])
        options = cls._resolve_lang(templates_for_type, language)
        return random.choice(options)

    @classmethod
    def get_de_escalation(cls, language: str) -> str:
        """Return a localized de-escalation message for frustrated users."""
        options = cls._resolve_lang(cls.DE_ESCALATION, language)
        return random.choice(options)


# Singleton
templates = PromptTemplates()
