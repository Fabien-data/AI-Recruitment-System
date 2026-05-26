"""
QA scenarios — scripted conversations for 5 languages × 4 personas + off-topic.
Driven by qa_harness.py against the deployed Cloud Run bot.
"""

# ─────────────────────────────────────────────────────────────────────────────
# Each scenario is: (lang_code, persona, phone_suffix, messages)
# Phone format: 9477009 + suffix (3 digits)
# Personas:
#   1=novice    (broken/short/typo)
#   2=cooperative (clean full intake)
#   3=skeptical (registration fee / scam questions)
#   4=codeswitch (mixed languages)
#   5=offtopic  (weather/sports/abuse/gibberish)
# ─────────────────────────────────────────────────────────────────────────────

SCENARIOS = [
    # ─── ENGLISH ─────────────────────────────────────────────────────────────
    ("en", "novice", "001", [
        "hi",
        "i want job",
        "?",
        "dont know",
        "what",
        "name?? me Kamal",
        "driver job lol",
        "dubai",
        "30 yrs",
        "no email",
        "5 yr",
    ]),
    ("en", "cooperative", "002", [
        "Hello, I would like to apply for a job",
        "My name is Nimal Perera",
        "I am interested in welder positions",
        "I prefer Saudi Arabia or Qatar",
        "I am 32 years old",
        "nimal.perera.test@example.com",
        "I have 8 years of welding experience",
    ]),
    ("en", "skeptical", "003", [
        "Hi, is this a real recruitment agency?",
        "do you charge any registration fee?",
        "what is the salary for a driver in Dubai?",
        "how do I know this isn't a scam?",
        "what company is this?",
        "what countries do you send people to?",
    ]),
    ("en", "codeswitch", "004", [
        "hi machan, mata Dubai eke job ekak ona",
        "salary kiyada?",
        "name eka Sunil",
        "im 28 years",
        "ela jobs monawada thiyenne?",
    ]),
    ("en", "offtopic", "005", [
        "what's the weather like in Colombo today",
        "who won the cricket match yesterday",
        "tell me a joke",
        "asdfghjkl qwerty zzz",
        "what is 234 times 56",
        "are you a real person or AI",
        "fuck you",
        "you stupid bot",
    ]),

    # ─── SINHALA (Unicode) ───────────────────────────────────────────────────
    ("si", "novice", "101", [
        "ආයුබෝවන්",
        "මට job එකක් ඕන",
        "?",
        "මොකක්ද",
        "Kamal",
        "driver",
        "Dubai",
        "මට වයස 35",
        "email නෑ",
        "අවුරුදු 6",
    ]),
    ("si", "cooperative", "102", [
        "ආයුබෝවන්! මට රැකියාවක් සඳහා අයදුම් කරන්න ඕන",
        "මගේ නම සමන් කුමාර",
        "මට වැල්ඩර් රැකියාවක් ඕන",
        "මට Qatar හෝ Saudi කැමතියි",
        "මගේ වයස අවුරුදු 30",
        "saman.test@example.com",
        "මට වසර 7ක වැල්ඩින් පළපුරුද්ද",
    ]),
    ("si", "skeptical", "103", [
        "මේක ඇත්ත agency එකක්ද?",
        "registration fee එකක් ගන්නවද?",
        "Dubai එකේ driver job එකේ සැලරිය කීයද?",
        "මේක scam එකක් නෙවෙයිද?",
        "මේ company එකේ නම මොකක්ද?",
    ]),
    ("si", "codeswitch", "104", [
        "hello, මට Saudi job ekak ona",
        "මගේ name Nuwan",
        "experience අවුරුදු 4",
        "salary kiyada AED වලින්?",
        "thank you ela",
    ]),
    ("si", "offtopic", "105", [
        "අද කොළඹ කාලගුණය මොකක්ද",
        "ඊයේ ක්‍රිකට් match එක ජයග්‍රහණය කලේ කවුද",
        "ජෝක් එකක් කියන්න",
        "qwerty asdf",
        "234 × 56 කීයද",
        "ඔයා මනුෂ්‍යයෙක්ද?",
        "තෝ බල්ලෙක්",
    ]),

    # ─── TAMIL (Unicode) ─────────────────────────────────────────────────────
    ("ta", "novice", "201", [
        "வணக்கம்",
        "எனக்கு வேலை வேணும்",
        "?",
        "தெரியல",
        "பெயர் ராமு",
        "டிரைவர் வேலை",
        "துபாய்",
        "30 வயசு",
        "email இல்லை",
        "5 வருஷம்",
    ]),
    ("ta", "cooperative", "202", [
        "வணக்கம், நான் வேலைக்கு apply பண்ண விரும்புகிறேன்",
        "என் பெயர் சுரேஷ் குமார்",
        "எனக்கு வெல்டர் வேலை வேணும்",
        "சவுதி அரேபியா அல்லது கத்தார்",
        "எனக்கு வயது 33",
        "suresh.test@example.com",
        "எனக்கு 9 வருட welding அனுபவம்",
    ]),
    ("ta", "skeptical", "203", [
        "இது உண்மையான agency-ஆ?",
        "registration fee ஏதாவது வசூலிக்கிறீங்களா?",
        "துபாய் driver salary எவ்வளவு?",
        "இது scam-ஆ இருக்குமா?",
        "என்ன company இது?",
    ]),
    ("ta", "codeswitch", "204", [
        "hi, enakku Qatar job venum",
        "என் name Murugan",
        "experience 6 years",
        "salary எவ்வளவு QAR-ல",
        "நன்றி",
    ]),
    ("ta", "offtopic", "205", [
        "இன்று கொழும்பு வானிலை எப்படி",
        "நேற்று cricket யார் வென்றது",
        "ஒரு joke சொல்லுங்க",
        "qwerty asdf",
        "234 × 56 எவ்வளவு",
        "நீங்க மனிதரா?",
        "நாயே",
    ]),

    # ─── SINGLISH (Romanized Sinhala) ────────────────────────────────────────
    ("singlish", "novice", "301", [
        "ado",
        "mata job ekak ona",
        "?",
        "monawada",
        "name eka Kasun",
        "driver job",
        "Dubai",
        "ag 29",
        "email naha",
        "5 awurudu",
    ]),
    ("singlish", "cooperative", "302", [
        "hi machan, mata job ekak apply karanna ona",
        "mage nama Pradeep Silva",
        "mata welder job ekak ona",
        "Saudi nathnam Qatar kemathi",
        "mata wayasa 34",
        "pradeep.test@example.com",
        "mata welding experience awurudu 10k thiyenawa",
    ]),
    ("singlish", "skeptical", "303", [
        "meka real agency ekakda?",
        "registration fee ekak gannawada?",
        "Dubai eke driver salary kiyada?",
        "meka scam ekak nemeida?",
        "company eke nama mokakda?",
    ]),
    ("singlish", "codeswitch", "304", [
        "hello sir, mata Dubai job ekak ona, salary how much?",
        "name Roshan",
        "im 27 years",
        "experience 3 yrs driving",
        "thanks bro",
    ]),
    ("singlish", "offtopic", "305", [
        "ada kalaguna kohomada",
        "iye cricket match eka kawda jayagatte",
        "joke ekak kiyanna",
        "asdf qwerty",
        "234 multiplied by 56 kiyada",
        "oya AI ekakda?",
        "tho ballek",
    ]),

    # ─── TANGLISH (Romanized Tamil) ──────────────────────────────────────────
    ("tanglish", "novice", "401", [
        "vanakkam",
        "enakku velai venum",
        "?",
        "theriyala",
        "peyar Ravi",
        "driver velai",
        "Dubai",
        "30 vayasu",
        "email illa",
        "5 varsham",
    ]),
    ("tanglish", "cooperative", "402", [
        "vanakkam, naan velai-ku apply panna virumbureen",
        "en peyar Karthik Raj",
        "enakku welder velai venum",
        "Saudi Arabia illana Qatar",
        "enakku 31 vayasu",
        "karthik.test@example.com",
        "enakku 8 varsham welding experience irukku",
    ]),
    ("tanglish", "skeptical", "403", [
        "ithu real agency-a?",
        "registration fee edhavadhu vasoolikkireengala?",
        "Dubai driver salary evlo?",
        "ithu scam-a irukkuma?",
        "enna company ithu?",
    ]),
    ("tanglish", "codeswitch", "404", [
        "hi sir, enakku Qatar job venum, salary how much",
        "name Mani",
        "im 26 yrs old",
        "experience 4 years cleaning",
        "thanks anna",
    ]),
    ("tanglish", "offtopic", "405", [
        "indru weather eppadi colombo-la",
        "naetru cricket match-la yaar jeichuvanga",
        "oru joke sollunga",
        "qwerty asdf",
        "234 multiplied by 56 evlo",
        "neenga AI-a?",
        "nayee",
    ]),
]


PHONE_PREFIX = "9477009"


def phone_for(suffix: str) -> str:
    return PHONE_PREFIX + suffix
