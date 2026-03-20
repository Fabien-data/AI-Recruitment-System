FROM python:3.10-slim

# Set working directory
WORKDIR /app

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libffi-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies — explicitly install uvicorn+gunicorn
# so they are always present even if requirements.txt cache is stale
RUN pip install --upgrade pip && \
    pip install -r requirements.txt && \
    pip install gunicorn==21.2.0 "uvicorn[standard]"

# Copy application code
COPY . .

# Create uploads directory
RUN mkdir -p /app/uploads/cv_uploads /app/uploads/temp

# Create non-root user for security
RUN adduser --disabled-password --gecos '' appuser && \
    chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 8000

# Health check (start-period=60s to give FastAPI time to boot on Cloud Run)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT:-8000}/health || exit 1

# Run the application — Cloud Run injects $PORT at runtime
# NOTE: Use --workers 1 on Cloud Run. Cloud Run scales horizontally via multiple instances.
#       Multiple workers per container causes OOM on the 512Mi-1Gi limit (each worker loads
#       the full app stack: LangChain, SQLAlchemy, NLP, etc. ~400-500 MB per worker).
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
