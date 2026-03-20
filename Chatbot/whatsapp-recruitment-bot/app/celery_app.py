import os
from celery import Celery

# Use REDIS_URL from env, or default to localhost if not set
redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "whatsapp_chatbot",
    broker=redis_url,
    backend=redis_url,
    include=["app.tasks"]
)

# Optional configuration for stability
celery_app.conf.update(
    result_expires=3600,
    task_serializer='json',
    accept_content=['json'],  # Ignore other content
    result_serializer='json',
    timezone='Asia/Colombo',
    enable_utc=True,
    worker_prefetch_multiplier=1, # Fair dispatching for heavy OCR/LLM tasks
    worker_max_tasks_per_child=50 # Prevent memory leaks over time
)

if __name__ == '__main__':
    celery_app.start()
