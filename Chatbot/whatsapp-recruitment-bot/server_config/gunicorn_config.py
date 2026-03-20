# Gunicorn Configuration — Optimized for Serverbyt Shared Hosting
# ================================================================

import multiprocessing
import os

# Server socket
# Serverbyt Passenger: bind to 127.0.0.1 (proxied by Apache/Nginx)
# Direct run via SSH or Docker/Cloud Run: bind to 0.0.0.0
bind = os.getenv('GUNICORN_BIND', '0.0.0.0:8000')

# Worker processes
# Serverbyt Blaze shared hosting: keep workers low (2–3) to stay within memory
workers = int(os.getenv('GUNICORN_WORKERS', 2))
worker_class = 'uvicorn.workers.UvicornWorker'

# Timeouts — generous for CV upload + OCR processing
timeout = 120
keepalive = 5
graceful_timeout = 30

# Logging to stdout (cPanel will capture to error_log)
loglevel = os.getenv('LOG_LEVEL', 'info').lower()
accesslog = '-'
errorlog = '-'

# Process naming
proc_name = 'dewan-chatbot'

# Request size limits (10 MB for CV uploads)
limit_request_line = 4094
limit_request_fields = 100
limit_request_field_size = 8190

# Preload app for memory efficiency (saves ~30% RAM on shared hosting)
preload_app = True
