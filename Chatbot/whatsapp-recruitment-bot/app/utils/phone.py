"""
Phone normalisation
====================
Mirrors the recruitment backend's normaliser (backend/src/utils/phone.js) so the
chatbot and the Node backend agree, byte-for-byte, on the canonical form of a
phone number. This is the de-dup key: the agent "Add candidate" flow stores
E.164 (``+94...``) while Meta's webhook delivers the raw ``wa_id`` without a
leading ``+`` (e.g. ``94775774171``). Without a shared normaliser those two
strings never match and the same person ends up with two candidate rows / chats.

Output: E.164 with a leading ``+`` (e.g. ``+94775774171``), or ``None`` when the
input cannot be reliably normalised.

Sri Lanka:  0XXXXXXXXX (10 digits)  -> +94XXXXXXXXX
            94XXXXXXXXX (11 digits) -> +94XXXXXXXXX
Gulf / international: any 10-15 digit number (already E.164 or wa_id) -> +<digits>
"""

import re
from typing import Optional


def normalize_phone(raw) -> Optional[str]:
    """Normalise any phone number to E.164 (``+XXXXXXXXXXX``). Returns ``None`` if
    the input cannot be reliably normalised."""
    if not raw:
        return None

    raw_str = str(raw).strip()
    digits = re.sub(r"\D", "", raw_str)
    if not digits:
        return None

    # Sri Lanka local format: 0XXXXXXXXX (10 digits)
    if digits.startswith("0") and len(digits) == 10:
        return "+94" + digits[1:]

    # Sri Lanka with country code: 94XXXXXXXXX (11 digits)
    if digits.startswith("94") and len(digits) == 11:
        return "+" + digits

    # Already has a leading +: keep the digits, re-add the +
    if raw_str.startswith("+") and 10 <= len(digits) <= 15:
        return "+" + digits

    # Gulf / other international: 10-15 digit number without a leading zero
    # (this is the branch Meta's wa_id takes, e.g. "94775774171" -> "+94775774171")
    if not digits.startswith("0") and 10 <= len(digits) <= 15:
        return "+" + digits

    return None


def normalize_phone_or_raw(raw) -> Optional[str]:
    """Like :func:`normalize_phone` but never loses an un-recognised number: falls
    back to the trimmed original so a number we can't normalise is still usable as
    a (consistent) lookup/storage key rather than being dropped."""
    if raw is None:
        return None
    return normalize_phone(raw) or str(raw).strip()


def phone_variants(raw):
    """Every equivalent STORED form of a number, most-canonical first, so a lookup
    still matches rows written before normalisation existed:
        +94775774171  (E.164, canonical)
        94775774171   (no leading +, e.g. legacy Meta wa_id rows)
        0775774171    (Sri Lanka local form)
    Deriving the variants from the NORMALISED number (not the raw input) is what
    lets a normalised ``+94…`` lookup still find a legacy ``94…`` / ``0…`` row."""
    out = []

    def add(v):
        if v and v not in out:
            out.append(v)

    norm = normalize_phone(raw)
    if norm:
        add(norm)
        add(norm.lstrip("+"))
        # SL mobile (+94 + 9 digits) also stored historically as 0XXXXXXXXX
        if norm.startswith("+94") and len(norm) == 12:
            add("0" + norm[3:])
    if raw is not None:
        add(str(raw).strip())
    return out
