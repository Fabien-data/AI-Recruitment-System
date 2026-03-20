"""
FastAPI Main Application
========================
Main entry point for the WhatsApp AI Recruitment Chatbot.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import init_db
from app.webhooks import router as webhook_router
from app.health import router as health_router
from app.knowledge import router as knowledge_router, bootstrap_job_cache, start_cache_refresh_task
from app import __version__

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.
    Handles startup and shutdown events.
    """
    # Startup
    logger.info(f"Starting {settings.app_name} v{__version__}")
    
    # Initialize database
    try:
        init_db()
        logger.info("Database initialized successfully")
    except Exception as e:
        logger.error(f"Database initialization failed: {e}")
    
    # Bootstrap job cache from recruitment system
    cache_refresh_task = None
    try:
        job_count = await bootstrap_job_cache()
        if job_count > 0:
            logger.info(f"Job cache ready: {job_count} active vacancies loaded")
        else:
            logger.warning("Job cache empty — chatbot will work but won't list vacancies until recruitment system pushes jobs")
        # Start background polling so the cache auto-refreshes every 5 minutes
        cache_refresh_task = start_cache_refresh_task()
        logger.info("Background job-cache refresh task started (interval: 5 min)")
    except Exception as e:
        logger.error(f"Job cache bootstrap error: {e}")

    # Retry any pending syncs from the previous run
    pending_sync_task = None
    try:
        from app.services.recruitment_sync import recruitment_sync as _sync
        from app.database import SessionLocal as _SessionLocal
        with _SessionLocal() as _db:
            await _sync.retry_pending(_db)

        # Start periodic background retry every 60 seconds
        import asyncio as _asyncio

        async def _pending_sync_loop():
            while True:
                await _asyncio.sleep(60)
                try:
                    with _SessionLocal() as _db2:
                        await _sync.retry_pending(_db2)
                except Exception as loop_err:
                    logger.warning(f"Pending sync background retry error: {loop_err}")

        pending_sync_task = _asyncio.create_task(_pending_sync_loop())
        logger.info("Background pending-sync retry task started (interval: 60s)")
    except Exception as e:
        logger.warning(f"Pending sync retry on startup failed: {e}")

    yield

    # Shutdown — cancel background tasks
    if cache_refresh_task and not cache_refresh_task.done():
        cache_refresh_task.cancel()
    if pending_sync_task and not pending_sync_task.done():
        pending_sync_task.cancel()
    logger.info("Shutting down application")



