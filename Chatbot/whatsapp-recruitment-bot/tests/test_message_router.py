import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.core.message_router import message_router


class DummyDB:
    pass


class MessageRouterTests(unittest.TestCase):
    def test_route_text_delegates_to_orchestrator(self):
        with patch("app.core.message_router.intake_orchestrator.process_text_message", new=AsyncMock(return_value="ok")) as mocked:
            result = asyncio.run(
                message_router.route_text(
                    db=DummyDB(),
                    phone_number="94770000000",
                    text="hello",
                )
            )

        self.assertEqual(result, "ok")
        self.assertEqual(mocked.await_count, 1)

    def test_route_media_delegates_to_orchestrator(self):
        with patch("app.core.message_router.intake_orchestrator.process_media_message", new=AsyncMock(return_value="media-ok")) as mocked:
            result = asyncio.run(
                message_router.route_media(
                    db=DummyDB(),
                    phone_number="94770000000",
                    media_content=b"bytes",
                    media_type="document",
                    media_filename="cv.pdf",
                )
            )

        self.assertEqual(result, "media-ok")
        self.assertEqual(mocked.await_count, 1)


if __name__ == "__main__":
    unittest.main()
