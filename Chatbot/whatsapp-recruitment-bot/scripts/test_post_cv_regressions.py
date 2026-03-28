"""
Focused regression checks for post-CV conversation flow.

This script validates:
1) Job selection tokens are handled in STATE_AWAITING_JOB_SELECTION.
2) Unclear text in job-selection state re-shows the same list and keeps state.
3) Missing presented cards are rebuilt from stored job + country.
4) Country is not re-asked when already captured.
"""

import sys
import os
import asyncio
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.chatbot import ChatbotEngine, crud, vacancy_service, recruitment_sync


class FakeDB:
    def __init__(self):
        self.candidates = {}

    def commit(self):
        return None

    def rollback(self):
        return None


def _make_candidate(bot: ChatbotEngine, state: str, extracted_data: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        name="Test Candidate",
        conversation_state=state,
        extracted_data=extracted_data,
    )


async def _run():
    bot = ChatbotEngine()
    db = FakeDB()

    original_update_state = crud.update_candidate_state
    original_get_matching_jobs = vacancy_service.get_matching_jobs
    original_push = recruitment_sync.push

    async def _fake_get_matching_jobs(job_interest: str, country: str, limit: int = 3):
        _ = (job_interest, country, limit)
        return [
            {"id": "job-1", "title": "Data Scientist", "country": "Qatar", "salary": "3000"},
            {"id": "job-2", "title": "ML Engineer", "country": "Qatar", "salary": "3500"},
        ]

    async def _fake_push(candidate, db_session, cv_bytes=None, cv_filename=None):
        _ = (candidate, db_session, cv_bytes, cv_filename)
        return True

    def _fake_update_state(db_session, candidate_id, new_state):
        db_session.candidates[candidate_id].conversation_state = new_state

    crud.update_candidate_state = _fake_update_state
    vacancy_service.get_matching_jobs = _fake_get_matching_jobs
    recruitment_sync.push = _fake_push

    try:
        # 1) Token selection should persist selected job and complete flow.
        c1 = _make_candidate(
            bot,
            bot.STATE_AWAITING_JOB_SELECTION,
            {
                "presented_job_cards": [
                    {"id": "job-1", "title": "Data Scientist", "country": "Qatar"},
                    {"id": "job-2", "title": "ML Engineer", "country": "Qatar"},
                ],
                "destination_country": "Qatar",
            },
        )
        db.candidates[c1.id] = c1

        res1 = await bot._route_by_state(
            db=db,
            candidate=c1,
            text="job_0",
            language="en",
            state=c1.conversation_state,
            classified={"intent": "other", "entities": {}, "language": "en", "confidence": 1.0},
        )

        assert isinstance(res1, str), "Expected completion text response for selected job"
        assert c1.extracted_data.get("selected_job_id") == "job-1", "selected_job_id not saved"
        assert c1.conversation_state == bot.STATE_APPLICATION_COMPLETE, "State should move to application_complete"

        # 2) Unclear input should keep state and re-show the list payload.
        c2 = _make_candidate(
            bot,
            bot.STATE_AWAITING_JOB_SELECTION,
            {
                "presented_job_cards": [
                    {"id": "job-1", "title": "Data Scientist", "country": "Qatar"},
                    {"id": "job-2", "title": "ML Engineer", "country": "Qatar"},
                ],
                "destination_country": "Qatar",
            },
        )
        c2.id = 2
        db.candidates[c2.id] = c2

        res2 = await bot._route_by_state(
            db=db,
            candidate=c2,
            text="hmm",
            language="en",
            state=c2.conversation_state,
            classified={"intent": "other", "entities": {}, "language": "en", "confidence": 1.0},
        )

        assert isinstance(res2, dict) and res2.get("type") == "list", "Unclear input should re-show list"
        assert c2.conversation_state == bot.STATE_AWAITING_JOB_SELECTION, "State should remain awaiting_job_selection"

        # 3) Missing cards should rebuild and still return list.
        c3 = _make_candidate(
            bot,
            bot.STATE_AWAITING_JOB_SELECTION,
            {
                "job_interest": "Data Scientist",
                "destination_country": "Qatar",
                "presented_job_cards": [],
            },
        )
        c3.id = 3
        db.candidates[c3.id] = c3

        res3 = await bot._route_by_state(
            db=db,
            candidate=c3,
            text="what next",
            language="en",
            state=c3.conversation_state,
            classified={"intent": "other", "entities": {}, "language": "en", "confidence": 1.0},
        )

        assert isinstance(res3, dict) and res3.get("type") == "list", "Rebuilt cards should produce list payload"
        assert len(c3.extracted_data.get("presented_job_cards") or []) >= 1, "presented_job_cards should be rebuilt"

        # 4) Country should not be re-asked if already captured.
        c4 = _make_candidate(
            bot,
            bot.STATE_AWAITING_COUNTRY,
            {
                "job_interest": "Data Scientist",
                "destination_country": "Qatar",
            },
        )
        c4.id = 4
        db.candidates[c4.id] = c4

        res4 = await bot._route_by_state(
            db=db,
            candidate=c4,
            text="Qatar",
            language="en",
            state=c4.conversation_state,
            classified={"intent": "other", "entities": {}, "language": "en", "confidence": 1.0},
        )

        assert isinstance(res4, dict) and res4.get("type") == "buttons", "Should move forward to experience buttons"
        assert c4.conversation_state == bot.STATE_AWAITING_EXPERIENCE, "Country should not be re-asked"

        print("PASS: post-CV regression checks completed")

    finally:
        crud.update_candidate_state = original_update_state
        vacancy_service.get_matching_jobs = original_get_matching_jobs
        recruitment_sync.push = original_push


if __name__ == "__main__":
    asyncio.run(_run())
