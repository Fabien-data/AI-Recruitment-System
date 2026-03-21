#!/bin/sh
set -e

celery -A app.celery_app worker --pool=prefork --concurrency=2 --loglevel=info &

exec python -m http.server "${PORT:-8080}"