# Create FastAPI application
app = FastAPI(
    title=settings.app_name,
    description="""
    WhatsApp AI Recruitment Chatbot API
    
    An AI-powered WhatsApp chatbot for recruitment that:
    - Collects and processes CVs
    - Answers job-related questions
    - Supports Sinhala, Tamil, and English
    - Uses GPT-4o-mini with RAG for intelligent responses
    """,
    version=__version__,
    lifespan=lifespan,
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(webhook_router)
app.include_router(health_router)
app.include_router(knowledge_router)


# ─── Admin / Testing Endpoints ────────────────────────────────────────────────

from fastapi import Depends
from sqlalchemy.orm import Session
from app.database import SessionLocal
from app import crud


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@app.post("/admin/reset-candidate")
async def reset_candidate(phone: str, db: Session = Depends(get_db)):
    """
    🔄 Full reset of a candidate — clears state, profile data AND conversation history.
    Use this during testing so you can reuse the same phone number from scratch.

    Example: POST /admin/reset-candidate?phone=94XXXXXXXXX
    """
    from app.models import Conversation
    from app.webhooks import _processed_messages  # clear dedup cache too

    candidate = crud.get_candidate_by_phone(db, phone)
    if not candidate:
        return {"status": "not_found", "message": f"No candidate found with phone: {phone}"}

    # Delete all conversation history for this candidate
    conv_count = db.query(Conversation).filter(
        Conversation.candidate_id == candidate.id
    ).count()
    db.query(Conversation).filter(Conversation.candidate_id == candidate.id).delete()

    # Reset state and clear all intake / CV data
    candidate.conversation_state = "initial"
    candidate.extracted_data = None
    candidate.name = None
    candidate.email = None
    candidate.experience_years = None
    candidate.skills = None
    candidate.highest_qualification = None
    candidate.notice_period = None
    candidate.resume_file_path = None
    db.commit()

    # Clear any cached message IDs for this number from the dedup cache
    # (prevents "already processed" skips on the next test message)
    cleared_cache = [mid for mid in list(_processed_messages.keys()) if phone in mid]
    for mid in cleared_cache:
        _processed_messages.pop(mid, None)

    return {
        "status": "reset",
        "phone": phone,
        "conversations_deleted": conv_count,
        "message": "✅ Full reset done. Fresh welcome will be sent on next message.",
    }


@app.post("/admin/reset-state-only")
async def reset_state_only(phone: str, db: Session = Depends(get_db)):
    """
    🔄 Reset ONLY the conversation state (keeps name, email, CV data intact).
    Useful when the bot gets stuck but you don't want to lose candidate data.
    
    Example: POST /admin/reset-state-only?phone=94XXXXXXXXX
    """
    candidate = crud.get_candidate_by_phone(db, phone)
    if not candidate:
        return {"status": "not_found", "message": f"No candidate found with phone: {phone}"}

    candidate.conversation_state = "initial"
    db.commit()

    return {
        "status": "reset",
        "phone": phone,
        "conversation_state": "initial",
        "message": "✅ State reset to initial. CV and profile data preserved.",
    }


@app.post("/admin/reset-all-candidates")
async def reset_all_candidates(db: Session = Depends(get_db)):
    """
    🔄 Reset ALL candidates back to initial state and clear conversation history.
    Useful during testing when you want a clean slate for all test numbers.
    """
    from app.models import Conversation
    from app.webhooks import _processed_messages

    from app.models import Candidate as CandidateModel
    candidates = db.query(CandidateModel).all()
    count = len(candidates)

    # Delete all conversations
    db.query(Conversation).delete()

    # Reset every candidate
    for c in candidates:
        c.conversation_state = "initial"
        c.extracted_data = None
        c.name = None
        c.email = None
        c.experience_years = None
        c.skills = None
        c.highest_qualification = None
        c.notice_period = None
        c.resume_file_path = None

    db.commit()

    # Clear entire dedup cache
    _processed_messages.clear()

    return {
        "status": "reset",
        "candidates_reset": count,
        "message": f"✅ All {count} candidates reset. Fresh welcome on next message from any number.",
    }


@app.get("/admin/test-numbers")
async def list_test_numbers(db: Session = Depends(get_db)):
    """
    📋 List all configured test numbers and their current chatbot session state.
    Numbers are defined in the TEST_NUMBERS env var (comma-separated).

    Example: GET /admin/test-numbers
    """
    numbers = settings.test_number_list
    if not numbers:
        return {
            "status": "no_test_numbers",
            "message": "No test numbers configured. "
                       "Set TEST_NUMBERS=94XXXXXXX,94YYYYYYY in your .env file.",
            "test_numbers": [],
        }

    rows = []
    for phone in numbers:
        candidate = crud.get_candidate_by_phone(db, phone)
        if candidate:
            rows.append({
                "phone": phone,
                "name": candidate.name,
                "state": candidate.conversation_state,
                "language": candidate.language_preference.value if candidate.language_preference else "en",
                "has_cv": bool(candidate.resume_file_path),
                "has_extracted_data": bool(candidate.extracted_data),
            })
        else:
            rows.append({"phone": phone, "state": "no_record"})

    return {"test_numbers": rows, "count": len(rows)}


@app.post("/admin/reset-test-numbers")
async def reset_test_numbers(db: Session = Depends(get_db)):
    """
    🔄 Reset chatbot sessions for ALL configured test numbers.
    Clears conversation state, intake data, CV data, and message history
    for each number in TEST_NUMBERS — **recruitment system records are kept intact**.

    Set TEST_NUMBERS=94XXXXXXX,94YYYYYYY in your .env to define the list.
    Example: POST /admin/reset-test-numbers
    """
    from app.models import Conversation, Candidate as CandidateModel
    from app.webhooks import _processed_messages

    numbers = settings.test_number_list
    if not numbers:
        return {
            "status": "no_test_numbers",
            "message": "No test numbers configured. "
                       "Set TEST_NUMBERS=94XXXXXXX,94YYYYYYY in your .env file.",
        }

    results = []
    for phone in numbers:
        candidate = crud.get_candidate_by_phone(db, phone)
        if not candidate:
            results.append({"phone": phone, "status": "not_found — will register fresh on first message"})
            continue

        # Delete conversation history
        conv_count = db.query(Conversation).filter(
            Conversation.candidate_id == candidate.id
        ).count()
        db.query(Conversation).filter(Conversation.candidate_id == candidate.id).delete()

        # Reset chatbot session fields — recruitment system sync records are NOT touched
        candidate.conversation_state = "initial"
        candidate.extracted_data = None
        candidate.name = None
        candidate.email = None
        candidate.experience_years = None
        candidate.skills = None
        candidate.highest_qualification = None
        candidate.notice_period = None
        candidate.resume_file_path = None
        candidate.language_preference = None

        # Clear dedup cache entries for this number
        stale = [mid for mid in list(_processed_messages.keys()) if phone in mid]
        for mid in stale:
            _processed_messages.pop(mid, None)

        results.append({
            "phone": phone,
            "status": "reset",
            "conversations_deleted": conv_count,
        })

    db.commit()

    reset_count = sum(1 for r in results if r["status"] == "reset")
    return {
        "status": "done",
        "reset": reset_count,
        "details": results,
        "message": f"✅ {reset_count}/{len(numbers)} test numbers reset. "
                   "Fresh welcome will be sent on the next message from each number. "
                   "Recruitment system records are unchanged.",
    }


@app.get("/admin/candidate-info")
async def candidate_info(phone: str, db: Session = Depends(get_db)):
    """
    🔍 View current state and data for a candidate by phone number.
    
    Example: GET /admin/candidate-info?phone=94XXXXXXXXX
    """
    candidate = crud.get_candidate_by_phone(db, phone)
    if not candidate:
        return {"status": "not_found", "phone": phone}

    return {
        "id": candidate.id,
        "phone": candidate.phone_number,
        "name": candidate.name,
        "email": candidate.email,
        "conversation_state": candidate.conversation_state,
        "language": candidate.language_preference.value if candidate.language_preference else "en",
        "experience_years": candidate.experience_years,
        "skills": candidate.skills,
        "qualification": candidate.highest_qualification,
        "extracted_data": candidate.extracted_data,
        "has_cv": bool(candidate.resume_file_path),
    }


@app.delete("/admin/delete-candidate")
async def delete_candidate(phone: str, db: Session = Depends(get_db)):
    """
    🗑️ Completely delete a candidate and all their conversation history.
    USE WITH CAUTION — this is irreversible.
    
    Example: DELETE /admin/delete-candidate?phone=94XXXXXXXXX
    """
    candidate = crud.get_candidate_by_phone(db, phone)
    if not candidate:
        return {"status": "not_found", "phone": phone}

    # Delete conversation history first (FK constraint)
    from app.models import Conversation
    db.query(Conversation).filter(Conversation.candidate_id == candidate.id).delete()
    db.delete(candidate)
    db.commit()

    return {
        "status": "deleted",
        "phone": phone,
        "message": "✅ Candidate and all conversation history deleted.",
    }


@app.get("/")
async def root():
    """Root endpoint with API information."""
    return {
        "name": settings.app_name,
        "version": __version__,
        "status": "running",
        "company": settings.company_name,
        "docs": "/docs" if settings.debug else "Disabled in production"
    }


@app.get("/api/info")
async def api_info():
    """API information endpoint."""
    return {
        "name": settings.app_name,
        "version": __version__,
        "features": [
            "WhatsApp Business API Integration",
            "CV Upload and Processing",
            "Multilingual Support (EN/SI/TA)",
            "RAG-based Knowledge Retrieval",
            "Sentiment Analysis",
            "GPT-4o-mini Responses"
        ],
        "endpoints": {
            "webhook": "/webhook/whatsapp",
            "health": "/health",
            "docs": "/docs" if settings.debug else "disabled"
        }
    }


# This is for development only
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=settings.debug
    )
