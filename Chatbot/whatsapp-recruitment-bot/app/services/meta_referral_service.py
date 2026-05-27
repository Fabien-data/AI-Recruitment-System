"""Meta Click-to-WhatsApp referral resolver.

When a candidate taps a paid Meta CTWA ad, Meta attaches a ``referral`` object
to the first message webhook. The object carries the ad's *headline* and
*body* text (plus a Meta ad ID), but no direct link to our internal job UUID.

This service bridges that gap without needing marketing to manually map ads
to jobs: it fuzzy-matches the ad headline against the titles of currently
active jobs in our cache and returns the best-scoring match with a
confidence value. If confidence is high (≥ ``AUTO_CONFIDENCE``) the
orchestrator can drop the candidate straight into the per-job ad-intake
flow. If confidence is lower but we have plausible candidates, it returns
the top few so the chatbot can ask "which of these is the role?".

Why headline-based matching and not the ad ID
─────────────────────────────────────────────
The Meta ad ID (``referral.source_id``) is opaque and changes per ad
campaign. To use it we'd need an admin page where marketing pastes the ad
ID against the job after creating each ad. Headline-based matching skips
that step entirely — marketing just keeps the ad headline aligned with
the job title (which they do anyway for ad copy), and the chatbot resolves
it on the fly.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from app.services.vacancy_service import vacancy_service

logger = logging.getLogger(__name__)


# Thresholds tuned on a small sample of real Meta ad headlines. Adjust if
# you see legitimate matches being missed: drop AUTO_CONFIDENCE to e.g. 0.7,
# or raise CANDIDATE_FLOOR to 0.6 to filter out noise from the
# disambiguation list.
AUTO_CONFIDENCE = 0.80      # ≥ this → auto-route to the matched job
CANDIDATE_FLOOR = 0.45      # below this → don't even surface as a candidate
MAX_CANDIDATES = 3          # how many disambiguation options to offer


@dataclass
class JobMatch:
    """One scored candidate job from the headline-matching pass."""
    job: Dict[str, Any]
    score: float

    @property
    def job_id(self) -> Optional[str]:
        return self.job.get("id") or self.job.get("job_id")

    @property
    def title(self) -> str:
        return str(self.job.get("title") or self.job.get("job_title") or "")


@dataclass
class ReferralMatchResult:
    """Outcome of resolving a Meta referral against active jobs.

    The orchestrator branches on this:
      - ``best`` with ``score ≥ AUTO_CONFIDENCE`` → route straight to that job
      - ``best`` exists but below the auto bar → show ``candidates`` as a
        disambiguation list
      - Nothing scored above ``CANDIDATE_FLOOR`` → fall back to generic flow
    """
    best: Optional[JobMatch]
    candidates: List[JobMatch]

    @property
    def is_confident(self) -> bool:
        return bool(self.best and self.best.score >= AUTO_CONFIDENCE)

    @property
    def has_candidates(self) -> bool:
        return len(self.candidates) > 0


_WORD_SPLIT_RE = re.compile(r"[^\w]+", re.UNICODE)
_NOISE_TOKENS = {
    # English filler words that show up in ad copy but carry no role meaning.
    "apply", "now", "hiring", "urgent", "needed", "wanted", "vacancy",
    "vacancies", "job", "jobs", "opportunity", "opening", "openings",
    "position", "positions", "the", "a", "an", "for", "in", "to", "and",
    "of", "with", "available",
    # WhatsApp emoji-adjacent words people drop into headlines
    "click", "message", "chat", "info",
}


def _normalize(text: str) -> str:
    """Lowercase + strip punctuation/emoji + collapse whitespace."""
    if not text:
        return ""
    no_emoji = re.sub(r"[^\w\s\-]", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", no_emoji).strip().lower()


def _tokens(text: str) -> List[str]:
    """Tokenize and drop short / noise tokens that distort similarity."""
    return [
        t for t in _WORD_SPLIT_RE.split(_normalize(text))
        if t and len(t) >= 2 and t not in _NOISE_TOKENS
    ]


def _token_set_ratio(a: str, b: str) -> float:
    """Jaccard similarity over deduped token sets. Robust to word reordering
    (e.g. 'Driver Qatar' vs 'Qatar Driver Urgent Hiring')."""
    set_a, set_b = set(_tokens(a)), set(_tokens(b))
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


def _substring_bonus(headline: str, title: str) -> float:
    """0.95 if the full job title appears as a substring of the headline.
    Catches the common case where marketing writes 'Apply for Driver — Qatar'
    targeting a job titled exactly 'Driver — Qatar'."""
    h, t = _normalize(headline), _normalize(title)
    if t and len(t) >= 3 and t in h:
        return 0.95
    return 0.0


def _sequence_ratio(a: str, b: str) -> float:
    """difflib character-level similarity. Picks up partial overlaps
    (e.g. typos: 'Driver Qatr' vs 'Driver Qatar')."""
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, _normalize(a), _normalize(b)).ratio()


def _score_one(headline: str, body: str, job: Dict[str, Any]) -> float:
    """Combine signals into a single 0-1 score for one job. Order matters:
    we take the *max* across signals because each captures a different
    matching style — substring is the strongest evidence."""
    title = str(job.get("title") or job.get("job_title") or "")
    if not title:
        return 0.0

    # Build composite strings for comparison so country/category nudge the
    # score for ads like "Driver Qatar — apply now".
    countries = job.get("countries") or []
    country = str(countries[0]) if countries else str(job.get("country") or "")
    title_with_country = f"{title} {country}".strip()
    category = str(job.get("category") or "")

    headline_substring = _substring_bonus(headline, title)
    body_substring = _substring_bonus(body, title) * 0.85  # body is weaker signal

    headline_tokens = _token_set_ratio(headline, title_with_country)
    headline_seq = _sequence_ratio(headline, title_with_country)

    # Category signal — only as a small tiebreaker
    category_bonus = 0.0
    if category and category.lower() in _normalize(headline):
        category_bonus = 0.1

    return max(
        headline_substring,
        body_substring,
        headline_tokens + category_bonus,
        headline_seq * 0.9,  # sequence ratio is fuzzy, weight it down slightly
    )


class MetaReferralService:
    """Resolves Meta CTWA referral payloads to internal job records."""

    @staticmethod
    def is_referral(payload: Optional[Dict[str, Any]]) -> bool:
        """True when the message payload carries a Meta CTWA referral.
        Always check this before doing the heavy fuzzy-matching work."""
        return bool(payload and isinstance(payload, dict) and payload.get("source_type"))

    def match(self, referral: Dict[str, Any]) -> ReferralMatchResult:
        """Score every active vacancy against the ad's headline + body and
        return the best match + top candidates. Pure synchronous work — no
        I/O — so it's safe to call inside the orchestrator hot path."""
        if not isinstance(referral, dict):
            return ReferralMatchResult(best=None, candidates=[])

        headline = str(referral.get("headline") or "")
        body = str(referral.get("body") or "")
        if not headline and not body:
            logger.info("Meta referral has neither headline nor body; cannot match")
            return ReferralMatchResult(best=None, candidates=[])

        try:
            vacancies = vacancy_service.get_all_vacancies() or []
        except Exception as exc:
            logger.warning("Could not load vacancies for referral match: %s", exc)
            return ReferralMatchResult(best=None, candidates=[])

        if not vacancies:
            logger.info("No active vacancies to match referral headline=%r", headline)
            return ReferralMatchResult(best=None, candidates=[])

        scored: List[JobMatch] = []
        for job in vacancies:
            score = _score_one(headline, body, job)
            if score >= CANDIDATE_FLOOR:
                scored.append(JobMatch(job=job, score=score))

        scored.sort(key=lambda m: m.score, reverse=True)
        top = scored[:MAX_CANDIDATES]
        best = top[0] if top else None

        if best:
            logger.info(
                "Meta referral matched headline=%r → job=%r (score=%.2f, candidates=%d)",
                headline, best.title, best.score, len(top),
            )
        else:
            logger.info(
                "Meta referral could not match headline=%r against %d active jobs",
                headline, len(vacancies),
            )

        return ReferralMatchResult(best=best, candidates=top)


    def match_from_text(self, text: str) -> ReferralMatchResult:
        """Headline-style fuzzy match against the candidate's message body.

        Used when Meta did NOT supply a ``referral`` object on the first
        message (paid-ad referrals sometimes drop, plus candidates who
        copy-paste the friendly pre-fill text). Treats the message body as
        if it were the ad headline AND body, and runs the same scoring as
        ``match()``. This catches cases like:

            "Hi! I want to apply for this Security Officer - Female position
             in Dubai."

        which contains the exact CRM title as a substring → high-confidence
        auto-route into the per-job ad flow.

        Returns the same ``ReferralMatchResult`` shape so the caller can
        reuse the existing handler logic unchanged.
        """
        if not text or not text.strip():
            return ReferralMatchResult(best=None, candidates=[])
        synthetic = {"headline": text, "body": text, "source_type": "text"}
        result = self.match(synthetic)
        if result.best:
            logger.info(
                "Ad-intent body match: text=%r -> job=%r (score=%.2f, candidates=%d)",
                text[:80], result.best.title, result.best.score, len(result.candidates),
            )
        return result


meta_referral_service = MetaReferralService()
