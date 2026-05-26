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


class GeneralKnowledgeUpsertRequest(BaseModel):
    key: str = Field(..., description="Unique knowledge key, e.g. 'company_info', 'registration_fee'")
    category: str = Field(..., description="Category: company_info | faq | process | contact")
    data: Dict[str, Any] = Field(..., description="Arbitrary key-value payload")
    description: Optional[str] = Field(None, description="Human-readable description")


# In-memory job cache — hydrated at startup and refreshed every CACHE_REFRESH_INTERVAL_SECS
job_cache: Dict[str, Dict[str, Any]] = {}

# General knowledge store — company info, FAQs, registration fees, office details.
# Populated at runtime via POST /api/knowledge/general from the CRM, and now
# persisted to disk so a chatbot restart doesn't drop the knowledge until the
# CRM reconciler catches up.
general_knowledge_store: Dict[str, Any] = {}

# FAQ cache: doc_id -> {faq_id, title, content, metadata, updated_at}
# Populated when the CRM pushes a doc_type='faq' via /api/knowledge/upsert.
# Surfaced via /api/knowledge/inventory for the CRM reconciler.
faq_cache: Dict[str, Dict[str, Any]] = {}

# Project cache: same shape, doc_type='project_desc'.
project_cache: Dict[str, Dict[str, Any]] = {}

# Persistence directory: relative to the bot's working dir.
_KNOWLEDGE_DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
_GENERAL_STORE_PATH = os.path.join(_KNOWLEDGE_DATA_DIR, "general_knowledge.json")
_FAQ_CACHE_PATH     = os.path.join(_KNOWLEDGE_DATA_DIR, "faq_cache.json")
_PROJECT_CACHE_PATH = os.path.join(_KNOWLEDGE_DATA_DIR, "project_cache.json")

# Track last refresh time (epoch seconds) so we can serve stale-while-revalidate
_cache_last_refreshed: float = 0.0
CACHE_REFRESH_INTERVAL_SECS: int = 300  # 5 minutes


