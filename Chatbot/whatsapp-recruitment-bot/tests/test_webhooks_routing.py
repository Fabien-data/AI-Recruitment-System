import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app import webhooks
from app.config import settings


class DummyDB:
    def commit(self):
        return None

    def rollback(self):
        return None


class WebhookRoutingTests(unittest.TestCase):
    def _candidate(self):
        return SimpleNamespace(
            id=1,
            language_preference=SimpleNamespace(value="en"),
            conversation_state="initial",
        )

    def test_text_message_routes_modular_text(self):
        message = {
            "id": "wamid.1",
            "from": "94770000000",
            "type": "text",
            "text": {"body": "show jobs"},
        }

        with patch.object(settings, "enable_modular_orchestrator", True), \
             patch("app.webhooks._is_duplicate", return_value=False), \
             patch("app.webhooks.is_greeting", return_value=(False, None)), \
             patch("app.webhooks.message_router.route_text", new=AsyncMock(return_value="ok-text")) as mocked_route_text, \
             patch("app.webhooks.meta_client.mark_as_read", new=AsyncMock(return_value=True)), \
             patch("app.webhooks.meta_client.send_reaction", new=AsyncMock(return_value={})), \
             patch("app.webhooks.meta_client.send_message", new=AsyncMock(return_value={"messages": [{"id": "out1"}]})), \
             patch("app.webhooks._sync_chat_message", new=AsyncMock(return_value=None)), \
             patch("app.webhooks.crud.get_or_create_candidate", return_value=self._candidate()):
            asyncio.run(webhooks.process_single_message(message, [], DummyDB()))

        self.assertEqual(mocked_route_text.await_count, 1)

    def test_document_message_routes_modular_media(self):
        message = {
            "id": "wamid.2",
            "from": "94770000000",
            "type": "document",
            "document": {"id": "media-1", "filename": "cv.pdf", "mime_type": "application/pdf"},
        }

        with patch.object(settings, "enable_modular_orchestrator", True), \
             patch("app.webhooks._is_duplicate", return_value=False), \
             patch("app.webhooks.message_router.route_media", new=AsyncMock(return_value="ok-media")) as mocked_route_media, \
             patch("app.webhooks.meta_client.mark_as_read", new=AsyncMock(return_value=True)), \
             patch("app.webhooks.meta_client.send_reaction", new=AsyncMock(return_value={})), \
             patch("app.webhooks.meta_client.download_media", new=AsyncMock(return_value=b"pdf-bytes")), \
             patch("app.webhooks.meta_client.send_message", new=AsyncMock(return_value={"messages": [{"id": "out2"}]})), \
             patch("app.webhooks._sync_chat_message", new=AsyncMock(return_value=None)), \
             patch("app.webhooks.crud.get_or_create_candidate", return_value=self._candidate()):
            asyncio.run(webhooks.process_single_message(message, [], DummyDB()))

        self.assertEqual(mocked_route_media.await_count, 1)

    def test_interactive_button_routes_action_token(self):
        message = {
            "id": "wamid.3",
            "from": "94770000000",
            "type": "interactive",
            "interactive": {
                "type": "button_reply",
                "button_reply": {"id": "action_apply", "title": "Apply"},
            },
        }

        with patch.object(settings, "enable_modular_orchestrator", True), \
             patch("app.webhooks._is_duplicate", return_value=False), \
             patch("app.webhooks.message_router.route_text", new=AsyncMock(return_value="ok-action")) as mocked_route_text, \
             patch("app.webhooks.meta_client.mark_as_read", new=AsyncMock(return_value=True)), \
             patch("app.webhooks.meta_client.send_reaction", new=AsyncMock(return_value={})), \
             patch("app.webhooks.meta_client.send_message", new=AsyncMock(return_value={"messages": [{"id": "out3"}]})), \
             patch("app.webhooks._sync_chat_message", new=AsyncMock(return_value=None)), \
             patch("app.webhooks.crud.get_or_create_candidate", return_value=self._candidate()):
            asyncio.run(webhooks.process_single_message(message, [], DummyDB()))

        self.assertEqual(mocked_route_text.await_count, 1)


if __name__ == "__main__":
    unittest.main()
