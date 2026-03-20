"""
Language Detector
=================
Detects the language of incoming messages.
Supports Sinhala, Tamil, and English with handling for transliterated text.
'singlish' = Romanized Sinhala (Sinhala words written in English letters)
'tanglish' = Romanized Tamil   (Tamil words written in English letters)
"""

import json
import logging
import re
import unicodedata
from pathlib import Path
from typing import Tuple, Optional

_NLP_RESOURCES = Path(__file__).parent / "resources"


def _load_resource_set(name: str) -> set:
    """Load a JSON array resource file into a set, with graceful fallback."""
    try:
        with open(_NLP_RESOURCES / name, encoding="utf-8") as f:
            return set(json.load(f))
    except Exception as _e:
        logging.getLogger(__name__).warning(f"Could not load NLP resource '{name}': {_e}")
        return set()


def _load_resource_dict(name: str) -> dict:
    """Load a JSON object resource file into a dict, with graceful fallback."""
    try:
        with open(_NLP_RESOURCES / name, encoding="utf-8") as f:
            return json.load(f)
    except Exception as _e:
        logging.getLogger(__name__).warning(f"Could not load NLP resource '{name}': {_e}")
        return {}


# ─── Production dictionaries loaded at import time ────────────────────────────
_SINGLISH_EXTRA: set = _load_resource_set("singlish_words.json")
_TANGLISH_EXTRA: set = _load_resource_set("tanglish_words.json")
_SPELLING_VARIANTS_JSON: dict = _load_resource_dict("spelling_variants.json")
_DOMAIN_WORDS: set = _load_resource_set("domain_words.json")

# Domain-word scoring multiplier (PDF spec: 2×)
DOMAIN_WEIGHT: float = 2.0

logger = logging.getLogger(__name__)


# ─── Spelling normalisation (applied before detection) ───────────────────────

def normalize_spelling(text: str) -> str:
    """
    Apply the spelling-variant map to normalise common Sri Lankan typing patterns
    before language detection or intent classification.
    E.g. 'drv' → 'driver', 'machng' → 'machang', 'iruku' → 'irukku'.
    """
    merged = {**_SPELLING_VARIANTS_JSON}
    words = text.split()
    return " ".join(merged.get(w.lower(), w) for w in words)


# Patterns for detecting language switch requests
LANGUAGE_SWITCH_PATTERNS = {
    'si': [
        r'\bspeak\s*(in\s*)?(sinhala|sinhalese)\b',
        r'\btalk\s*(in\s*)?(sinhala|sinhalese)\b',
        r'\b(in|use)\s+sinhala\b',
        r'\bsinhala\s*(please|pls)?\b',
        r'\bcan\s*(we|you)\s*(speak|talk|chat|use)\s*(in\s*)?(sinhala|sinhalese)\b',
        r'\b싨하ල|සිංහල|sinhalen\b',
        r'\blet\'?s?\s*(speak|talk|chat)\s*(in\s*)?(sinhala|sinhalese)\b',
        r'\bchange\s*(to|language\s*to)\s*sinhala\b',
        r'\bswitch\s*(to\s*)?sinhala\b',
    ],
    'singlish': [
        r'\bsinglish\b',
        r'\bsinhala\s*english\b',
        r'\b(speak|talk|chat|use|in)\s+singlish\b',
        r'\bsinhala\s*(mix|mixed)\b',
        r'\bswitch\s*(to\s*)?singlish\b',
        r'\bmachang\b',            # classic Singlish address
        r'\bmen\s+(mokakda|mona)\b',
        r'sinhala[- ]n\s*pesu',    # "sinhala-n pesu" (Tanglish request for Sinhala)
        r'sinhala\s*la\s*pesu',
    ],
    'ta': [
        r'\bspeak\s*(in\s*)?tamil\b',
        r'\btalk\s*(in\s*)?tamil\b',
        r'\b(in|use)\s+tamil\b',
        r'\btamil\s*(please|pls)?\b',
        r'\bcan\s*(we|you)\s*(speak|talk|chat|use)\s*(in\s*)?tamil\b',
        r'\bதமிழில்|tamilil\b',
        r'\blet\'?s?\s*(speak|talk|chat)\s*(in\s*)?tamil\b',
        r'\bchange\s*(to|language\s*to)\s*tamil\b',
        r'\bswitch\s*(to\s*)?tamil\b',
    ],
    'tanglish': [
        r'\btanglish\b',
        r'\btamil\s*english\b',
        r'\b(speak|talk|chat|use|in)\s+tanglish\b',
        r'\btamil\s*(mix|mixed)\b',
        r'\bswitch\s*(to\s*)?tanglish\b',
        r'tamil\s*la\s*sollu',     # "tamil la sollu" — switch to Tamil/Tanglish
        r'tamil[- ]la\s*katha',
    ],
    'en': [
        r'\bspeak\s*(in\s*)?english\b',
        r'\btalk\s*(in\s*)?english\b',
        r'\b(in|use)\s+english\b',
        r'\benglish\s*(please|pls)?\b',
        r'\bcan\s*(we|you)\s*(speak|talk|chat|use)\s*(in\s*)?english\b',
        r'\blet\'?s?\s*(speak|talk|chat)\s*(in\s*)?english\b',
        r'\bchange\s*(to|language\s*to)\s*english\b',
        r'\bswitch\s*(to\s*)?english\b',
        r'english[- ]en\s*katha\s*karanna',  # "English-en katha karanna"
        r'english\s*la\s*pesu',
    ]
}


