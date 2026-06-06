"""CV processing service for modular intake pipeline."""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, Optional

from app.cv_parser.document_processor import get_document_processor

logger = logging.getLogger(__name__)


class CVService:
    """Extract structured candidate data from uploaded CV/image content."""

    # Maps city/alias → canonical country name.
    # Covers the most common Gulf + Asian destinations for Sri Lankan workers.
    _COUNTRY_ALIASES: Dict[str, str] = {
        # UAE
        "uae": "UAE", "dubai": "UAE", "abu dhabi": "UAE", "abudhabi": "UAE",
        "sharjah": "UAE", "ajman": "UAE", "ras al khaimah": "UAE",
        "fujairah": "UAE", "umm al quwain": "UAE",
        # Qatar
        "qatar": "Qatar", "doha": "Qatar",
        # Saudi Arabia
        "saudi": "Saudi Arabia", "saudi arabia": "Saudi Arabia",
        "ksa": "Saudi Arabia", "riyadh": "Saudi Arabia", "jeddah": "Saudi Arabia",
        "mecca": "Saudi Arabia", "medina": "Saudi Arabia", "khobar": "Saudi Arabia",
        "dammam": "Saudi Arabia",
        # Kuwait
        "kuwait": "Kuwait", "kuwait city": "Kuwait",
        # Oman
        "oman": "Oman", "muscat": "Oman", "salalah": "Oman", "sohar": "Oman",
        # Bahrain
        "bahrain": "Bahrain", "manama": "Bahrain",
        # Malaysia
        "malaysia": "Malaysia", "kuala lumpur": "Malaysia", "kl": "Malaysia",
        "johor": "Malaysia", "penang": "Malaysia",
        # South Korea
        "south korea": "South Korea", "korea": "South Korea", "seoul": "South Korea",
        # Other
        "singapore": "Singapore", "japan": "Japan", "tokyo": "Japan",
        "maldives": "Maldives", "male": "Maldives",
    }

    async def process_cv(
        self,
        file_content: bytes,
        filename: str,
        media_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not file_content:
            return {}

        def _run() -> Dict[str, Any]:
            processor = get_document_processor()
            result = processor.process_document(
                file_content=file_content,
                filename=filename,
                use_intelligent_extraction=True,
                use_openai_ocr=True,
                expected_language="en",
                image_url=media_url,
            )
            if not result or not result.success:
                if getattr(result, "error_message", None) == "not_cv_image":
                    return {"_not_cv_image": True}
                logger.warning("CV extraction failed for %s: %s", filename, getattr(result, "error_message", "unknown"))
                return {}

            out: Dict[str, Any] = {}
            extracted = result.extracted_data
            if extracted:
                name = getattr(extracted, "full_name", None)
                if name:
                    out["name"] = name

                role = getattr(extracted, "current_job_title", None)
                if role:
                    out["job_role"] = role
                elif getattr(extracted, "suggested_roles", None):
                    roles = getattr(extracted, "suggested_roles") or []
                    if roles:
                        out["job_role"] = str(roles[0])

                exp = getattr(extracted, "total_experience_years", None)
                if exp is not None:
                    try:
                        out["experience_years"] = int(float(exp))
                    except Exception:
                        pass

                skills = []
                tech = getattr(extracted, "technical_skills", None) or []
                soft = getattr(extracted, "soft_skills", None) or []
                skills.extend([str(s).strip() for s in tech if str(s).strip()])
                skills.extend([str(s).strip() for s in soft if str(s).strip()])
                if skills:
                    # Preserve order while deduplicating
                    seen = set()
                    deduped = []
                    for s in skills:
                        key = s.lower()
                        if key in seen:
                            continue
                        seen.add(key)
                        deduped.append(s)
                    out["skills"] = deduped[:20]

                # Country: prefer explicit nationality, else infer from text.
                raw_text = (getattr(extracted, "raw_text", None) or "").lower()
                country = self._extract_country_from_text(raw_text)
                if not country and getattr(extracted, "nationality", None):
                    country = self._extract_country_from_text(str(extracted.nationality).lower()) or None
                if country:
                    out["country"] = country

                # Demographics + profile fields that previously got dropped —
                # these now flow into candidate.metadata + CV Manager.
                age = getattr(extracted, "age", None)
                if age is not None:
                    try:
                        out["age"] = int(float(age))
                    except Exception:
                        pass
                height = getattr(extracted, "height_cm", None)
                if height is not None:
                    try:
                        out["height_cm"] = int(float(height))
                    except Exception:
                        pass
                if getattr(extracted, "email", None):
                    out["email"] = extracted.email
                if getattr(extracted, "highest_qualification", None):
                    out["highest_qualification"] = extracted.highest_qualification

                # Previous employer: current company, else most recent work-history company.
                prev_emp = getattr(extracted, "current_company", None)
                if not prev_emp:
                    wh = getattr(extracted, "work_history", None) or []
                    if wh and isinstance(wh[0], dict):
                        prev_emp = wh[0].get("company")
                if prev_emp:
                    out["previous_employer"] = str(prev_emp)

                # Licenses: collapse certifications into a readable string.
                certs = getattr(extracted, "certifications", None) or []
                certs = [str(c).strip() for c in certs if str(c).strip()]
                if certs:
                    out["licenses"] = ", ".join(certs[:10])

                # Full structured blob → stored verbatim in cv_files.parsed_data
                # so the CV Manager can show the complete AI extraction.
                try:
                    out["cv_parsed_data"] = extracted.to_dict()
                except Exception:
                    pass

            # Tag the document category so the backend stores it on the cv_files
            # row (parsed_data.__document_category) → recruiter sees CV vs
            # ID/passport/certificate/photo in CV Manager + conversations. The
            # orchestrator also uses it to decide whether this counts as a real CV.
            doc_category = getattr(result, "document_category", "cv") or "cv"
            out["_document_category"] = doc_category
            cv_blob = out.get("cv_parsed_data")
            if not isinstance(cv_blob, dict):
                cv_blob = {}
            cv_blob["__document_category"] = doc_category
            out["cv_parsed_data"] = cv_blob

            # Pass extraction confidence so orchestrator can gate on low-quality results
            if result.extraction_confidence is not None:
                out["_extraction_confidence"] = result.extraction_confidence

            return out

        return await asyncio.to_thread(_run)

    def _extract_country_from_text(self, text: str) -> Optional[str]:
        if not text:
            return None
        text_lower = text.lower()
        for alias, canonical in self._COUNTRY_ALIASES.items():
            if re.search(r"\b" + re.escape(alias) + r"\b", text_lower):
                return canonical
        return None


cv_service = CVService()