def _atomic_write_json(path: str, payload: Dict[str, Any]) -> None:
    """Write JSON to `path` atomically (write to .tmp then rename)."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, default=str)
        os.replace(tmp, path)
    except Exception as e:
        logger.warning(f"Failed to persist {path}: {e}")


def _load_json_file(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.warning(f"Failed to load {path}: {e}")
        return {}


def load_persisted_knowledge() -> None:
    """
    Hydrate general_knowledge_store / faq_cache / project_cache from disk.
    Call once from the FastAPI lifespan before bootstrap_job_cache so the bot
    can answer FAQ-level questions even if the CRM is briefly unreachable.
    """
    global general_knowledge_store, faq_cache, project_cache
    general_knowledge_store.update(_load_json_file(_GENERAL_STORE_PATH))
    faq_cache.update(_load_json_file(_FAQ_CACHE_PATH))
    project_cache.update(_load_json_file(_PROJECT_CACHE_PATH))
    logger.info(
        f"Persisted knowledge loaded: general={len(general_knowledge_store)} "
        f"faqs={len(faq_cache)} projects={len(project_cache)}"
    )


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

        # Keywords that identify test/demo jobs — never show these to real users
        _TEST_TITLE_KEYWORDS = {"test", "e2e", "cache test", "demo", "dummy", "tbd", "sample"}
        loaded_count = 0
        for job in jobs:
            job_id = str(job.get("job_id", ""))
            if not job_id:
                continue

            # Skip jobs that are not active
            if job.get("status", "active") != "active":
                continue

            # Skip test/demo jobs by title
            title_lower = (job.get("title") or "").lower()
            if any(kw in title_lower for kw in _TEST_TITLE_KEYWORDS):
                logger.debug(f"Skipping test/demo job from cache: {job.get('title')!r}")
                continue

            raw_req = job.get("requirements")
            if isinstance(raw_req, str):
                try:
                    requirements = json.loads(raw_req) if raw_req else {}
                except Exception:
                    requirements = {}
            else:
                requirements = raw_req if isinstance(raw_req, dict) else {}

            schema = job.get("required_fields_schema")
            if isinstance(schema, str):
                try:
                    schema = json.loads(schema) if schema else {}
                except Exception:
                    schema = {}
            elif not isinstance(schema, dict):
                schema = {}

            urgency_level = job.get("urgency_level") or "normal"
            job_cache[job_id] = {
                "job_id": job_id,
                "project_id": job.get("project_id"),
                "title": job.get("title", ""),
                "category": job.get("category", ""),
                "status": job.get("status", "active"),
                "requirements": requirements,
                "salary_range": job.get("salary_range"),
                "location": job.get("location", ""),
                "description": job.get("description", ""),
                "countries":      job.get("countries") or [],
                "benefits":       job.get("benefits") or {},
                "salary_info":    job.get("salary_info") or {},
                "start_date":     job.get("start_date"),
                "interview_date": job.get("interview_date"),
                "project_title":  job.get("project_title"),
                # Structured urgency replaces the boolean is_urgent. The bool
                # is kept (derived) for back-compat with any downstream filter.
                "urgency_level":  urgency_level,
                "is_urgent":      urgency_level in ("urgent", "top_urgent") or bool(job.get("is_urgent")),
                # Geographic targeting (added in CRM migration 020)
                "country":        job.get("country"),
                "country_code":   job.get("country_code"),
                "domain":         job.get("domain"),
                # Live position counts
                "positions_available":  job.get("positions_available"),
                "positions_filled":     job.get("positions_filled"),
                "positions_remaining":  job.get("positions_remaining"),
                "required_fields_schema": schema,
                "created_at":     job.get("created_at"),
                "updated_at":     job.get("updated_at"),
            }
            loaded_count += 1

        global _cache_last_refreshed
        logger.info(f"✅ Job cache bootstrap: loaded {loaded_count} active jobs ({len(jobs) - loaded_count} test/inactive skipped)")
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
    x_chatbot_api_key: Optional[str] = Header(default=None)
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

    # Update in-memory caches based on doc_type so the orchestrator can serve
    # answers directly (without a Pinecone round-trip) and the /inventory
    # endpoint can report what the bot has.
    metadata = body.metadata or {}
    now_ts = time.time()

    if body.doc_type.startswith("job"):
        job_id = metadata.get("job_id")
        if job_id:
            raw_req = metadata.get("requirements")
            if isinstance(raw_req, str):
                try:
                    requirements = json.loads(raw_req) if raw_req else {}
                except Exception:
                    requirements = {}
            else:
                requirements = raw_req if isinstance(raw_req, dict) else {}
            schema = metadata.get("required_fields_schema")
            if isinstance(schema, str):
                try:
                    schema = json.loads(schema) if schema else {}
                except Exception:
                    schema = {}
            elif not isinstance(schema, dict):
                schema = {}

            urgency_level = metadata.get("urgency_level") or "normal"
            job_cache[job_id] = {
                "job_id": job_id,
                "project_id": metadata.get("project_id"),
                "title": body.title,
                "category": metadata.get("category"),
                "status": metadata.get("status"),
                "requirements": requirements,
                "salary_range": metadata.get("salary_range"),
                "location": metadata.get("location", ""),
                "description": metadata.get("description", ""),
                "countries":      metadata.get("countries") or [],
                "benefits":       metadata.get("benefits") or {},
                "salary_info":    metadata.get("salary_info") or {},
                "start_date":     metadata.get("start_date"),
                "interview_date": metadata.get("interview_date"),
                "project_title":  metadata.get("project_title"),
                # Structured urgency (urgency_level) supersedes is_urgent. The
                # bool is preserved (derived) so the legacy filter still works.
                "urgency_level":  urgency_level,
                "is_urgent":      urgency_level in ("urgent", "top_urgent") or bool(metadata.get("is_urgent")),
                # Geographic targeting (CRM migration 020)
                "country":        metadata.get("country"),
                "country_code":   metadata.get("country_code"),
                "domain":         metadata.get("domain"),
                # Live position counts (computed in the CRM via LATERAL join)
                "positions_available":  metadata.get("positions_available"),
                "positions_filled":     metadata.get("positions_filled"),
                "positions_remaining":  metadata.get("positions_remaining"),
                "required_fields_schema": schema,
                "updated_at":     now_ts,
            }
            logger.info(f"✅ Job cache instantly updated for job_id={job_id} title={body.title!r}")

    elif body.doc_type == "faq":
        faq_cache[body.doc_id] = {
            "doc_id": body.doc_id,
            "faq_id": metadata.get("faq_id"),
            "title": body.title,
            "content": body.content,
            "category": metadata.get("category"),
            "keywords": metadata.get("keywords") or [],
            "priority": metadata.get("priority", 0),
            "languages": metadata.get("languages") or ["en"],
            "metadata": metadata,
            "updated_at": now_ts,
        }
        _atomic_write_json(_FAQ_CACHE_PATH, faq_cache)
        logger.info(f"✅ FAQ cache updated: {body.doc_id} ({metadata.get('category')})")

    elif body.doc_type == "project_desc":
        project_cache[body.doc_id] = {
            "doc_id": body.doc_id,
            "project_id": metadata.get("project_id"),
            "title": body.title,
            "content": body.content,
            "client_name": metadata.get("client_name"),
            "industry_type": metadata.get("industry_type"),
            "status": metadata.get("status"),
            "countries": metadata.get("countries") or [],
            "benefits": metadata.get("benefits") or {},
            "salary_info": metadata.get("salary_info") or {},
            "contact_info": metadata.get("contact_info") or {},
            "start_date": metadata.get("start_date"),
            "interview_date": metadata.get("interview_date"),
            "updated_at": now_ts,
        }
        _atomic_write_json(_PROJECT_CACHE_PATH, project_cache)
        logger.info(f"✅ Project cache updated: {body.doc_id} title={body.title!r}")

    return {
        "status": "ok",
        "indexed": indexed,
        "doc_id": body.doc_id,
    }


@router.post("/delete")
async def delete_knowledge(
    body: KnowledgeDeleteRequest,
    x_chatbot_api_key: Optional[str] = Header(default=None)
):
    """
    Delete a knowledge document from the RAG index.
    """
    _require_api_key(x_chatbot_api_key)

    deleted = rag_engine.delete_document(body.doc_id)

    # Clean local caches mirroring the doc_id prefix used by the CRM enqueue.
    if body.doc_id.startswith("job_"):
        job_id = body.doc_id.replace("job_", "", 1)
        if job_id in job_cache:
            job_cache.pop(job_id, None)
            logger.info(f"Job cache entry removed for job_id={job_id}")
    elif body.doc_id.startswith("faq_"):
        if body.doc_id in faq_cache:
            faq_cache.pop(body.doc_id, None)
            _atomic_write_json(_FAQ_CACHE_PATH, faq_cache)
            logger.info(f"FAQ cache entry removed: {body.doc_id}")
    elif body.doc_id.startswith("project_"):
        if body.doc_id in project_cache:
            project_cache.pop(body.doc_id, None)
            _atomic_write_json(_PROJECT_CACHE_PATH, project_cache)
            logger.info(f"Project cache entry removed: {body.doc_id}")

    return {
        "status": "ok",
        "deleted": deleted,
        "doc_id": body.doc_id,
    }


def get_job_cache() -> Dict[str, Dict[str, Any]]:
    """Expose job cache for use by the chatbot engine."""
    return job_cache


def get_general_knowledge() -> Dict[str, Any]:
    """Expose general knowledge store for use by the chatbot engine."""
    return general_knowledge_store


@router.post("/general")
async def upsert_general_knowledge(
    body: GeneralKnowledgeUpsertRequest,
    x_chatbot_api_key: Optional[str] = Header(default=None),
):
    """
    Upsert a general knowledge entry (company info, FAQs, registration details).
    Called by the CRM whenever admin updates company or process information.
    The store is process-local; the CRM should re-push on chatbot restart.
    """
    _require_api_key(x_chatbot_api_key)

    general_knowledge_store[body.key] = {
        "key": body.key,
        "category": body.category,
        "data": body.data,
        "description": body.description,
        "updated_at": time.time(),
    }
    _atomic_write_json(_GENERAL_STORE_PATH, general_knowledge_store)
    logger.info(f"General knowledge upserted: key={body.key!r} category={body.category!r}")

    content_str = f"{body.description or body.key}: {json.dumps(body.data)}"
    try:
        rag_engine.index_document(
            doc_id=f"general_{body.key}",
            text=content_str,
            metadata={"doc_type": "general_knowledge", "key": body.key, "category": body.category},
        )
    except Exception as e:
        logger.warning(f"RAG indexing failed for general knowledge key={body.key!r}: {e}")

    return {"status": "ok", "key": body.key}


@router.get("/general")
async def list_general_knowledge(
    x_chatbot_api_key: Optional[str] = Header(default=None),
):
    """List all stored general knowledge entries (CRM admin debug)."""
    _require_api_key(x_chatbot_api_key)
    return {"entries": list(general_knowledge_store.values()), "count": len(general_knowledge_store)}


@router.post("/refresh-cache")
async def refresh_cache_endpoint(
    x_chatbot_api_key: Optional[str] = Header(default=None)
):
    """
    Trigger an immediate refresh of the in-memory job cache.
    Called by the recruitment system after job create/update so new jobs
    appear in the chatbot within seconds (instead of waiting for 5-min poll).
    """
    _require_api_key(x_chatbot_api_key)
    count = await bootstrap_job_cache()
    return {"status": "ok", "jobs_loaded": count}


@router.get("/health/job-cache")
async def job_cache_health():
    """
    Returns current job cache size, status, and last refresh timestamp.
    Unauthenticated — safe for internal health checks and monitoring.
    """
    cache_size = len(job_cache)
    last_refresh_ts = _cache_last_refreshed
    age_secs = time.time() - last_refresh_ts if last_refresh_ts else None
    return {
        "cached_jobs": cache_size,
        "status": "ok" if cache_size > 0 else "empty",
        "last_refresh_epoch": last_refresh_ts or None,
        "cache_age_seconds": round(age_secs, 1) if age_secs is not None else None,
        "refresh_interval_seconds": CACHE_REFRESH_INTERVAL_SECS,
    }


@router.get("/inventory")
async def knowledge_inventory(
    x_chatbot_api_key: Optional[str] = Header(default=None)
):
    """
    Report what knowledge the bot currently has. Used by the CRM reconciler
    to diff against its own tables and re-push any stale or missing rows.

    Shape: {
      jobs:     [{ doc_id: 'job_<id>',     updated_at: <epoch> }, ...],
      faqs:     [{ doc_id: 'faq_<id>',     updated_at: <epoch> }, ...],
      projects: [{ doc_id: 'project_<id>', updated_at: <epoch> }, ...],
      counts: { jobs, faqs, projects, general_knowledge }
    }
    """
    _require_api_key(x_chatbot_api_key)

    jobs_inv = [
        {"doc_id": f"job_{jid}", "updated_at": entry.get("updated_at")}
        for jid, entry in job_cache.items()
    ]
    faqs_inv = [
        {"doc_id": did, "updated_at": entry.get("updated_at")}
        for did, entry in faq_cache.items()
    ]
    projects_inv = [
        {"doc_id": did, "updated_at": entry.get("updated_at")}
        for did, entry in project_cache.items()
    ]
    return {
        "jobs": jobs_inv,
        "faqs": faqs_inv,
        "projects": projects_inv,
        "counts": {
            "jobs": len(job_cache),
            "faqs": len(faq_cache),
            "projects": len(project_cache),
            "general_knowledge": len(general_knowledge_store),
        },
    }

