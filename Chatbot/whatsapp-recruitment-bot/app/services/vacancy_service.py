"""
Vacancy Service
===============
Handles all job/vacancy queries for the chatbot.

Pipeline:
  1. Search job_cache (in-memory, hydrated from recruitment system on startup)
  2. If cache empty → try REST API → try PostgreSQL direct read
  3. Pass raw DB rows + user message through GPT-4o for natural language refinement
  4. Return polished, language-correct response

Supports English, Sinhala, Tamil, Tanglish (Tamil+English), Singlish (Sinhala+English).
"""

import asyncio
import logging
import os
import json
import re
from typing import Optional, Dict, Any, List

import httpx

from app.config import settings
from app.knowledge import get_job_cache, refresh_job_cache
from app.llm.prompt_templates import PromptTemplates

logger = logging.getLogger(__name__)

# ── PostgreSQL direct fallback ────────────────────────────────────────────────
RECRUITMENT_DB_URL = os.getenv("RECRUITMENT_DB_URL", "")

try:
    import psycopg2
    import psycopg2.extras
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False
    logger.info("psycopg2 not installed — PostgreSQL direct fallback disabled")


class VacancyService:
    """
    Searches vacancies and produces LLM-refined, human-like responses.
    """

    # ── Language name map ─────────────────────────────────────────────────────
    LANG_NAMES = {
        'en': 'English',
        'si': 'Sinhala (සිංහල)',
        'ta': 'Tamil (தமிழ்)',
        'tanglish': 'Tanglish (Tamil–English mix)',
        'singlish': 'Singlish (Sinhala–English mix)',
    }

    # ─────────────────────────────────────────────────────────────────────────
    # Main entry point
    # ─────────────────────────────────────────────────────────────────────────

    async def search_and_refine(
        self,
        user_message: str,
        entities: Optional[Dict[str, Any]] = None,
        language: str = 'en',
        candidate_info: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Full pipeline: search → LLM refine → return response string.

        Args:
            user_message: The original message from the user (any language/script).
            entities:     Extracted entities from classify_message() — job_roles,
                          countries, skills, experience_years.
            language:     Detected language code (en / si / ta / tanglish / singlish).
            candidate_info: Optional dict with candidate's stored profile.

        Returns:
            A polished, language-correct response string.
        """
        entities = entities or {}

        # ── Step 1: Get jobs from fastest available source ────────────────────
        raw_jobs = await self._fetch_jobs(entities)

        # ── Step 2: Filter/rank by entities if we have candidates ─────────────
        if raw_jobs:
            raw_jobs = self._rank_jobs(raw_jobs, entities)

        # ── Step 3: LLM refinement → human-like response ──────────────────────
        return await self._refine_with_llm(
            raw_jobs=raw_jobs,
            user_message=user_message,
            entities=entities,
            language=language,
            candidate_info=candidate_info,
        )

    async def get_ranked_jobs(
        self,
        entities: Optional[Dict[str, Any]] = None,
        limit: int = 3,
    ) -> List[Dict[str, Any]]:
        """
        Return top ranked active jobs for deterministic selection flows.
        This bypasses LLM formatting and returns structured rows.
        """
        entities = entities or {}
        raw_jobs = await self._fetch_jobs(entities)
        if raw_jobs:
            raw_jobs = self._rank_jobs(raw_jobs, entities)
        return raw_jobs[: max(1, min(limit, 10))]

    async def get_matching_jobs(
        self,
        job_interest: str,
        country: str,
        limit: int = 3,
        candidate_skills: Optional[List[str]] = None,
        experience_years: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """
        Compatibility helper for state-machine selection flow.
        Returns a lightweight list of dicts with id/title/salary/description/country.
        Uses candidate CV data for smarter skill-based ranking.
        """
        entities = {
            "job_roles": [job_interest] if job_interest else [],
            "countries": [] if country == 'ANY' else ([country] if country else []),
            "skills": candidate_skills or [],
            "experience_years": experience_years,
        }
        ranked = await self.get_ranked_jobs(entities=entities, limit=limit)

        # Secondary re-rank using CV skills if provided
        if candidate_skills and ranked:
            ranked = self._cv_rerank_jobs(ranked, candidate_skills, experience_years)
            ranked = ranked[:limit]

        out: List[Dict[str, Any]] = []
        for job in ranked:
            requirements = job.get("requirements") if isinstance(job.get("requirements"), dict) else {}
            countries = [str(c) for c in (job.get("countries") or [])]

            # Build rich description — never show "TBD"
            desc_parts = []
            if job.get("salary_range"):
                desc_parts.append(str(job["salary_range"]))
            if requirements.get("experience_years"):
                desc_parts.append(f"{requirements['experience_years']}+ yrs exp")
            if job.get("location"):
                desc_parts.append(str(job["location"]))
            if not desc_parts and job.get("description"):
                desc_parts.append(str(job["description"])[:80])
            rich_desc = " · ".join(desc_parts) if desc_parts else "Enquire for details"

            out.append({
                "id": str(job.get("job_id") or ""),
                "title": str(job.get("title") or "").strip(),
                "salary": str(job.get("salary_range") or "").strip() or "",
                "salary_range": str(job.get("salary_range") or "").strip() or "",
                "description": rich_desc[:120],
                "country": countries[0] if countries else country,
                "location": str(job.get("location") or ""),
                "requirements": requirements,
            })
        return out

    def _cv_rerank_jobs(
        self,
        jobs: List[Dict[str, Any]],
        candidate_skills: List[str],
        experience_years: Optional[int],
    ) -> List[Dict[str, Any]]:
        """Re-rank jobs using candidate CV skills and experience."""
        skill_set = {s.lower().strip() for s in candidate_skills if s}

        def _score(job: Dict[str, Any]) -> int:
            score = 0
            reqs = job.get("requirements") or {}
            if isinstance(reqs, dict):
                # Match skills in requirements fields
                req_text = " ".join([
                    str(reqs.get("summary", "")),
                    str(reqs.get("skills", "")),
                    str(reqs.get("description", "")),
                ]).lower()
                for skill in skill_set:
                    if skill in req_text:
                        score += 4
                # Experience match
                if experience_years is not None:
                    min_exp = reqs.get("experience_years", 0) or 0
                    if experience_years >= min_exp:
                        score += 3
                    elif experience_years >= min_exp - 1:
                        score += 1
            return score

        scored = sorted(jobs, key=_score, reverse=True)
        return scored

    # ─────────────────────────────────────────────────────────────────────────
    # Job fetching (3-layer: cache → REST API → PostgreSQL)
    # ─────────────────────────────────────────────────────────────────────────

    async def _fetch_jobs(self, entities: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Try cache, then REST API, then direct PostgreSQL. Returns raw job list."""

        # ── Layer 1: in-memory job cache (fastest) ────────────────────────────
        cache = get_job_cache()
        active_from_cache = [j for j in cache.values() if j.get("status") == "active"]

        if active_from_cache:
            logger.debug(f"VacancyService: using {len(active_from_cache)} jobs from cache")
            return active_from_cache

        # Cache miss — try to refresh before going to heavier layers
        try:
            loaded = await refresh_job_cache()
            if loaded > 0:
                cache = get_job_cache()
                active_from_cache = [j for j in cache.values() if j.get("status") == "active"]
                if active_from_cache:
                    logger.info(f"VacancyService: refreshed cache, got {len(active_from_cache)} jobs")
                    return active_from_cache
        except Exception as e:
            logger.warning(f"VacancyService: cache refresh failed: {e}")

        # ── Layer 2: REST API ─────────────────────────────────────────────────
        rest_jobs = await self._fetch_from_rest_api(entities)
        if rest_jobs:
            return rest_jobs

        # ── Layer 3: Direct PostgreSQL ────────────────────────────────────────
        if PSYCOPG2_AVAILABLE and RECRUITMENT_DB_URL:
            pg_jobs = self._fetch_from_postgres(entities)
            if pg_jobs:
                return pg_jobs

        logger.warning("VacancyService: all layers exhausted — no jobs found")
        return []

    async def _fetch_from_rest_api(self, entities: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Fetch active jobs from the recruitment system REST API."""
        recruitment_url = settings.recruitment_api_url or "http://localhost:3000"
        api_key = settings.chatbot_api_key or ""

        if not api_key:
            logger.debug("VacancyService REST: no API key configured")
            return []

        try:
            params: Dict[str, str] = {"status": "active"}

            # Pass keyword filters if entities are available
            job_roles = entities.get("job_roles", [])
            countries = entities.get("countries", [])
            if job_roles:
                params["search"] = " ".join(job_roles[:3])
            if countries:
                params["country"] = countries[0]

            async with httpx.AsyncClient(timeout=8.0) as client:
                response = await client.get(
                    f"{recruitment_url}/api/chatbot/jobs",
                    params=params,
                    headers={"x-chatbot-api-key": api_key},
                )

            if response.status_code == 200:
                data = response.json()
                jobs = data.get("jobs", [])
                logger.info(f"VacancyService REST: received {len(jobs)} jobs")
                return self._normalize_rest_jobs(jobs)

            logger.warning(
                f"VacancyService REST: unexpected status {response.status_code}"
            )
            return []

        except httpx.ConnectError:
            logger.warning(
                f"VacancyService REST: cannot connect to {recruitment_url}"
            )
            return []
        except Exception as e:
            logger.error(f"VacancyService REST: error: {e}")
            return []

    def _normalize_rest_jobs(self, jobs: List[Dict]) -> List[Dict[str, Any]]:
        """Normalise REST API job records to the internal format."""
        result = []
        for job in jobs:
            raw_req = job.get("requirements")
            if isinstance(raw_req, str):
                try:
                    requirements = json.loads(raw_req) if raw_req else {}
                except Exception:
                    requirements = {}
            else:
                requirements = raw_req if isinstance(raw_req, dict) else {}

            result.append({
                "job_id": str(job.get("job_id") or job.get("id") or ""),
                "title": job.get("title", ""),
                "category": job.get("category", ""),
                "status": job.get("status", "active"),
                "requirements": requirements,
                "salary_range": job.get("salary_range"),
                "countries": job.get("countries") or [],
                "project_name": job.get("project_name", ""),
                "deadline": job.get("deadline", ""),
            })
        return result

    def _fetch_from_postgres(self, entities: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Direct PostgreSQL query — used when REST API is unavailable."""
        try:
            conn = psycopg2.connect(RECRUITMENT_DB_URL)
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

            job_roles = entities.get("job_roles", [])
            countries = entities.get("countries", [])

            if job_roles:
                like_clauses = " OR ".join(
                    ["j.title ILIKE %s"] * len(job_roles)
                )
                params = [f"%{r}%" for r in job_roles]
                if countries:
                    like_clauses += " OR " + " OR ".join(
                        ["p.countries::text ILIKE %s"] * len(countries)
                    )
                    params += [f"%{c}%" for c in countries]
                query = f"""
                    SELECT j.id AS job_id, j.title, j.category, j.status,
                           j.requirements, j.salary_range,
                           p.countries, p.name AS project_name
                    FROM jobs j
                    LEFT JOIN projects p ON p.id = j.project_id
                    WHERE j.status = 'active'
                      AND ({like_clauses})
                    ORDER BY j.created_at DESC
                    LIMIT 15
                """
                cur.execute(query, params)
            else:
                cur.execute("""
                    SELECT j.id AS job_id, j.title, j.category, j.status,
                           j.requirements, j.salary_range,
                           p.countries, p.name AS project_name
                    FROM jobs j
                    LEFT JOIN projects p ON p.id = j.project_id
                    WHERE j.status = 'active'
                    ORDER BY j.created_at DESC
                    LIMIT 15
                """)

            rows = cur.fetchall()
            cur.close()
            conn.close()

            result = []
            for row in rows:
                r = dict(row)
                # Unpack JSONB/text requirements
                req = r.get("requirements") or {}
                if isinstance(req, str):
                    try:
                        req = json.loads(req)
                    except Exception:
                        req = {}
                r["requirements"] = req

                # Unpack countries JSONB
                ctrs = r.get("countries") or []
                if isinstance(ctrs, str):
                    try:
                        ctrs = json.loads(ctrs)
                    except Exception:
                        ctrs = []
                r["countries"] = ctrs

                result.append(r)

            logger.info(f"VacancyService PostgreSQL: fetched {len(result)} jobs")
            return result

        except Exception as e:
            logger.error(f"VacancyService PostgreSQL: error: {e}")
            return []

    # ─────────────────────────────────────────────────────────────────────────
    # Ranking / filtering
    # ─────────────────────────────────────────────────────────────────────────

    def _rank_jobs(
        self, jobs: List[Dict[str, Any]], entities: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        Score and sort jobs by relevance to extracted entities.
        Uses country alias normalization and fuzzy/partial word matching for roles.
        Higher score = more relevant.
        """
        # ── Country alias normalization map ───────────────────────────────────
        _COUNTRY_ALIAS: Dict[str, str] = {
            "dubai": "uae", "abu dhabi": "uae", "sharjah": "uae", "ajman": "uae",
            "saudi": "saudi arabia", "ksa": "saudi arabia", "riyadh": "saudi arabia",
            "jeddah": "saudi arabia", "mecca": "saudi arabia", "medina": "saudi arabia",
            "doha": "qatar", "qatar": "qatar",
            "muscat": "oman", "oman": "oman",
            "kuwait": "kuwait",
            "bahrain": "bahrain", "manama": "bahrain",
            "malaysia": "malaysia", "kl": "malaysia", "kuala lumpur": "malaysia",
            "singapore": "singapore",
            "maldives": "maldives", "male": "maldives",
            "jordan": "jordan", "amman": "jordan",
            "middle east": "middle east", "gulf": "middle east",
        }

        # ── Job role synonym groups for fuzzy scoring ─────────────────────────
        _ROLE_SYNONYMS: Dict[str, List[str]] = {
            "driver":          ["driver", "drv", "riyaduru", "ஓட்டுநர்", "riyeaduru", "vehicle"],
            "security guard":  ["security", "guard", "sec", "watchman"],
            "nurse":           ["nurse", "hediya", "நர்ஸ்", "nursing", "caregiver"],
            "cook":            ["cook", "chef", "cooking", "kitchen", "sammale"],
            "cleaner":         ["cleaner", "cleaning", "janitor", "housekeeping"],
            "factory worker":  ["factory", "production", "manufacturing", "assembly"],
            "welder":          ["welder", "welding", "weld"],
            "electrician":     ["electrician", "electric", "electrical"],
            "carpenter":       ["carpenter", "joinery", "woodwork"],
            "plumber":         ["plumber", "plumbing", "pipe"],
            "mason":           ["mason", "masonry", "bricklayer"],
            "helper":          ["helper", "general worker", "labour", "laborer"],
            "housemaid":       ["housemaid", "domestic", "maid", "servant"],
        }

        def _normalize_country(c: str) -> str:
            """Map country variations to canonical form."""
            return _COUNTRY_ALIAS.get(c.lower().strip(), c.lower().strip())

        def _fuzzy_role_score(query_role: str, job_title: str, job_category: str) -> int:
            """Return a fuzzy match score for a job role query against a job."""
            s = 0
            q = query_role.lower()
            title = job_title.lower()
            cat   = job_category.lower()

            # Exact substring match in title — highest reward
            if q in title:
                return 10
            if q in cat:
                return 5

            # Check synonym groups
            for canonical, synonyms in _ROLE_SYNONYMS.items():
                if q == canonical or q in synonyms:
                    # Query matches this synonym group — check if any synonym is in title
                    for syn in synonyms:
                        if syn in title:
                            return 8
                        if syn in cat:
                            s = max(s, 4)
                    break

            # Word-level overlap as last fallback
            q_words = set(q.split())
            t_words = set(title.split())
            overlap = len(q_words & t_words)
            if overlap > 0:
                s = max(s, overlap * 2)

            return s

        job_roles = [r.lower() for r in entities.get("job_roles", [])]
        countries = [_normalize_country(c) for c in entities.get("countries", [])]
        skills    = [s.lower() for s in entities.get("skills", [])]

        if not (job_roles or countries or skills):
            return jobs[:15]

        def score(job: Dict) -> int:
            s = 0
            title = (job.get("title") or "").lower()
            cats  = (job.get("category") or "").lower()
            job_countries_raw = [str(c) for c in (job.get("countries") or [])]
            job_countries     = [_normalize_country(c) for c in job_countries_raw]
            job_req_text      = json.dumps(job.get("requirements") or {}).lower()

            for role in job_roles:
                s += _fuzzy_role_score(role, title, cats)

            for country in countries:
                if any(country in c or c in country for c in job_countries):
                    s += 8

            for skill in skills:
                if skill in job_req_text or skill in title:
                    s += 3

            return s

        scored = sorted(jobs, key=score, reverse=True)
        # Filter out zeroes only when there are high-scoring results
        nonzero = [j for j in scored if score(j) > 0]
        return (nonzero[:15] if nonzero else scored[:15])

    def get_active_countries(self) -> list:
        """Return deduplicated sorted list of countries with active vacancies."""
        cache = get_job_cache()
        seen = set()
        result = []
        for job in cache.values():
            if job.get("status") != "active":
                continue
            for c in (job.get("countries") or []):
                val = str(c).strip()
                if val and val.lower() not in seen:
                    seen.add(val.lower())
                    result.append(val)
        return sorted(result)

    def get_active_job_titles(self) -> list:
        """Return deduplicated sorted list of job titles with active vacancies."""
        cache = get_job_cache()
        seen = set()
        result = []
        for job in cache.values():
            if job.get("status") != "active":
                continue
            title = str(job.get("title") or "").strip()
            if title and title.lower() not in seen:
                seen.add(title.lower())
                result.append(title)
        return sorted(result)


    # ─────────────────────────────────────────────────────────────────────────
    # LLM response refinement
    # ─────────────────────────────────────────────────────────────────────────

    async def _refine_with_llm(
        self,
        raw_jobs: List[Dict[str, Any]],
        user_message: str,
        entities: Dict[str, Any],
        language: str,
        candidate_info: Optional[Dict[str, Any]],
    ) -> str:
        """
        Pass raw DB rows through GPT-4o to produce a natural, personalised,
        language-correct WhatsApp message.
        """
        # Lazy import to avoid circular dependency
        try:
            from app.llm.rag_engine import rag_engine
            if not rag_engine.openai_client:
                return self._template_response(raw_jobs, language)
        except Exception:
            return self._template_response(raw_jobs, language)

        lang_name = self.LANG_NAMES.get(language, 'English')
        company = settings.company_name or "Dewan Consultants"

        candidate_name = ""
        if candidate_info:
            candidate_name = (candidate_info.get("name") or "").strip().split()[0] if candidate_info.get("name") else ""

        name_part = f"The candidate's first name is {candidate_name}. " if candidate_name else ""

        cv_context = ""
        if candidate_info:
            exp = candidate_info.get("experience_years")
            skills = candidate_info.get("skills")
            extracted = candidate_info.get("extracted_data") or {}
            job_interest = extracted.get("job_interest")
            
            c_parts = []
            if job_interest: c_parts.append(f"Interested in: {job_interest}")
            if exp: c_parts.append(f"Experience: {exp} years")
            if skills: c_parts.append(f"Skills: {skills}")
            
            if c_parts:
                cv_context = "Candidate Profile:\n- " + "\n- ".join(c_parts) + "\n"

        # Build a compact job summary for the prompt (avoid token overuse)
        if raw_jobs:
            job_summary_lines = []
            seen_titles = set()
            for j in raw_jobs[:10]:
                title = (j.get("title") or "").strip()
                if not title or title in seen_titles:
                    continue
                seen_titles.add(title)
                parts = [title]
                countries = j.get("countries") or []
                if countries:
                    parts.append(f"Country: {', '.join(str(c) for c in countries[:2])}")
                sal = j.get("salary_range")
                if sal:
                    parts.append(f"Salary: {sal}")
                req = j.get("requirements") or {}
                exp = req.get("experience_years") or req.get("min_experience")
                if exp:
                    parts.append(f"Min experience: {exp} yrs")
                job_summary_lines.append(" | ".join(parts))

            jobs_data_str = "\n".join(f"- {line}" for line in job_summary_lines)
            has_jobs = True
        else:
            jobs_data_str = "(No matching jobs found in the system right now)"
            has_jobs = False

        entities_str = ""
        if entities:
            parts = []
            if entities.get("job_roles"):
                parts.append(f"job roles: {', '.join(entities['job_roles'])}")
            if entities.get("countries"):
                parts.append(f"countries: {', '.join(entities['countries'])}")
            if entities.get("skills"):
                parts.append(f"skills: {', '.join(entities['skills'])}")
            if parts:
                entities_str = f"Entities extracted from their message: {'; '.join(parts)}."

        prompt = f"""You are Dilan — the warm, professional recruitment receptionist at {company}.
{name_part}
{cv_context}
The candidate sent this message (in {lang_name}): "{user_message}"
{entities_str}

Here are the matching jobs from our database:
{jobs_data_str}

TASK: Write a friendly, conversational WhatsApp reply in {lang_name}.
- If you have jobs to show: list them clearly (title, country, salary if available), then ask which one interests them.
- If NO jobs found: apologise warmly, mention common roles we recruit for (Security, Driver, Cook, Factory Worker, Cleaner, Hospitality, Construction) and invite them to share their preferred role.
- Keep it SHORT — this is WhatsApp (max 5-7 lines).
- NEVER list more than 8 jobs — pick the most relevant ones if there are more.
- End with an engaging question to keep the conversation going.
- Use the candidate's first name naturally if you know it.
- If a job has a deadline within 30 days, prefix the title with "?? URGENT". If it has very high placement demand (security/driver/cook), prefix with "? HIGH DEMAND".

CRITICAL LANGUAGE RULES:
- Reply ENTIRELY in {lang_name}.
- If language is "Tanglish": reply in a natural Tamil–English code-switch style (like how Sri Lankan Tamils text).
  Example: "Anna, {company}ல இப்போ இந்த jobs available — Driver position Dubai la, Cook position Qatar la. எது பிடிக்கும்?"
- If language is "Singlish": reply in a natural Sinhala–English code-switch style (like how Sri Lankans text).
  Example: "Machan, {company} ekata meka tiyenawa — Dubai Driver job, Qatar Cook position. Kohomada?"
- If language is "Sinhala (සිංහල)": pure Sinhala Unicode script only.
- If language is "Tamil (தமிழ்)": pure Tamil Unicode script only.
- If language is "English": English only.
"""

        try:
            response = await asyncio.to_thread(
                rag_engine.openai_client.chat.completions.create,
                model=rag_engine.chat_model,
                messages=[{"role": "user", "content": prompt}],
            )
            llm_text = response.choices[0].message.content.strip()
            footer = PromptTemplates.get_vacancy_push_footer(language)
            return f"{llm_text}\n\n{footer}"

        except Exception as e:
            logger.error(f"VacancyService LLM refinement failed: {e}")
            return self._template_response(raw_jobs, language)

    # ─────────────────────────────────────────────────────────────────────────
    # Template fallback (no LLM)
    # ─────────────────────────────────────────────────────────────────────────

    def _template_response(self, raw_jobs: List[Dict[str, Any]], language: str) -> str:
        """Construct a plain formatted vacancy list without LLM."""
        if not raw_jobs:
            msgs = {
                'en': (
                    "I don't have the current openings loaded right now, but we actively recruit for "
                    "roles in Security, Construction, Hospitality, Driving, and Manufacturing. "
                    "Tell me which role interests you and I'll help you apply! 😊"
                ),
                'si': (
                    "දැනට රැකියා ලැයිස්තුව සම්පූර්ණයෙන් නැත, නමුත් Security, Construction, "
                    "Hospitality, Driving, Manufacturing ඇතුළු බොහෝ රැකියා ඇත. "
                    "කුමන රැකියාවක් ගැන කැමතිද? 😊"
                ),
                'ta': (
                    "இப்போது முழு பட்டியல் இல்லை, ஆனால் Security, Construction, "
                    "Hospitality, Driver, Manufacturing போன்ற பல்வேறு வேலைகள் உள்ளன. "
                    "எந்த வேலையில் ஆர்வம்? சொல்லுங்கள்! 😊"
                ),
                'singlish': (
                    "Danna vacancy list eka load wela naha machan, ewa Security, Construction, "
                    "Hospitality, Driver, Manufacturing wage godak jobs tiyenawa. "
                    "Mokak wageda oya interested? Kiyanna! 😊"
                ),
                'tanglish': (
                    "Ippo full vacancy list load aagala da, aana Security, Construction, "
                    "Hospitality, Driver, Manufacturing maathiri jobs irukku. "
                    "Enna job-la interested? Sollunga! 😊"
                ),
            }
            return msgs.get(language, msgs['en'])

        lines = []
        seen = set()
        for j in raw_jobs[:10]:
            title = (j.get("title") or "").strip()
            if not title or title in seen:
                continue
            seen.add(title)
            sal = j.get("salary_range")
            sal_str = f" | 💰 {sal}" if sal else ""
            lines.append(f"• {title}{sal_str}")

        body = "\n".join(lines)
        intros = {
            'en': f"Here are our current openings:\n\n{body}\n\nWhich one interests you? 🙋",
            'si': f"දැනට ඇති රැකියා:\n\n{body}\n\nකුමක් ගැන කැමතිද? 🙋",
            'ta': f"தற்போதைய வேலை வாய்ப்புகள்:\n\n{body}\n\nஎது பிடிக்கும்? 🙋",
            'singlish': f"Danna tiyena jobs tika mehema machan:\n\n{body}\n\nMokak hari kamathida? 🙋",
            'tanglish': f"Ippo irukura jobs inga parunga da:\n\n{body}\n\nEdhu pudikkum? 🙋",
        }
        footer = PromptTemplates.get_vacancy_push_footer(language)
        return intros.get(language, intros['en']) + "\n\n" + footer


# Singleton
vacancy_service = VacancyService()
