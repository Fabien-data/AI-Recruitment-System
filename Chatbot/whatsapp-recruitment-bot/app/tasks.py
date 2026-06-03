import asyncio
import logging
from typing import Dict, Any
from app.celery_app import celery_app
from celery.signals import worker_process_init

logger = logging.getLogger(__name__)

TASK_TIMEOUT_SECONDS = 170
TASK_SOFT_TIME_LIMIT_SECONDS = 180
TASK_HARD_TIME_LIMIT_SECONDS = 210
_PROCESS_WEBHOOK_VALUE = None


def _load_webhook_processor() -> None:
    global _PROCESS_WEBHOOK_VALUE
    if _PROCESS_WEBHOOK_VALUE is not None:
        return
    from app.webhooks import process_webhook_value

    _PROCESS_WEBHOOK_VALUE = process_webhook_value


@worker_process_init.connect
def _warm_worker_process(**kwargs):
    try:
        _load_webhook_processor()
        logger.info("Celery worker process preloaded webhook processor")
    except Exception as exc:
        logger.exception("Failed to preload webhook processor in worker init: %s", exc)


def _extract_message_meta(value: Dict[str, Any]) -> Dict[str, str]:
    messages = value.get("messages") if isinstance(value, dict) else None
    first_message = messages[0] if isinstance(messages, list) and messages else {}
    message_id = str(first_message.get("id") or "unknown")
    from_number = str(first_message.get("from") or "unknown")
    return {
        "message_id": message_id,
        "from_number": from_number,
    }

@celery_app.task(
    bind=True,
    name="app.tasks.process_webhook_task",
    soft_time_limit=TASK_SOFT_TIME_LIMIT_SECONDS,
    time_limit=TASK_HARD_TIME_LIMIT_SECONDS,
)
def process_webhook_task(self, value: Dict[str, Any]):
    """
    Celery task that pulls from Redis and executes the heavy webhook processing.
    Runs the existing async process_webhook_value logic synchronously in its own event loop.
    Decouples the WhatsApp API fast 200 OK from the slow LLM/OCR processing.
    """
    meta = _extract_message_meta(value)
    task_id = str(getattr(self.request, "id", "unknown"))
    try:
        from celery.utils.log import get_task_logger  # type: ignore[import-not-found]
        task_logger = get_task_logger(__name__)
    except Exception:
        task_logger = logger

    # Emit lifecycle marker before any heavy lazy-import/runtime work.
    task_logger.info(
        "[task_start] task_id=%s message_id=%s from=%s",
        task_id,
        meta["message_id"],
        meta["from_number"],
    )
    
    # Create a new event loop for this thread's execution
    try:
        from billiard.exceptions import SoftTimeLimitExceeded  # type: ignore[import-not-found]
        _load_webhook_processor()
        assert _PROCESS_WEBHOOK_VALUE is not None

        asyncio.run(
            asyncio.wait_for(
                _PROCESS_WEBHOOK_VALUE(value),
                timeout=TASK_TIMEOUT_SECONDS,
            )
        )
        task_logger.info(
            "[task_finish] task_id=%s message_id=%s from=%s status=success",
            task_id,
            meta["message_id"],
            meta["from_number"],
        )
    except asyncio.TimeoutError:
        task_logger.exception(
            "[task_failure] task_id=%s message_id=%s from=%s reason=async_timeout timeout_seconds=%s",
            task_id,
            meta["message_id"],
            meta["from_number"],
            TASK_TIMEOUT_SECONDS,
        )
        raise
    except SoftTimeLimitExceeded:
        task_logger.exception(
            "[task_failure] task_id=%s message_id=%s from=%s reason=soft_time_limit_exceeded soft_limit_seconds=%s",
            task_id,
            meta["message_id"],
            meta["from_number"],
            TASK_SOFT_TIME_LIMIT_SECONDS,
        )
        raise
    except Exception as e:
        task_logger.exception(
            "[task_failure] task_id=%s message_id=%s from=%s reason=exception error=%s",
            task_id,
            meta["message_id"],
            meta["from_number"],
            e,
        )
        raise


@celery_app.task(
    bind=True,
    name="app.tasks.send_stuck_followup_task",
    soft_time_limit=60,
    time_limit=90,
)
def send_stuck_followup_task(self, candidate_id: int):
    """Send one proactive follow-up nudge to a stuck candidate. Dispatched by the
    Cloud Scheduler-triggered sweep (followup_service.run_followup_sweep) so the
    heavy WhatsApp/translation work runs on the worker, not the web request."""
    from app.services.followup_service import send_followup_for_candidate
    try:
        sent = asyncio.run(send_followup_for_candidate(candidate_id))
        logger.info("send_stuck_followup_task candidate_id=%s sent=%s", candidate_id, sent)
    except Exception as exc:
        logger.exception("send_stuck_followup_task failed for candidate_id=%s: %s", candidate_id, exc)
        raise
