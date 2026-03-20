from typing import Dict, Any, Optional
import json
import logging
import os
import asyncio
import time
import httpx
from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel, Field

from app.config import settings
from app.llm.rag_engine import rag_engine


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


class KnowledgeUpsertRequest(BaseModel):
    doc_id: str = Field(..., description="Unique document identifier")
    doc_type: str = Field(..., description="Type of document, e.g. job_desc")
    title: str = Field(..., description="Human-friendly title")
    content: str = Field(..., description="Full text content to index")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="Arbitrary metadata (job_id, project_id, requirements, etc.)")


class KnowledgeDeleteRequest(BaseModel):
    doc_id: str = Field(..., description="Unique document identifier to delete")


# In-memory job cache — hydrated at startup and refreshed every CACHE_REFRESH_INTERVAL_SECS
job_cache: Dict[str, Dict[str, Any]] = {}

# Track last refresh time (epoch seconds) so we can serve stale-while-revalidate
_cache_last_refreshed: float = 0.0
CACHE_REFRESH_INTERVAL_SECS: int = 300  # 5 minutes


def is_cache_stale() -> bool:
    """Return True when the cache has not been refreshed within the refresh interval."""
    return (time.time() - _cache_last_refreshed) > CACHE_REFRESH_INTERVAL_SECS


async def _cache_refresh_loop() -> None:
    """
    Background coroutine: refreshes the job cache every CACHE_REFRESH_INTERVAL_SECS.
    Started once from main.py lifespan; runs for the lifetime of the process.
    Failures are caught and logged — they never crash the loop.
    """
    global _cache_last_refreshed
    while True:
        try:
            await asyncio.sleep(CACHE_REFRESH_INTERVAL_SECS)
            logger.info("Job cache: scheduled background refresh starting…")
            loaded = await bootstrap_job_cache()
            _cache_last_refreshed = time.time()
            logger.info(f"Job cache: background refresh done — {loaded} jobs loaded")
        except asyncio.CancelledError:
            logger.info("Job cache refresh loop cancelled")
            break
        except Exception as e:
            logger.error(f"Job cache background refresh failed: {e}")


def start_cache_refresh_task() -> asyncio.Task:
    """
    Schedule the background cache refresh loop as an asyncio Task.
    Call this ONCE from main.py lifespan startup (after the first bootstrap_job_cache call).
    Returns the Task so the caller can cancel it on shutdown.
    """
    return asyncio.create_task(_cache_refresh_loop())


async def bootstrap_job_cache() -> int:
    """
    Fetch all active jobs from the recruitment system on startup
    and populate the in-memory job_cache.

    Returns the number of jobs loaded.
    Called from main.py lifespan startup.
    """
    recruitment_url = settings.recruitment_api_url
    api_key = settings.chatbot_api_key
    jobs_url = f"{recruitment_url}/api/chatbot/jobs"

    if not api_key:
        logger.warning("CHATBOT_API_KEY not set — cannot bootstrap job cache from recruitment system")
        return 0

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                jobs_url,
                headers={"x-chatbot-api-key": api_key}
            )

        if response.status_code != 200:
            logger.warning(
                f"Job cache bootstrap: recruitment system returned {response.status_code} — "
                f"starting with empty cache"
            )
            return 0

        data = response.json()
        jobs = data.get("jobs", [])

        for job in jobs:
            job_id = str(job.get("job_id", ""))
            if not job_id:
                continue
            raw_req = job.get("requirements")
            if isinstance(raw_req, str):
                try:
                    requirements = json.loads(raw_req) if raw_req else {}
                except Exception:
                    requirements = {}
            else:
                requirements = raw_req if isinstance(raw_req, dict) else {}

            job_cache[job_id] = {
                "job_id": job_id,
                "project_id": job.get("project_id"),
                "title": job.get("title", ""),
                "category": job.get("category", ""),
                "status": job.get("status", "active"),
                "requirements": requirements,
                "salary_range": job.get("salary_range"),
            }

        global _cache_last_refreshed
        logger.info(f"✅ Job cache bootstrap: loaded {len(jobs)} active jobs from recruitment system")
        _cache_last_refreshed = time.time()
        return len(jobs)

    except httpx.ConnectError:
        logger.warning(
            f"Job cache bootstrap: cannot connect to recruitment system at {recruitment_url} — "
            f"starting with empty cache. Jobs will be pushed via /api/knowledge/upsert."
        )
        return 0
    except Exception as e:
        logger.error(f"Job cache bootstrap failed: {e}", exc_info=True)
        return 0


