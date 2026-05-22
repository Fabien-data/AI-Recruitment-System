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

                raw_text = (getattr(extracted, "raw_text", None) or "").lower()
                country = self._extract_country_from_text(raw_text)
                if country:
                    out["country"] = country

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
