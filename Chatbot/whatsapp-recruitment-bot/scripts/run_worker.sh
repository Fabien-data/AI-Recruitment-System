#!/bin/sh
set -e

# Cloud Run requires an HTTP listener; keep a lightweight probe server in background.
python -m http.server "${PORT:-8080}" &
HTTP_PID=$!

cleanup() {
	kill "$HTTP_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

# Run Celery in foreground so any worker crash fails the container and triggers restart.
exec celery -A app.celery_app worker --pool=prefork --concurrency=2 --loglevel=info