async def refresh_job_cache() -> int:
    """
    Re-fetch active jobs from the recruitment system on demand and repopulate
    the in-memory job_cache.  Delegates to bootstrap_job_cache so the fetch
    logic stays in one place.  Called at runtime when the cache is found empty
    (e.g. after a process restart that missed the startup hook).

    Returns the number of jobs loaded.
    """
    logger.info("Refreshing job cache on demand…")
    return await bootstrap_job_cache()


def _require_api_key(x_chatbot_api_key: Optional[str]) -> None:
    """Validate the shared chatbot API key. Supports dual-key rotation."""
    expected = settings.chatbot_api_key
    expected_old = getattr(settings, 'chatbot_api_key_old', None) or os.getenv("CHATBOT_API_KEY_OLD")
    if not expected:
        logger.error("CHATBOT_API_KEY / settings.chatbot_api_key is not configured")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Chatbot API key is not configured"
        )
    if not x_chatbot_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key"
        )
    # Accept current key or old key (during rotation window)
    if x_chatbot_api_key == expected:
        return
    if expected_old and x_chatbot_api_key == expected_old:
        logger.info("Request authenticated with OLD API key — rotation in progress")
        return
    logger.warning("Rejected knowledge API request with invalid API key")
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid API key"
    )


@router.post("/upsert")
async def upsert_knowledge(
    body: KnowledgeUpsertRequest,
    x_chatbot_api_key: Optional[str] = Header(default=None, convert_underscores=False)
):
    """
    Upsert a knowledge document into the RAG index.

    Used by the recruitment system to push job and project content.
    """
    _require_api_key(x_chatbot_api_key)

    indexed = False
    try:
        indexed = rag_engine.index_document(
            doc_id=body.doc_id,
            text=body.content,
            metadata={
                "doc_type": body.doc_type,
                "title": body.title,
                **(body.metadata or {}),
            },
        )
    except Exception as e:
        logger.error(f"Indexing failed for document {body.doc_id}: {e}")

    if not indexed:
        # We still return 202-like response so recruitment system isn't blocked on vector infra
        logger.warning(f"Document {body.doc_id} was not indexed successfully into vector DB.")

    # Update in-memory job cache when we recognise a job document
    metadata = body.metadata or {}
    job_id = metadata.get("job_id")
    if body.doc_type.startswith("job") and job_id:
        raw_req = metadata.get("requirements")
        if isinstance(raw_req, str):
            try:
                requirements = json.loads(raw_req) if raw_req else {}
            except Exception:
                requirements = {}
        else:
            requirements = raw_req if isinstance(raw_req, dict) else {}
        job_cache[job_id] = {
            "job_id": job_id,
            "project_id": metadata.get("project_id"),
            "title": body.title,
            "category": metadata.get("category"),
            "status": metadata.get("status"),
            "requirements": requirements,
            "salary_range": metadata.get("salary_range"),
        }
        logger.info(f"Job cache updated for job_id={job_id}")

    return {
        "status": "ok",
        "indexed": indexed,
        "doc_id": body.doc_id,
    }


@router.post("/delete")
async def delete_knowledge(
    body: KnowledgeDeleteRequest,
    x_chatbot_api_key: Optional[str] = Header(default=None, convert_underscores=False)
):
    """
    Delete a knowledge document from the RAG index.
    """
    _require_api_key(x_chatbot_api_key)

    deleted = rag_engine.delete_document(body.doc_id)

    # Clean job cache if applicable
    if body.doc_id.startswith("job_"):
        job_id = body.doc_id.replace("job_", "", 1)
        if job_id in job_cache:
            job_cache.pop(job_id, None)
            logger.info(f"Job cache entry removed for job_id={job_id}")

    return {
        "status": "ok",
        "deleted": deleted,
        "doc_id": body.doc_id,
    }


def get_job_cache() -> Dict[str, Dict[str, Any]]:
    """
    Expose job cache for use by the chatbot engine.

    For now this is in-memory and process-local, which is sufficient for demos.
    """
    return job_cache


@router.post("/refresh-cache")
async def refresh_cache_endpoint(
    x_chatbot_api_key: Optional[str] = Header(default=None, convert_underscores=False)
):
    """
    Trigger an immediate refresh of the in-memory job cache.
    Called by the recruitment system after job create/update so new jobs
    appear in the chatbot within seconds (instead of waiting for 5-min poll).
    """
    _require_api_key(x_chatbot_api_key)
    count = await bootstrap_job_cache()
    return {"status": "ok", "jobs_loaded": count}