def detect_language_switch_request(text: str) -> Optional[str]:
    """
    Detect if user is requesting to switch languages.
    Returns one of: 'si', 'ta', 'en', 'singlish', 'tanglish', or None.
    """
    if not text:
        return None
    
    text_lower = text.lower().strip()
    
    for lang_code, patterns in LANGUAGE_SWITCH_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, text_lower, re.IGNORECASE):
                logger.info(f"Language switch request detected: {lang_code}")
                return lang_code
    
    return None

# Try to import langdetect
try:
    from langdetect import detect, detect_langs, LangDetectException
    LANGDETECT_AVAILABLE = True
except ImportError:
    LANGDETECT_AVAILABLE = False
    logger.warning("langdetect not available, using fallback detection")


class LanguageDetector:
    """
    Detects language of text messages.
    Supports:
      si        → Sinhala Unicode script
      ta        → Tamil Unicode script
      singlish  → Romanized Sinhala (Sinhala words in English letters)
      tanglish  → Romanized Tamil   (Tamil  words in English letters)
      en        → English
    """
    
    # Unicode ranges for script detection
    SINHALA_RANGE = range(0x0D80, 0x0DFF + 1)  # Sinhala script
    TAMIL_RANGE = range(0x0B80, 0x0BFF + 1)     # Tamil script
    
    # Common Singlish/transliterated words — seed set + JSON resource
    # (JSON resource loaded at module level into _SINGLISH_EXTRA)
    SINGLISH_WORDS = (
        _SINGLISH_EXTRA
        | {
        # Greetings & response words
        'ayubowan', 'kohomada', 'kohomad', 'kohomeda', 'kohomde', 'kohomda',
        'suba', 'udessanak', 'sthuthi', 'stuti', 'ayubo', 'subha', 'sthuta',
        'bohoma', 'isthuthi',
        # Common verbs
        'innawa', 'yanawa', 'enawa', 'karanawa', 'karanna', 'kiyanawa', 'balanna',
        'denna', 'ganna', 'hadanne', 'wela', 'karala', 'giyaa', 'awa',
        'thiyanawa', 'tiyenawa', 'thiyanawada', 'tiyenawada', 'thiyenawa',
        'hadanawa', 'pennawa', 'dannawa', 'kiyanna', 'karamu', 'gaththaa',
        'karaganna', 'pennanna', 'bonna', 'kanna', 'nidaganna', 'dawanna',
        'aranawa', 'liyanawa', 'denawa', 'genawa', 'yawanna', 'gihin',
        'aawa', 'karannam', 'kalaa', 'gaththam', 'daanawa',
        # Pronouns & words
        'mama', 'oya', 'api', 'oyage', 'mage', 'eka', 'ehenam',
        'meka', 'oke', 'okage', 'apege', 'eyaa', 'eyage', 'eya', 'ungey',
        # Question words
        'mokakda', 'mona', 'kohe', 'kohenda', 'monawada', 'kawada',
        'ewe', 'ewanda', 'kawuru', 'kiyannada', 'mokda', 'aeyi', 'kohed',
        # Adjectives / adverbs
        'hari', 'nisa', 'godak', 'hitha', 'deka', 'tika',
        'puluwanda', 'danna', 'honda', 'niyamai', 'lassana',
        'wadagath', 'balapan', 'tikak', 'ithin', 'goda', 'mahaththuru',
        # Confirmations & negations
        'ow', 'oww', 'nehe', 'neha', 'naha', 'epa', 'epaa', 'karunakarala',
        'harida', 'mehema', 'okkoma', 'danma',
        # Vacancy/job-related
        'wadeema', 'raakiyawa', 'rakiyawa', 'riyaduru', 'ituru',
        'salaris', 'gaathe', 'gedara', 'avurudu', 'avurudhu',
        'methanin', 'methana', 'wadasthana', 'kadaima',
        'vedakin', 'samasthanaya', 'mushthiya', 'aayathana',
        'aathala', 'shamuthpadana', 'raakiyaa', 'prawaahana',
        'wadakaarayek', 'samaaganaya', 'pilithurak',
        # Documents/process
        'applay', 'readiy', 'nimu', 'dagili', 'athwela',
        'sakasurey', 'labaaganim',
        # Casual connectors (Lankan English)
        'machang', 'machan', 'aney', 'aiyo', 'pako', 'ekka', 'nam',
        'enne', 'ohe', 'uthe', 'ahuke', 'athal', 'gamana',
        'mata', 'oyata', 'apita', 'puluwan',
        # Modern / hybrid terms
        'karanawa', 'dawanawa', 'liyanawa',
        'paarak', 'selaviyanawa', 'hetak', 'ikman', 'ikmanin',
        # Travel/relocation
        'yanna', 'ratak', 'pitarata', 'gaman', 'wisadeshaya',
    })
    
    # Common Tamil transliterated words — seed set + JSON resource
    # (JSON resource loaded at module level into _TANGLISH_EXTRA)
    TAMIL_TRANSLITERATED = (
        _TANGLISH_EXTRA
        | {
        # Greetings & responses
        'vanakkam', 'nandri', 'nanri', 'seri', 'sari',
        'aama', 'ille', 'illai', 'illada', 'illa',
        # Verbs
        'panren', 'panrom', 'solla', 'ketka', 'paakka', 'varuvaen', 'varuvom',
        'pogalam', 'vaanga', 'vanga', 'ponga', 'sollunga', 'kudungal',
        'irukka', 'irukken', 'irriki', 'iruku', 'irukku', 'irrukku',
        'poganum', 'porom', 'pannanum', 'pannom', 'vizhnthidum',
        'pannunga', 'sollu', 'paru', 'paaru', 'varuvanga', 'kudukanum',
        'ezhudhu', 'padikka', 'anuppu', 'anuppunga', 'edukka',
        'kelunga', 'kudungga', 'saapdu', 'saapteenga',
        'terinjikka', 'puriyudhu', 'puriyala', 'therinjukkonga',
        'aagiduchchu', 'mudinjuchu', 'aagiduchu',
        # Question words
        'enna', 'epdi', 'yenna', 'yeppadi', 'eppo', 'epo', 'ennada',
        'enga', 'inge', 'inga', 'andha', 'antha',
        'evvalo', 'evvalavu', 'ethanai', 'yaaru', 'yaarukku',
        # Pronouns
        'naan', 'nee', 'avan', 'aval', 'ungalukku', 'nammalukku',
        'enakku', 'unakku', 'avarukku', 'avanga', 'ivanga',
        'naanga', 'neenga', 'thanga',
        # Adjectives / adverbs
        'romba', 'konjam', 'nalla', 'konavadu', 'theriyum', 'theriyathu',
        'theriyuma', 'eppadiyum', 'nalladhu', 'kettadhu',
        'perisa', 'chinna', 'sinna', 'pudhusu', 'pazhaya',
        # Confirmations & negations
        'aam', 'aama', 'illa', 'illai', 'venaam', 'vendaam',
        'seri', 'okay', 'podhum', 'podhuma',
        # Vacancy/job-related
        'velai', 'paniyidam', 'paniyidangal', 'vela', 'ulladha', 'ullada',
        'sambalam', 'panam', 'sandhai', 'vesa', 'visum',
        'paniyam', 'thozhil', 'vaippu', 'anubavam', 'anubavum',
        'niruvanam', 'uzhaikka', 'kaiththozil', 'naadu',
        'maadhachambalam', 'thakaval', 'velaivaaippu',
        # Documents/process
        'thamizh', 'tamizh', 'tamila', 'tamilil', 'tanglish',
        # Casual Lanka Tamil markers
        'machaan', 'machan', 'thalaiva', 'thala',
        'aiyo', 'aiyoo', 'ayyoo',
        # Modern / hybrid terms
        'kudungga', 'pannungga', 'poongga',
        'ippo', 'ippove', 'appuram', 'aprm', 'meendum',
        'readiya', 'okva', 'pannalaam',
        # Travel/relocation
        'velinaadu', 'gulfku', 'dubaikku', 'poganum', 'poganuma',
    })
    
    # Greetings in different languages
    GREETINGS = {
        'si': ['ayubowan', 'suba', 'kohomada', 'bohoma sthuthi'],
        'ta': ['vanakkam', 'nandri', 'nanri'],
        'singlish': ['aney', 'aiyo', 'machang', 'machan', 'kohomada', 'ayubowan'],
        'tanglish': ['vanakkam', 'seri', 'romba nandri', 'aama'],
        'en': ['hello', 'hi', 'hey', 'good morning', 'good evening', 'thanks', 'thank you']
    }

    # Common transliteration misspelling variants → canonical form
    # Merged with JSON resource at module level (_SPELLING_VARIANTS_JSON)
    _SPELLING_VARIANTS: dict[str, str] = {**_SPELLING_VARIANTS_JSON, **{
        # Singlish variants
        'kohomede': 'kohomada', 'kohomda': 'kohomada', 'kohomod': 'kohomada',
        'machng': 'machang', 'mashn': 'machan', 'mchn': 'machan',
        'karanwa': 'karanawa', 'karannwa': 'karanna', 'karannawa': 'karanna',
        'kiyannwa': 'kiyanawa', 'tiyenwa': 'tiyenawa', 'thiyanwa': 'thiyanawa',
        'puluwnda': 'puluwanda', 'innwa': 'innawa', 'yanwa': 'yanawa',
        'enaawa': 'enawa', 'monwa': 'monawada', 'mokda': 'mokakda',
        'godaak': 'godak', 'harthi': 'hari', 'oneee': 'ow',
        'aiyoo': 'aiyo', 'aiyooo': 'aiyo', 'aney': 'aney',
        # Tanglish variants
        'pannunga': 'pannunga', 'pannga': 'pannunga', 'pannuga': 'pannunga',
        'sollnga': 'sollunga', 'solluga': 'sollunga',
        'vaangka': 'vaanga', 'vaangha': 'vaanga',
        'irruku': 'irukku', 'irrukku': 'irukku', 'iruku': 'irukku',
        'theriyuma': 'theriyuma', 'teriyuma': 'theriyuma', 'therima': 'theriyuma',
        'rombha': 'romba', 'konjm': 'konjam', 'kunjam': 'konjam',
        'vanakam': 'vanakkam', 'vanakaam': 'vanakkam',
        'nandree': 'nandri', 'nandhri': 'nandri',
        'aiyyo': 'aiyo', 'ayyo': 'aiyo',
        'ennada': 'ennada', 'yennda': 'yenna',
    }}
    
    # Confidence threshold above which we promote to singlish/tanglish register
    # PDF spec: lower to 0.15 to improve code-mix detection
    _REGISTER_THRESHOLD = 0.15
    _INSTANT_LOCK_CONFIDENCE = 0.60  # Instant-lock when single strong token found
    _MIN_DICT_MATCHES = 1            # 1 strong domain token is enough
    
    def __init__(self):
        self.default_language = "en"
        # Per-user language persistence: phone → {"lang": str, "count": int}
        self._confirmed_languages: dict[str, dict] = {}
    
    def detect(self, text: str, phone_number: str | None = None) -> Tuple[str, float]:
        """
        Detect the language/register of the given text.

        Args:
            text: message text
            phone_number: optional — used for language persistence across messages

        Returns:  (language_code, confidence)
        Possible language_codes:
          'si', 'ta', 'en', 'singlish', 'tanglish'
        """
        if not text or not text.strip():
            return self.default_language, 0.0
        
        # NFC normalize — ensures Sinhala/Tamil diacritics are in composed form
        text = unicodedata.normalize("NFC", text.strip())
        
        # 1. Native script check (highest confidence → 'si' / 'ta')
        #    >30% Sinhala/Tamil Unicode = that language regardless of mixed English
        script_result = self._detect_by_script(text)
        if script_result[1] > 0.5:
            detected = script_result
            self._update_persistence(phone_number, detected[0])
            return detected
        
        # 2. Transliterated word check → 'singlish' / 'tanglish'
        transliterated_result = self._detect_transliterated(text)
        if transliterated_result[1] > self._REGISTER_THRESHOLD:
            detected = transliterated_result
            self._update_persistence(phone_number, detected[0])
            return detected
        
        # 3. langdetect library fallback
        if LANGDETECT_AVAILABLE:
            try:
                lang_result = self._detect_with_langdetect(text)
                if lang_result:
                    self._update_persistence(phone_number, lang_result[0])
                    return lang_result
            except Exception as e:
                logger.debug(f"langdetect error: {e}")
        
        # 4. If user has a confirmed language (2+ messages), use that
        if phone_number:
            persisted = self._confirmed_languages.get(phone_number)
            if persisted and persisted["count"] >= 2:
                return persisted["lang"], 0.6
        
        # 5. Default to English
        return self.default_language, 0.5
    
    def _detect_by_script(self, text: str) -> Tuple[str, float]:
        """Detect language by Unicode script. Returns 'si' or 'ta' (native script)."""
        sinhala_count = 0
        tamil_count = 0
        total_chars = 0
        
        for char in text:
            code_point = ord(char)
            
            if code_point in self.SINHALA_RANGE:
                sinhala_count += 1
                total_chars += 1
            elif code_point in self.TAMIL_RANGE:
                tamil_count += 1
                total_chars += 1
            elif char.isalpha():
                total_chars += 1
        
        if total_chars == 0:
            return self.default_language, 0.0
        
        sinhala_ratio = sinhala_count / total_chars
        tamil_ratio = tamil_count / total_chars
        
        if sinhala_ratio > 0.3:
            return "si", min(sinhala_ratio * 1.5, 1.0)
        elif tamil_ratio > 0.3:
            return "ta", min(tamil_ratio * 1.5, 1.0)
        
        return self.default_language, 0.0
    
    def _detect_transliterated(self, text: str) -> Tuple[str, float]:
        """
        Detect transliterated Sinhala (→ 'singlish') or Tamil (→ 'tanglish') words.
        Returns the distinct register code, NOT the base language code.
        Requires at least _MIN_DICT_MATCHES to avoid false positives from
        single-word overlaps (e.g. "driver" appearing in the Singlish dict).
        """
        raw_words = set(re.findall(r'\b[a-zA-Z]+\b', text.lower()))
        
        if not raw_words:
            return self.default_language, 0.0
        
        # Normalize common misspellings via variant map
        words = {self._SPELLING_VARIANTS.get(w, w) for w in raw_words}
        
        # Domain-weighted scoring (PDF spec: domain words count 2×)
        def _weighted_matches(word_set: set, dictionary: set) -> float:
            score = 0.0
            for w in word_set:
                if w in dictionary:
                    score += DOMAIN_WEIGHT if w in _DOMAIN_WORDS else 1.0
            return score

        singlish_score = _weighted_matches(words, self.SINGLISH_WORDS)
        tamil_score = _weighted_matches(words, self.TAMIL_TRANSLITERATED)
        
        total_words = max(len(words), 1)
        
        # Instant-lock: single strong domain token is enough when score meets threshold
        if singlish_score > tamil_score and singlish_score >= self._MIN_DICT_MATCHES:
            confidence = min(singlish_score / total_words * 2, 0.9)
            if confidence >= self._INSTANT_LOCK_CONFIDENCE or singlish_score >= 1:
                return "singlish", max(confidence, self._REGISTER_THRESHOLD)
        elif tamil_score > singlish_score and tamil_score >= self._MIN_DICT_MATCHES:
            confidence = min(tamil_score / total_words * 2, 0.9)
            if confidence >= self._INSTANT_LOCK_CONFIDENCE or tamil_score >= 1:
                return "tanglish", max(confidence, self._REGISTER_THRESHOLD)
        
        return self.default_language, 0.0
    
    def _detect_with_langdetect(self, text: str) -> Optional[Tuple[str, float]]:
        """Use langdetect library for detection."""
        try:
            langs = detect_langs(text)
            
            for lang_prob in langs:
                lang_code = str(lang_prob.lang)
                confidence = lang_prob.prob
                
                # Map detected language to our supported languages
                if lang_code == 'si':
                    return 'si', confidence
                elif lang_code == 'ta':
                    return 'ta', confidence
                elif lang_code in ('en', 'eng'):
                    return 'en', confidence
            
            # If detected language is not supported, default to English
            return 'en', 0.5
            
        except LangDetectException:
            return None
    
    def _update_persistence(self, phone_number: str | None, lang: str) -> None:
        """Track consecutive detections for language persistence."""
        if not phone_number:
            return
        entry = self._confirmed_languages.get(phone_number)
        if entry and entry["lang"] == lang:
            entry["count"] += 1
        else:
            self._confirmed_languages[phone_number] = {"lang": lang, "count": 1}

    def get_confirmed_language(self, phone_number: str) -> str | None:
        """Return the persisted language if confirmed (2+ consecutive messages)."""
        entry = self._confirmed_languages.get(phone_number)
        if entry and entry["count"] >= 2:
            return entry["lang"]
        return None

    def is_greeting(self, text: str) -> Tuple[bool, Optional[str]]:
        """
        Check if the text is a greeting.

        Returns:
            Tuple of (is_greeting, language_code)
            language_code may be 'si', 'ta', 'en', 'singlish', or 'tanglish'.
        """
        text_lower = text.lower().strip()
        
        for lang, greetings in self.GREETINGS.items():
            for greeting in greetings:
                if greeting in text_lower:
                    return True, lang
        
        return False, None
    
    def normalize_text(self, text: str, detected_lang: str) -> str:
        """
        Normalize text for processing (basic cleanup + Unicode NFC).
        
        Args:
            text: Input text
            detected_lang: Detected language code
            
        Returns:
            Normalized text
        """
        # NFC normalize — combines diacritics for Sinhala/Tamil
        text = unicodedata.normalize("NFC", text)
        
        # Remove excessive whitespace
        text = ' '.join(text.split())
        
        # Basic cleanup
        text = text.strip()
        
        return text


# Singleton instance
language_detector = LanguageDetector()


def detect_language(text: str, phone_number: str | None = None) -> Tuple[str, float]:
    """Convenience function for language detection."""
    return language_detector.detect(text, phone_number)


def is_greeting(text: str) -> Tuple[bool, Optional[str]]:
    """Convenience function for greeting detection."""
    return language_detector.is_greeting(text)
