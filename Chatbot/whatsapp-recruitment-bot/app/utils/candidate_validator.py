"""
Candidate Validator
===================
Pre-push validation gate that ensures candidate data is complete
and correctly formatted before it is sent to the recruitment system.

Called by recruitment_sync.py before making the HTTP request.
"""

import re
import logging
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------

@dataclass
class ValidationResult:
    is_valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    def add_error(self, msg: str):
        self.errors.append(msg)
        self.is_valid = False

    def add_warning(self, msg: str):
        self.warnings.append(msg)

    def __bool__(self) -> bool:
        return self.is_valid


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

# E.164-compatible: optional leading +, then 7–15 digits
_PHONE_RE = re.compile(r'^\+?[0-9]{7,15}$')

# Basic RFC 5322 subset
_EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')

# Known throwaway email domains to warn about (not block)
_THROWAWAY_DOMAINS = {
    'mailinator.com', 'guerrillamail.com', 'tempmail.com',
    'throwam.com', 'fakeinbox.com', 'sharklasers.com',
    'guerrillamailblock.com', 'yopmail.com', 'trashmail.com',
    'dispostable.com', 'temp-mail.org', 'getnada.com',
}

VALID_LANGUAGES = {'en', 'si', 'ta'}


def validate_candidate(
    phone: Optional[str],
    name: Optional[str],
    email: Optional[str],
    job_interest: Optional[str],
    preferred_language: Optional[str],
    experience_years: Optional[Any],
    extracted_data: Optional[Dict] = None
) -> ValidationResult:
    """
    Run all validation rules against candidate fields.

    Returns a ValidationResult with:
      - is_valid: False if any hard rule fails (blocks push)
      - errors: list of blocking problems
      - warnings: list of non-blocking notes
    """
    result = ValidationResult(is_valid=True)
    extracted_data = extracted_data or {}

    # ── phone: REQUIRED, format check ─────────────────────────────────────
    if not phone or not isinstance(phone, str):
        result.add_error("phone is required")
    else:
        normalized = phone.replace(' ', '').replace('-', '').replace('(', '').replace(')', '')
        if not _PHONE_RE.match(normalized):
            result.add_error(
                f"phone format invalid: '{phone}' — expected E.164 e.g. +94771234567"
            )

    # ── name: REQUIRED, length/content check ──────────────────────────────
    if not name or not isinstance(name, str):
        result.add_error("name is required")
    elif len(name.strip()) < 2:
        result.add_error("name is too short (minimum 2 characters)")
    elif name.strip().isdigit():
        result.add_error("name appears to be a number, not a real name")
    elif len(name.strip()) > 200:
        result.add_error("name is too long (maximum 200 characters)")

    # ── job_interest: REQUIRED ─────────────────────────────────────────────
    if not job_interest or not isinstance(job_interest, str):
        result.add_error("job_interest is required — the role the candidate wants to apply for")
    elif len(job_interest.strip()) < 2:
        result.add_error("job_interest is too short")

    # ── email: OPTIONAL but validate format if present ────────────────────
    if email and isinstance(email, str) and email.strip():
        if not _EMAIL_RE.match(email.strip()):
            result.add_error(f"email format invalid: '{email}'")
        else:
            # Warn about throwaway domains
            domain = email.strip().lower().split('@')[-1]
            if domain in _THROWAWAY_DOMAINS:
                result.add_warning(f"email domain '{domain}' appears to be a disposable address")

    # ── preferred_language: optional but must be valid if present ─────────
    if preferred_language and preferred_language not in VALID_LANGUAGES:
        result.add_warning(
            f"preferred_language '{preferred_language}' is not recognised — defaulting to 'en'. "
            f"Valid values: {', '.join(VALID_LANGUAGES)}"
        )

    # ── experience_years: optional, must be sensible integer ──────────────
    if experience_years is not None:
        try:
            exp = int(experience_years)
            if exp < 0 or exp > 60:
                result.add_error(
                    f"experience_years must be between 0 and 60, got {exp}"
                )
        except (TypeError, ValueError):
            result.add_error(
                f"experience_years must be an integer, got '{experience_years}'"
            )

    # ── cross-field consistency warnings ──────────────────────────────────
    # If chatbot collected experience and CV says different — warn
    stated_exp = extracted_data.get('experience_years_stated')
    if stated_exp and experience_years is not None:
        try:
            stated_int = int(str(stated_exp).split()[0])
            cv_int = int(experience_years)
            if abs(stated_int - cv_int) > 5:
                result.add_warning(
                    f"Experience mismatch: candidate stated {stated_int} years, "
                    f"CV extracted {cv_int} years. Recommend manual review."
                )
        except (ValueError, TypeError):
            pass

    # ── Log result ─────────────────────────────────────────────────────────
    if result.is_valid:
        if result.warnings:
            logger.info(
                f"Validation PASSED for '{name}' / '{phone}' "
                f"with {len(result.warnings)} warning(s): {result.warnings}"
            )
        else:
            logger.debug(f"Validation PASSED (clean) for '{name}' / '{phone}'")
    else:
        logger.warning(
            f"Validation FAILED for '{name}' / '{phone}': {result.errors}"
        )

    return result
