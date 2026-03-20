"""
Health Check Router
==================
Health check and monitoring endpoints.
"""

import os
import time
import logging
import httpx
import psutil
from fastapi import APIRouter

from app.config import settings
from app.database import check_db_connection
from app import __version__

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/health", tags=["Health"])

RECRUITMENT_API_URL = os.getenv("RECRUITMENT_API_URL", "http://localhost:3000")

# Track recruitment API reachability for CRITICAL logging
_recruitment_api_last_ok: float = time.time()


async def _check_recruitment_api() -> dict:
    """Ping the recruitment system's health endpoint."""
    global _recruitment_api_last_ok
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{RECRUITMENT_API_URL}/health")
        if r.status_code == 200:
            _recruitment_api_last_ok = time.time()
            return {"status": "connected", "response_ms": round(r.elapsed.total_seconds() * 1000)}
        return {"status": "degraded", "http_status": r.status_code}
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        unreachable_seconds = time.time() - _recruitment_api_last_ok
        if unreachable_seconds > 300:  # > 5 minutes
            logger.critical(
                f"Recruitment API unreachable for {int(unreachable_seconds)}s — "
                f"sync is queued but not processing"
            )
        return {"status": "unreachable", "error": type(e).__name__}
    except Exception as e:
        return {"status": "error", "error": str(e)}


@router.get("")
@router.get("/")
async def health_check():
    """
    Health check endpoint for monitoring.
    Returns system status and resource usage.
    Also pings the recruitment API to report integration status.
    """
    # Check database connection
    db_status = "connected" if check_db_connection() else "disconnected"

    # Check recruitment API
    recruitment = await _check_recruitment_api()

    # Overall status
    if db_status != "connected":
        overall = "degraded"
    elif recruitment["status"] != "connected":
        overall = "degraded"
    else:
        overall = "healthy"

    # Get system metrics
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage('/')
    
    return {
        "status": overall,
        "version": __version__,
        "app_name": settings.app_name,
        "database": db_status,
        "recruitment_api": recruitment,
        "memory_usage_percent": round(memory.percent, 2),
        "memory_available_mb": round(memory.available / (1024 * 1024), 2),
        "disk_usage_percent": round(disk.percent, 2),
        "disk_free_gb": round(disk.free / (1024 * 1024 * 1024), 2)
    }


@router.get("/ready")
async def readiness_check():
    """
    Readiness check for Kubernetes/container orchestration.
    """
    db_ok = check_db_connection()
    
    if db_ok:
        return {"status": "ready"}
    else:
        return {"status": "not_ready", "reason": "database_unavailable"}


@router.get("/live")
async def liveness_check():
    """
    Liveness check - just confirms the app is running.
    """
    return {"status": "alive"}
