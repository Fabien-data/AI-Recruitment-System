import asyncio
import unittest

from app.config import settings
from app.services.intent_service import classify_message


class IntentServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_flag = settings.enable_ai_classifier
        settings.enable_ai_classifier = False

    @classmethod
    def tearDownClass(cls):
        settings.enable_ai_classifier = cls.original_flag

    def test_gibberish_short(self):
        result = asyncio.run(classify_message(".."))
        self.assertTrue(result.is_gibberish)

    def test_apply_hint(self):
        result = asyncio.run(classify_message("mata job ekak ona"))
        self.assertIn(result.intent, {"apply_job", "ask_question"})

    def test_heuristic_extracts_entities(self):
        result = asyncio.run(classify_message("I am a driver with 3 years experience and want qatar"))
        self.assertEqual(result.job_role, "Driver")
        self.assertEqual(result.country, "Qatar")
        self.assertEqual(result.experience, "3")


if __name__ == "__main__":
    unittest.main()
