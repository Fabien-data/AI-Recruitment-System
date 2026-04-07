from __future__ import annotations

import asyncio
import logging
import os
import uuid
from typing import Optional

import httpx

from app import crud
from app.config import settings
from app.services.recruitment_sync import recruitment_sync
from app.utils.candidate_validator import run_ai_supervisor
from app.utils.meta_client import meta_client

logger = logging.getLogger(__name__)


async def _download_file(document_url: str) -> Optional[str]:
	if not document_url:
		return None

	os.makedirs(settings.upload_dir, exist_ok=True)
	filename = f"cv_{uuid.uuid4().hex}.pdf"
	file_path = os.path.join(settings.upload_dir, filename)

	try:
		async with httpx.AsyncClient(timeout=20.0) as client:
			response = await client.get(document_url)
			response.raise_for_status()
			with open(file_path, "wb") as handle:
				handle.write(response.content)
		return file_path
	except Exception as exc:
		logger.warning("CV download failed: %s", exc)
		return None


async def handle_document_message(user_phone: str, document_url: str, db_session) -> None:
	await meta_client.send_message(
		user_phone,
		"📄 ඔබේ CV එක ලැබුණා! මම තොරතුරු පරීක්ෂා කරමින් පවතිනවා... "
		"(Received your CV! Extracting details...)",
	)

	cv_path = await _download_file(document_url)
	candidate = crud.get_or_create_candidate(db_session, user_phone)

	if cv_path:
		asyncio.create_task(recruitment_sync.push(candidate, None, cv_path=cv_path))

	await meta_client.send_message(
		user_phone,
		"✅ CV එක පද්ධතියට ඇතුළත් කළා! ඔයාට කොපමණ කාලයක පළපුරුද්දක් තියෙනවද? "
		"(CV Added! How many years of experience do you have?)",
	)


async def handle_text_message(user_phone: str, user_text: str, db_session) -> None:
	candidate = crud.get_or_create_candidate(db_session, user_phone)
	agent_state = candidate.agent_state if isinstance(candidate.agent_state, dict) else {}
	force_applying = bool(agent_state.get("cv_uploaded"))

	ai_decision = await run_ai_supervisor(
		user_text=user_text,
		history=None,
		force_applying=force_applying,
	)

	if ai_decision.extracted_name:
		candidate.name = ai_decision.extracted_name
	if ai_decision.experience_years is not None:
		candidate.experience_years = ai_decision.experience_years
	if ai_decision.job_interest:
		extracted = candidate.extracted_data if isinstance(candidate.extracted_data, dict) else {}
		extracted["job_interest"] = ai_decision.job_interest
		candidate.extracted_data = extracted

	db_session.commit()

	if ai_decision.is_ready_to_sync:
		asyncio.create_task(recruitment_sync.push(candidate, None))

	await meta_client.send_message(user_phone, ai_decision.reply_message)
