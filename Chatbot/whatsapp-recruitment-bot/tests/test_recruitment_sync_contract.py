import unittest
from types import SimpleNamespace

from app.services.recruitment_sync import (
    _generate_idempotency_key,
    _is_retryable_error,
    recruitment_sync,
)


class RecruitmentSyncContractTests(unittest.TestCase):
    def _candidate(self):
        return SimpleNamespace(
            id=123,
            phone_number="94770000000",
            name="Nimal",
            email="nimal@example.com",
            language_preference=SimpleNamespace(value="en"),
            skills=["driving", "safety"],
            experience_years=4,
            highest_qualification="O/L",
            resume_file_path=None,
            is_general_pool=False,
        )

    def test_idempotency_key_is_deterministic(self):
        k1 = _generate_idempotency_key("94770000000", "Driver")
        k2 = _generate_idempotency_key("94770000000", "driver")
        self.assertEqual(k1, k2)

    def test_retryable_error_rules(self):
        self.assertTrue(_is_retryable_error(500))
        self.assertTrue(_is_retryable_error(429))
        self.assertFalse(_is_retryable_error(400))
        self.assertFalse(_is_retryable_error(422))

    def test_build_payload_contract_keys(self):
        candidate = self._candidate()
        extracted = {
            "language_register": "singlish",
            "job_interest": "Driver",
            "destination_country": "Qatar",
            "raw_cv_text": "sample cv text",
            "selected_job_id": "job-1",
        }

        payload = recruitment_sync._build_payload(
            candidate=candidate,
            extracted=extracted,
            cv_filename="cv.pdf",
        )

        required = {
            "phone",
            "name",
            "preferred_language",
            "job_interest",
            "destination_country",
            "cv_parsed_data",
            "chatbot_candidate_id",
        }
        self.assertTrue(required.issubset(set(payload.keys())))
        self.assertEqual(payload["preferred_language"], "singlish")
        self.assertEqual(payload["chatbot_candidate_id"], 123)
        self.assertEqual(payload["job_id"], "job-1")

    def test_resolve_cv_bytes_prefers_direct_bytes(self):
        candidate = self._candidate()
        extracted = {}
        data, name = recruitment_sync._resolve_cv_bytes(
            candidate=candidate,
            extracted=extracted,
            cv_bytes=b"cv-bytes",
            cv_filename="direct.pdf",
        )
        self.assertEqual(data, b"cv-bytes")
        self.assertEqual(name, "direct.pdf")


if __name__ == "__main__":
    unittest.main()
