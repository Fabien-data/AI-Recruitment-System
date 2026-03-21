import asyncio
import logging
from typing import Dict, Any
from app.celery_app import celery_app

logger = logging.getLogger(__name__)

TASK_TIMEOUT_SECONDS = 90

@celery_app.task(name="app.tasks.process_webhook_task")
def process_webhook_task(value: Dict[str, Any]):
    """
    Celery task that pulls from Redis and executes the heavy webhook processing.
    Runs the existing async process_webhook_value logic synchronously in its own event loop.
    Decouples the WhatsApp API fast 200 OK from the slow LLM/OCR processing.
    """
    from app.webhooks import process_webhook_value
    
    logger.info("Executing heavy message processing via Celery worker")
    
    # Create a new event loop for this thread's execution
    try:
        asyncio.run(
            asyncio.wait_for(
                process_webhook_value(value),
                timeout=TASK_TIMEOUT_SECONDS,
            )
        )
    except asyncio.TimeoutError:
        logger.error(
            "process_webhook_task timed out after %ss; task aborted to unblock queue",
            TASK_TIMEOUT_SECONDS,
        )
    except Exception as e:
        logger.error(f"Error in Celery process_webhook_task: {e}")
