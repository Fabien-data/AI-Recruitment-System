import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.core.orchestrator import IntakeOrchestrator
from app.services.intent_service import MessageAnalysis


class DummyDB:
    def commit(self):
        return None


class OrchestratorTests(unittest.TestCase):
    def test_gibberish_increments_confusion(self):
        orch = IntakeOrchestrator()
        candidate = SimpleNamespace(
            id=1,
            agent_state={
                "step": "entry",
                "cv_uploaded": False,
                "collected_data": {},
                "confusion_count": 0,
                "handoff_flag": False,
                "locked_language": None,
            },
            extracted_data={},
            language_preference=SimpleNamespace(value="en"),
            confidence_score=0.0,
            handoff_flag=False,
        )

        with patch("app.core.orchestrator.crud.get_or_create_candidate", return_value=candidate), \
             patch("app.core.orchestrator.classify_message", new=AsyncMock(return_value=MessageAnalysis(intent="gibberish", is_gibberish=True, confidence=0.2))), \
             patch("app.core.orchestrator.chatbot.process_message", new=AsyncMock(return_value="legacy")):
            result = asyncio.run(
                orch.process_text_message(
                    db=DummyDB(),
                    phone_number="94770000000",
                    message_text="....",
                )
            )

        self.assertIn("apply", result.lower())
        self.assertEqual(candidate.agent_state["confusion_count"], 1)

    def test_apply_route_sets_intake_prompt(self):
        orch = IntakeOrchestrator()
        candidate = SimpleNamespace(
            id=1,
            agent_state={},
            extracted_data={},
            language_preference=SimpleNamespace(value="en"),
            confidence_score=0.0,
            handoff_flag=False,
            conversation_state="initial",
        )

        with patch("app.core.orchestrator.crud.get_or_create_candidate", return_value=candidate), \
             patch("app.core.orchestrator.classify_message", new=AsyncMock(return_value=MessageAnalysis(intent="apply_job", is_gibberish=False, confidence=0.9))), \
             patch("app.core.orchestrator.crud.update_candidate_state", return_value=candidate):
            result = asyncio.run(
                orch.process_text_message(
                    db=DummyDB(),
                    phone_number="94770000000",
                    message_text="mata job ekak ona",
                )
            )

        self.assertIn("job role", result.lower())

    def test_apply_route_moves_to_country_when_job_role_known(self):
        orch = IntakeOrchestrator()
        candidate = SimpleNamespace(
            id=1,
            agent_state={"collected_data": {}},
            extracted_data={},
            language_preference=SimpleNamespace(value="en"),
            confidence_score=0.0,
            handoff_flag=False,
            conversation_state="initial",
        )

        with patch("app.core.orchestrator.crud.get_or_create_candidate", return_value=candidate), \
             patch("app.core.orchestrator.classify_message", new=AsyncMock(return_value=MessageAnalysis(intent="apply_job", is_gibberish=False, confidence=0.9, job_role="Driver"))), \
             patch("app.core.orchestrator.crud.update_candidate_state", return_value=candidate):
            result = asyncio.run(
                orch.process_text_message(
                    db=DummyDB(),
                    phone_number="94770000000",
                    message_text="driver job",
                )
            )

        self.assertIn("country", result.lower())

    def test_view_jobs_returns_structured_list_payload(self):
        orch = IntakeOrchestrator()
        candidate = SimpleNamespace(
            id=1,
            phone_number="94770000000",
            agent_state={},
            extracted_data={},
            language_preference=SimpleNamespace(value="en"),
            confidence_score=0.0,
            handoff_flag=False,
        )

        fake_jobs = [{"title": "Security Guard", "countries": ["Qatar"], "category": "Security"}]

        with patch("app.core.orchestrator.crud.get_or_create_candidate", return_value=candidate), \
             patch("app.core.orchestrator.classify_message", new=AsyncMock(return_value=MessageAnalysis(intent="view_jobs", is_gibberish=False, confidence=0.8))), \
             patch("app.core.orchestrator.job_matching_service.get_ranked_matches", new=AsyncMock(return_value=fake_jobs)):
            result = asyncio.run(
                orch.process_text_message(
                    db=DummyDB(),
                    phone_number="94770000000",
                    message_text="show vacancies",
                )
            )

        self.assertIsInstance(result, dict)
        self.assertEqual(result.get("type"), "list")

    def test_question_uses_vacancy_service_refine(self):
        orch = IntakeOrchestrator()
        candidate = SimpleNamespace(
            id=1,
            phone_number="94770000000",
            agent_state={},
            extracted_data={},
            language_preference=SimpleNamespace(value="en"),
            confidence_score=0.0,
            handoff_flag=False,
        )

        with patch("app.core.orchestrator.crud.get_or_create_candidate", return_value=candidate), \
             patch("app.core.orchestrator.classify_message", new=AsyncMock(return_value=MessageAnalysis(intent="ask_question", is_gibberish=False, confidence=0.8))), \
             patch("app.core.orchestrator.vacancy_service.search_and_refine", new=AsyncMock(return_value="Here is your answer")):
            result = asyncio.run(
                orch.process_text_message(
                    db=DummyDB(),
                    phone_number="94770000000",
                    message_text="salary details?",
                )
            )

        self.assertEqual(result, "Here is your answer")

    def test_interactive_job_token_bypasses_classifier(self):
        orch = IntakeOrchestrator()
        candidate = SimpleNamespace(
            id=1,
            phone_number="94770000000",
            agent_state={},
            extracted_data={},
            language_preference=SimpleNamespace(value="en"),
            confidence_score=0.0,
            handoff_flag=False,
            conversation_state="initial",
        )

        with patch("app.core.orchestrator.crud.get_or_create_candidate", return_value=candidate), \
             patch("app.core.orchestrator.classify_message", new=AsyncMock()) as mocked_classifier, \
             patch("app.core.orchestrator.crud.update_candidate_state", return_value=candidate):
            result = asyncio.run(
                orch.process_text_message(
                    db=DummyDB(),
                    phone_number="94770000000",
                    message_text="job_0",
                )
            )

        self.assertIn("experience", result.lower())
        self.assertEqual(mocked_classifier.await_count, 0)

    def test_handoff_trigger_notifies_when_threshold_reached(self):
        orch = IntakeOrchestrator()
        candidate = SimpleNamespace(
            id=1,
            phone_number="94770000000",
            agent_state={"confusion_count": 2, "collected_data": {}, "locked_language": "en"},
            extracted_data={},
            language_preference=SimpleNamespace(value="en"),
            confidence_score=0.0,
            handoff_flag=False,
            conversation_state="initial",
        )

        with patch("app.core.orchestrator.crud.get_or_create_candidate", return_value=candidate), \
             patch("app.core.orchestrator.classify_message", new=AsyncMock(return_value=MessageAnalysis(intent="gibberish", is_gibberish=True, confidence=0.1))), \
             patch("app.core.orchestrator.chatbot._notify_human_handoff", new=AsyncMock(return_value=None)) as mocked_notify, \
             patch("app.core.orchestrator.crud.update_candidate_state", return_value=candidate):
            result = asyncio.run(
                orch.process_text_message(
                    db=DummyDB(),
                    phone_number="94770000000",
                    message_text="....",
                )
            )

        self.assertIn("human", result.lower())
        self.assertTrue(candidate.handoff_flag)
        self.assertTrue(mocked_notify.await_count >= 1)

    def test_media_sets_cv_uploaded_and_delegates(self):
        orch = IntakeOrchestrator()
        candidate = SimpleNamespace(
            id=1,
            phone_number="94770000000",
            agent_state={},
            extracted_data={},
            language_preference=SimpleNamespace(value="en"),
            confidence_score=0.0,
            handoff_flag=False,
        )

        with patch("app.core.orchestrator.crud.get_or_create_candidate", return_value=candidate), \
             patch("app.core.orchestrator.chatbot.process_message", new=AsyncMock(return_value="cv processed")):
            result = asyncio.run(
                orch.process_media_message(
                    db=DummyDB(),
                    phone_number="94770000000",
                    media_content=b"pdf-bytes",
                    media_type="document",
                    media_filename="cv.pdf",
                )
            )

        self.assertEqual(result, "cv processed")
        self.assertTrue(candidate.agent_state.get("cv_uploaded"))


if __name__ == "__main__":
    unittest.main()
