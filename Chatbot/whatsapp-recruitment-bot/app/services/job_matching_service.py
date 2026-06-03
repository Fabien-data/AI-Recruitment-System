"""Deterministic job matching service for ranked vacancy recommendations."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from app.services.vacancy_service import vacancy_service


# City / variant → canonical country so a candidate naming a CITY ("Dubai")
# matches a job whose country is the COUNTRY ("United Arab Emirates"), and
# "UAE"/"U.A.E." normalise to the same value. Keep in sync with the AI brain's
# CITY↔COUNTRY hard rule and vacancy_service's alias map.
_COUNTRY_ALIASES = {
    "uae": "united arab emirates",
    "u.a.e": "united arab emirates",
    "u.a.e.": "united arab emirates",
    "emirates": "united arab emirates",
    "dubai": "united arab emirates",
    "abu dhabi": "united arab emirates",
    "sharjah": "united arab emirates",
    "ajman": "united arab emirates",
    "ras al khaimah": "united arab emirates",
    "doha": "qatar",
    "riyadh": "saudi arabia",
    "jeddah": "saudi arabia",
    "dammam": "saudi arabia",
    "ksa": "saudi arabia",
    "kuwait city": "kuwait",
    "manama": "bahrain",
    "muscat": "oman",
}


def _canon_country(value) -> str:
    v = str(value or "").strip().lower()
    return _COUNTRY_ALIASES.get(v, v)


class JobMatchingService:
    """Ranks jobs using weighted relevance scoring."""

    SKILL_WEIGHT = 0.5
    EXPERIENCE_WEIGHT = 0.2
    COUNTRY_WEIGHT = 0.3

    async def get_ranked_matches(
        self,
        job_role: Optional[str],
        country: Optional[str],
        candidate_skills: Optional[List[str]] = None,
        experience_years: Optional[int] = None,
        limit: int = 5,
    ) -> List[Dict[str, Any]]:
        entities = {
            "job_roles": [job_role] if job_role else [],
            "countries": [country] if country else [],
            "skills": candidate_skills or [],
            "experience_years": experience_years,
        }
        jobs = await vacancy_service.get_ranked_jobs(entities=entities, limit=max(limit * 2, 5))

        scored = []
        for job in jobs:
            score = self._score_job(job, country=country, candidate_skills=candidate_skills or [], experience_years=experience_years)
            enriched = dict(job)
            enriched["match_score"] = round(score, 4)
            scored.append(enriched)

        scored.sort(key=lambda j: j.get("match_score", 0.0), reverse=True)
        return scored[:limit]

    def _score_job(
        self,
        job: Dict[str, Any],
        country: Optional[str],
        candidate_skills: List[str],
        experience_years: Optional[int],
    ) -> float:
        skill_score = self._skill_score(job, candidate_skills)
        exp_score = self._experience_score(job, experience_years)
        country_score = self._country_score(job, country)
        return (
            skill_score * self.SKILL_WEIGHT
            + exp_score * self.EXPERIENCE_WEIGHT
            + country_score * self.COUNTRY_WEIGHT
        )

    def _skill_score(self, job: Dict[str, Any], candidate_skills: List[str]) -> float:
        if not candidate_skills:
            return 0.5
        req_text = ""
        req = job.get("requirements")
        if isinstance(req, dict):
            req_text = " ".join(str(v) for v in req.values() if v).lower()
        matches = 0
        for skill in candidate_skills:
            s = (skill or "").strip().lower()
            if s and s in req_text:
                matches += 1
        return min(1.0, matches / max(1, len(candidate_skills)))

    def _experience_score(self, job: Dict[str, Any], experience_years: Optional[int]) -> float:
        if experience_years is None:
            return 0.5
        try:
            experience_value = int(experience_years)
        except Exception:
            experience_value = 0
        req = job.get("requirements") if isinstance(job.get("requirements"), dict) else {}
        min_exp = req.get("experience_years", 0) or 0
        if experience_value >= int(min_exp):
            return 1.0
        if min_exp <= 0:
            return 0.8
        return max(0.0, 1 - ((int(min_exp) - experience_value) / max(1, int(min_exp))))

    def _country_score(self, job: Dict[str, Any], country: Optional[str]) -> float:
        if not country:
            return 0.5
        want = _canon_country(country)
        # Canonicalise the job's countries AND its location (location is a CITY,
        # e.g. "Dubai"), so "Dubai" stated by the candidate matches a UAE job.
        places = {_canon_country(c) for c in (job.get("countries") or [])}
        loc = job.get("location")
        if loc:
            places.add(_canon_country(loc))
        return 1.0 if want in places else 0.0


job_matching_service = JobMatchingService()
