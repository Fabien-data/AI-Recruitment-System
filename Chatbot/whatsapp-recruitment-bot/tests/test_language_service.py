import unittest

from app.services.language_service import language_service


class LanguageServiceTests(unittest.TestCase):
    def test_keeps_lock_when_no_explicit_switch(self):
        lang = language_service.resolve_language("mokakda vacancy", "si")
        self.assertEqual(lang, "si")

    def test_detects_explicit_switch(self):
        lang = language_service.resolve_language("please speak in english", "si")
        self.assertEqual(lang, "en")


if __name__ == "__main__":
    unittest.main()
