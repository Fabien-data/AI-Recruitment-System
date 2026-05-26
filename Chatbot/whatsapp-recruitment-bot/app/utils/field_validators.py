"""Per-field validators for the deterministic ad-intake flow.

Each validator returns a ValidationResult: ``ok`` flips False when the user's
reply cannot be accepted for that field, ``value`` carries the normalized
storage form (e.g. age as int, email lowercased), and ``hint`` is the
multilingual hint key the caller looks up in ``HINTS`` to re-ask in plain
language.

Validators are intentionally permissive on the input side (accept "I'm 28",
"twenty-eight", "28 years") and strict on the output side (always return an
int). The ad-intake state machine treats ``ok=False`` as "ask again with a
hint" rather than escalation — escalation kicks in only after repeated misses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple


@dataclass
class ValidationResult:
    ok: bool
    value: Any = None
    hint: Optional[str] = None  # key into HINTS


# Hint messages keyed by (field, hint_code, language). The state machine
# resolves these to the locked language when re-asking.
HINTS: Dict[str, Dict[str, str]] = {
    "name_too_short": {
        "en": "That looks a bit short — could you share your full name (first and last)?",
        "si": "ඒක ටිකක් කෙටියි වගේ — කරුණාකර ඔබේ සම්පූර්ණ නම (මුල් නම සහ වාසගම) කියන්න.",
        "ta": "அது சற்று குறைவாக உள்ளது — உங்கள் முழுப் பெயரை (முதல் பெயர் மற்றும் கடைசி பெயர்) சொல்லுங்கள்.",
        "singlish": "Eka tikak kethi — full name eka (first name + last name) kiyanna.",
        "tanglish": "Athu konjam kuraivu — unga full name (first name + last name) sollunga.",
    },
    "age_not_a_number": {
        "en": "I need just a number for your age — e.g. 28.",
        "si": "වයස number එකකින් කියන්න — උදා: 28.",
        "ta": "உங்கள் வயதை number-ஆக சொல்லுங்கள் — எ.கா: 28.",
        "singlish": "Wasaya number ekakin kiyanna — eg: 28.",
        "tanglish": "Unga vayasa number-a sollunga — eg: 28.",
    },
    "age_out_of_range": {
        "en": "Most Gulf jobs accept ages 18–60. Could you confirm your age?",
        "si": "Gulf රැකියා බොහෝමයක් 18–60 අතර වයස් සඳහා. ඔබේ වයස නැවත තහවුරු කරන්නද?",
        "ta": "பெரும்பாலான Gulf வேலைகள் 18–60 வயது வரம்பில் உள்ளன. உங்கள் வயதை உறுதிப்படுத்துங்கள்.",
        "singlish": "Gulf jobs godak 18–60 atharei. Oyage wasaya confirm karanna puluwanda?",
        "tanglish": "Gulf jobs perumbalum 18–60 vayasula. Unga vayasa confirm pannunga.",
    },
    "email_invalid": {
        "en": "That doesn't look like a valid email — could you double-check? (e.g. name@example.com)",
        "si": "ඒක නිවැරදි email එකක් වගේ පෙනෙන්නේ නැහැ — නැවත බලන්නද? (උදා: name@example.com)",
        "ta": "அது சரியான email-ஆக தெரியவில்லை — மீண்டும் சரிபார்க்கவும். (எ.கா: name@example.com)",
        "singlish": "Eka hari email ekak wage nehe — aaye balanna. (eg: name@example.com)",
        "tanglish": "Athu sariyana email-a illa — thirumba paarkavum. (eg: name@example.com)",
    },
    "experience_not_a_number": {
        "en": "How many years of experience? Just the number is fine — e.g. 3.",
        "si": "කොපමණ අවුරුදු experience තියෙනවද? Number එක විතරයි — උදා: 3.",
        "ta": "எவ்வளவு வருட experience? Number மட்டும் சொன்னா போதும் — எ.கா: 3.",
        "singlish": "Kochchara avurudu experience tiyenawada? Number eka vitharai — eg: 3.",
        "tanglish": "Evvalo varudam experience irukku? Number mattum sollunga — eg: 3.",
    },
    "phone_invalid": {
        "en": "That doesn't look like a phone number — could you share digits only? (e.g. 0771234567)",
        "si": "Phone number එකක් වගේ පෙනෙන්නේ නැහැ — ඉලක්කම් විතරක් කියන්නද? (උදා: 0771234567)",
        "ta": "Phone number மாதிரி தெரியவில்லை — digits மட்டும் சொல்லுங்கள். (எ.கா: 0771234567)",
        "singlish": "Phone number ekak wage nehe — digits vitharak kiyanna. (eg: 0771234567)",
        "tanglish": "Phone number mathiri illa — digits mattum sollunga. (eg: 0771234567)",
    },
    "passport_invalid": {
        "en": "Passport numbers are usually 6–9 letters/digits — could you share again?",
        "si": "Passport number එක සාමාන්‍යයෙන් අකුරු/ඉලක්කම් 6–9ක්. නැවත කියන්නද?",
        "ta": "Passport number பொதுவாக 6–9 எழுத்து/digits. மீண்டும் சொல்லுங்கள்.",
        "singlish": "Passport number eka usually 6–9 letters/digits. Aaye kiyanna.",
        "tanglish": "Passport number usually 6–9 letters/digits. Thirumba sollunga.",
    },
    "height_invalid": {
        "en": "Could you share your height? Either cm (e.g. 170) or feet+inches (e.g. 5'7\") works.",
        "si": "ඔබේ උස කියන්නද? cm (උදා: 170) හෝ feet+inches (උදා: 5'7\") දෙකම හරි.",
        "ta": "உங்கள் உயரத்தைச் சொல்லுங்கள் — cm (எ.கா: 170) அல்லது feet+inches (எ.கா: 5'7\").",
        "singlish": "Oyage usa kiyanna — cm (eg: 170) hari feet+inches (eg: 5'7\") hari.",
        "tanglish": "Unga uyaratha sollunga — cm (eg: 170) illana feet+inches (eg: 5'7\").",
    },
    "generic_empty": {
        "en": "I didn't catch that — could you share it again?",
        "si": "මට ඒක තේරුණේ නැහැ — නැවත කියන්නද?",
        "ta": "புரியவில்லை — மீண்டும் சொல்லுங்கள்.",
        "singlish": "Eka therunne nehe — aaye kiyanna.",
        "tanglish": "Purila — thirumba sollunga.",
    },
}


def hint_text(hint_key: str, lang: str) -> str:
    """Resolve a hint key + language to the message string."""
    if not hint_key:
        return ""
    bundle = HINTS.get(hint_key) or HINTS["generic_empty"]
    return bundle.get(lang) or bundle.get("en") or ""


# ─────────────────────────────────────────────────────────────────────────────
# Individual validators
# ─────────────────────────────────────────────────────────────────────────────

_NAME_LEAD_PATTERNS = [
    r"^(?:my\s+name\s+is|i\s*am|i'?m|this\s+is|name\s*[:\-])\s+",
    r"^(?:මගේ\s*නම\s*[:\-]?)\s*",
    r"^(?:mage\s+nama\s+(?:eka|thamai|thamaa)?\s*[:\-]?)\s*",
    r"^(?:என்\s*பெயர்\s*[:\-]?)\s*",
    r"^(?:en\s+peyar\s*[:\-]?)\s*",
]
_NAME_LEAD_RE = re.compile("|".join(_NAME_LEAD_PATTERNS), re.IGNORECASE)


def validate_name(text: str) -> ValidationResult:
    raw = (text or "").strip()
    cleaned = _NAME_LEAD_RE.sub("", raw, count=1).strip(" .,-—")
    if len(cleaned) < 2 or not re.search(r"[A-Za-z඀-෿஀-௿]", cleaned):
        return ValidationResult(ok=False, hint="name_too_short")
    # Collapse internal whitespace and title-case ASCII portions.
    parts = [p for p in re.split(r"\s+", cleaned) if p]
    normalized = " ".join(
        p.title() if re.fullmatch(r"[A-Za-z'.-]+", p) else p for p in parts
    )
    return ValidationResult(ok=True, value=normalized)


# Multilingual digit map for ages/years.
_DIGIT_MAP = str.maketrans("෦෧෨෩෪෫෬෭෮෯௦௧௨௩௪௫௬௭௮௯", "01234567890123456789")


def _extract_first_int(text: str) -> Optional[int]:
    if not text:
        return None
    normalized = text.translate(_DIGIT_MAP)
    match = re.search(r"\d{1,3}", normalized)
    return int(match.group()) if match else None


def validate_age(text: str) -> ValidationResult:
    n = _extract_first_int(text)
    if n is None:
        return ValidationResult(ok=False, hint="age_not_a_number")
    if n < 18 or n > 60:
        return ValidationResult(ok=False, hint="age_out_of_range")
    return ValidationResult(ok=True, value=n)


_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def validate_email(text: str) -> ValidationResult:
    if not text:
        return ValidationResult(ok=False, hint="email_invalid")
    match = _EMAIL_RE.search(text.strip())
    if not match:
        return ValidationResult(ok=False, hint="email_invalid")
    return ValidationResult(ok=True, value=match.group().lower())


# ─── Experience years ───────────────────────────────────────────────────────
# Mirrors orchestrator._parse_multilingual_experience so the deterministic
# flow accepts the same word forms ("paha", "rendu", "தோத்து").

_EXP_WORD_MAP = {
    "eka": 1, "deka": 2, "dekai": 2, "rendu": 2, "irandu": 2,
    "thuna": 3, "naangu": 4, "paha": 5, "anju": 5, "haya": 6, "aaru": 6,
    "hatha": 7, "ezhu": 7, "ata": 8, "ettu": 8, "navaya": 9, "onbadhu": 9,
    "dahaya": 10, "pathu": 10,
    "එක": 1, "එකයි": 1, "දෙක": 2, "දෙකයි": 2, "තුන": 3, "හතර": 4,
    "පහ": 5, "හය": 6, "හත": 7, "අට": 8, "නවය": 9, "දහය": 10,
    "ஒன்று": 1, "ஒரு": 1, "இரண்டு": 2, "ரெண்டு": 2, "மூன்று": 3,
    "நான்கு": 4, "ஐந்து": 5, "ஆறு": 6, "ஏழு": 7, "எட்டு": 8,
    "ஒன்பது": 9, "பத்து": 10,
}


def validate_experience_years(text: str) -> ValidationResult:
    if not text:
        return ValidationResult(ok=False, hint="experience_not_a_number")
    normalized = text.translate(_DIGIT_MAP).lower()
    scoped = re.search(
        r"\b(\d{1,2})\b\s*(year|years|yr|yrs|avurudu|awurudu|varudam|varusham|வருடம்|ஆண்டு|අවුරුදු)",
        normalized,
    )
    if scoped:
        return ValidationResult(ok=True, value=int(scoped.group(1)))
    tokens = re.findall(r"[\w஀-෿]+", normalized)
    for token in tokens:
        if token in _EXP_WORD_MAP:
            return ValidationResult(ok=True, value=_EXP_WORD_MAP[token])
    plain = re.search(r"\b(\d{1,2})\b", normalized)
    if plain:
        n = int(plain.group(1))
        if 0 <= n <= 50:
            return ValidationResult(ok=True, value=n)
    return ValidationResult(ok=False, hint="experience_not_a_number")


def validate_phone(text: str) -> ValidationResult:
    if not text:
        return ValidationResult(ok=False, hint="phone_invalid")
    digits = re.sub(r"\D", "", text)
    if len(digits) < 9 or len(digits) > 15:
        return ValidationResult(ok=False, hint="phone_invalid")
    return ValidationResult(ok=True, value=digits)


def validate_passport_number(text: str) -> ValidationResult:
    if not text:
        return ValidationResult(ok=False, hint="passport_invalid")
    cleaned = re.sub(r"\s+", "", text).upper()
    if not re.fullmatch(r"[A-Z0-9]{6,9}", cleaned):
        return ValidationResult(ok=False, hint="passport_invalid")
    return ValidationResult(ok=True, value=cleaned)


def validate_height_cm(text: str) -> ValidationResult:
    if not text:
        return ValidationResult(ok=False, hint="height_invalid")
    normalized = text.translate(_DIGIT_MAP).lower().strip()
    # feet+inches: 5'7", 5 ft 7 in, 5'7
    ft_in = re.search(r"(\d)\s*['′ft]+\s*(\d{1,2})?", normalized)
    if ft_in:
        feet = int(ft_in.group(1))
        inches = int(ft_in.group(2) or 0)
        cm = round(feet * 30.48 + inches * 2.54)
        if 120 <= cm <= 220:
            return ValidationResult(ok=True, value=cm)
    # plain cm
    n = _extract_first_int(normalized)
    if n is not None and 120 <= n <= 220:
        return ValidationResult(ok=True, value=n)
    return ValidationResult(ok=False, hint="height_invalid")


def validate_generic(text: str) -> ValidationResult:
    """Fallback for fields with no specific validator — accept non-empty."""
    raw = (text or "").strip()
    if len(raw) < 2:
        return ValidationResult(ok=False, hint="generic_empty")
    return ValidationResult(ok=True, value=raw)


# ─────────────────────────────────────────────────────────────────────────────
# Registry — field name → validator. Add new fields here as the per-job
# `required_fields_schema` grows. Unknown fields fall back to validate_generic.
# ─────────────────────────────────────────────────────────────────────────────

VALIDATORS: Dict[str, Callable[[str], ValidationResult]] = {
    "name": validate_name,
    "age": validate_age,
    "email": validate_email,
    "experience_years": validate_experience_years,
    "experience": validate_experience_years,
    "phone": validate_phone,
    "phone_alternative": validate_phone,
    "alternative_phone": validate_phone,
    "passport_number": validate_passport_number,
    "passport_no": validate_passport_number,
    "height_cm": validate_height_cm,
    "height": validate_height_cm,
}


def validate(field: str, text: str) -> ValidationResult:
    """Run the validator registered for ``field`` (or the generic fallback)."""
    fn = VALIDATORS.get(field, validate_generic)
    return fn(text)


def validate_with_ai_hint(
    field: str,
    text: str,
    ai_extracted: Optional[Any] = None,
) -> ValidationResult:
    """Validate the user text; if AI already extracted a structured value for
    this field and the raw text fails validation, fall back to the AI value
    (still re-validated by the field's validator so storage stays clean)."""
    primary = validate(field, text)
    if primary.ok or ai_extracted is None:
        return primary
    secondary = validate(field, str(ai_extracted))
    return secondary if secondary.ok else primary
