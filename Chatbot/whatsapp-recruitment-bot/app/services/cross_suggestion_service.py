"""
Cross-job suggestion gate.

Owns two responsibilities:
  1. Detect when the candidate is mismatched for the current job.
  2. Enforce the "push original for 2 turns, then pivot" rule, returning a
     structured ``MISMATCH_HINT`` dict that the system prompt embeds verbatim.

The conversation agent never computes scores itself — it asks
``cross_suggestion_service.build_hint(state, current_job)`` once per turn.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.knowledge import get_job_cache

logger = logging.getLogger(__name__)


# Treat skills/requirements text matching as case-insensitive whole-token
# overlap. Cheap and good enough — high-fidelity matching is the validator's
# job, not the gate's.
def _tokenize(value: Any) -> List[str]:
    if not value:
        return []
    if isinstance(value, list):
        joined = " ".join(str(v) for v in value)
    elif isinstance(value, dict):
        joined = " ".join(str(v) for v in value.values())
    else:
        joined = str(value)
    return [t for t in (w.strip().lower() for w in joined.replace(",", " ").split()) if t]


def _candidate_skills(collected: Dict[str, Any], cv_extracted: Dict[str, Any]) -> List[str]:
    tokens = _tokenize(collected.get("skills"))
    tokens.extend(_tokenize(cv_extracted.get("skills")))
    tokens.extend(_tokenize(collected.get("job_role")))
    return list(dict.fromkeys(tokens))


def _job_skill_tokens(job: Dict[str, Any]) -> List[str]:
    req = job.get("requirements") or job.get("job_requirements") or {}
    if isinstance(req, dict):
        text = " ".join(str(v) for v in req.values())
    else:
        text = str(req)
    return _tokenize(text)


def _detect_mismatch_reason(collected: Dict[str, Any], cv: Dict[str, Any], job: Dict[str, Any]) -> Optional[str]:
    if not job:
        return None
    # Experience delta
    job_req = job.get("requirements") or job.get("job_requirements") or {}
    min_exp = job_req.get("experience_years") or job_req.get("min_experience")
    cand_exp = collected.get("experience_years") or cv.get("experience_years")
    try:
        if min_exp is not None and cand_exp is not None:
            if abs(int(cand_exp) - int(min_exp)) >= 5:
                return "experience_mismatch"
    except (TypeError, ValueError):
        pass

    # Country mismatch
    job_countries = [c.lower() for c in (job.get("countries") or []) if c]
    cand_country = (collected.get("country") or "").lower()
    if job_countries and cand_country and cand_country not in job_countries:
        return "country_mismatch"

    # Skill mismatch — zero overlap
    job_tokens = set(_job_skill_tokens(job))
    if job_tokens:
        cand_tokens = set(_candidate_skills(collected, cv))
        if cand_tokens and not (job_tokens & cand_tokens):
            return "skill_mismatch"

    return None


class CrossSuggestionService:
    async def build_hint(
        self,
        state: Dict[str, Any],
        current_job: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        if not current_job:
            return {"status": "no_mismatch"}

        collected = state.get("collected_data") or {}
        cv = (state.get("ad_context") or {}).get("cv_parsed") or {}
        reason = _detect_mismatch_reason(collected, cv, current_job)

        if not reason:
            return {"status": "no_mismatch"}

        turns_since = int(state.get("turns_since_mismatch_detected") or 0)
        title = current_job.get("job_title") or current_job.get("title") or "this role"

        # Find an alternative job — exclude the current one and any already-
        # offered-but-not-declined alternatives.
        alt = await self.get_best_alternative(state, current_job)

        if turns_since < 2 or alt is None:
            return {
                "status": "too_early",
                "title": title,
                "reason": reason,
            }

        return {
            "status": "allow_pivot",
            "title": title,
            "reason": reason,
            "alternative_job_id": alt.get("job_id") or alt.get("id"),
            "alternative_title": alt.get("title"),
        }

    async def get_best_alternative(
        self,
        state: Dict[str, Any],
        current_job: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        current_id = current_job.get("job_id") or current_job.get("id")
        offers = state.get("alternatives_offered") or []
        already_offered = {
            o.get("job_id") for o in offers
            if o.get("outcome") != "declined"
        }

        # Score against ACTIVE_JOBS through the existing job_matching_service.
        try:
            from app.services.job_matching_service import job_matching_service  # type: ignore
            collected = state.get("collected_data") or {}
            skills_value = collected.get("skills")
            if isinstance(skills_value, str):
                candidate_skills = [s.strip() for s in skills_value.split(",") if s.strip()]
            elif isinstance(skills_value, list):
                candidate_skills = [str(s) for s in skills_value if s]
            else:
                candidate_skills = []
            ranked = await job_matching_service.get_ranked_matches(
                job_role=collected.get("job_role") or current_job.get("category"),
                country=collected.get("country"),
                candidate_skills=candidate_skills,
                experience_years=collected.get("experience_years"),
                limit=5,
            ) or []
            for job in ranked:
                jid = job.get("job_id") or job.get("id")
                if jid and jid != current_id and jid not in already_offered:
                    return job
        except Exception as exc:    # noqa: BLE001
            logger.debug("job_matching_service ranking failed: %s", exc)

        # Fallback: newest job that isn't the current one and isn't already offered.
        cache = get_job_cache() or {}
        candidates = [
            j for j in cache.values()
            if (j.get("status") or "").lower() == "active"
            and (j.get("job_id") or j.get("id")) != current_id
            and (j.get("job_id") or j.get("id")) not in already_offered
        ]
        if not candidates:
            return None
        candidates.sort(
            key=lambda j: j.get("created_at") or j.get("updated_at") or "",
            reverse=True,
        )
        return candidates[0]


cross_suggestion_service = CrossSuggestionService()
