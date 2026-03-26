"""
CRUD Operations
===============
Database operations for all models.
"""

from sqlalchemy.orm import Session
from sqlalchemy import desc
from sqlalchemy.exc import IntegrityError
from typing import Optional, List, Dict, Any
from datetime import datetime
import logging

from app.models import (
    Candidate, Conversation, Application, KnowledgeBaseMetadata,
    LanguagePreference, MessageType, ApplicationStatus
)
from app.schemas import (
    CandidateCreate, CandidateUpdate,
    ConversationCreate,
    ApplicationCreate, ApplicationUpdate
)

logger = logging.getLogger(__name__)


# ============= Candidate CRUD =============

def get_candidate_by_phone(db: Session, phone_number: str) -> Optional[Candidate]:
    """Get candidate by phone number."""
    return db.query(Candidate).filter(
        Candidate.phone_number == phone_number
    ).first()


def get_candidate_by_id(db: Session, candidate_id: int) -> Optional[Candidate]:
    """Get candidate by ID."""
    return db.query(Candidate).filter(Candidate.id == candidate_id).first()


def create_candidate(db: Session, candidate: CandidateCreate) -> Candidate:
    """Create a new candidate."""
    db_candidate = Candidate(
        phone_number=candidate.phone_number,
        name=candidate.name,
        email=candidate.email,
        highest_qualification=candidate.highest_qualification,
        skills=candidate.skills,
        experience_years=candidate.experience_years,
        notice_period=candidate.notice_period
    )
    db.add(db_candidate)
    db.commit()
    db.refresh(db_candidate)
    logger.info(f"Created candidate: {db_candidate.phone_number}")
    return db_candidate


def update_candidate(
    db: Session,
    candidate_id: int,
    update_data: CandidateUpdate
) -> Optional[Candidate]:
    """Update candidate information."""
    db_candidate = get_candidate_by_id(db, candidate_id)
    if not db_candidate:
        return None
    
    update_dict = update_data.model_dump(exclude_unset=True)
    for key, value in update_dict.items():
        setattr(db_candidate, key, value)
    
    db.commit()
    db.refresh(db_candidate)
    logger.info(f"Updated candidate: {candidate_id}")
    return db_candidate


def get_or_create_candidate(db: Session, phone_number: str) -> Candidate:
    """Get existing candidate or create new one."""
    candidate = get_candidate_by_phone(db, phone_number)
    if candidate:
        return candidate

    try:
        return create_candidate(
            db,
            CandidateCreate(phone_number=phone_number)
        )
    except IntegrityError:
        db.rollback()
        candidate = get_candidate_by_phone(db, phone_number)
        if candidate:
            return candidate
        raise


def update_candidate_cv_data(
    db: Session,
    candidate_id: int,
    cv_data: Dict[str, Any],
    file_path: str
) -> Optional[Candidate]:
    """Update candidate with extracted CV data."""
    db_candidate = get_candidate_by_id(db, candidate_id)
    if not db_candidate:
        return None
    
    # Update extracted data
    db_candidate.extracted_data = cv_data
    db_candidate.resume_file_path = file_path
    
    # Update individual fields if available
    if cv_data.get("name"):
        db_candidate.name = cv_data["name"]
    if cv_data.get("email"):
        db_candidate.email = cv_data["email"]
    if cv_data.get("skills"):
        db_candidate.skills = cv_data["skills"]
    if cv_data.get("experience_years"):
        db_candidate.experience_years = cv_data["experience_years"]
    if cv_data.get("highest_qualification"):
        db_candidate.highest_qualification = cv_data["highest_qualification"]
    
    db.commit()
    db.refresh(db_candidate)
    return db_candidate


def update_candidate_language(
    db: Session,
    candidate_id: int,
    language: str
) -> Optional[Candidate]:
    """
    Update candidate language preference.
    Handles all 5 language forms:
      en, si, ta → stored directly
      singlish   → stored as si  (Sinhala base, register=singlish)
      tanglish   → stored as ta  (Tamil base, register=tanglish)
    The register is persisted in extracted_data['language_register'] so the
    chatbot and frontend can tailor responses & display accordingly.
    """
    db_candidate = get_candidate_by_id(db, candidate_id)
    if not db_candidate:
        return None

    # Canonical language code mapping (singlish/tanglish → base language)
    lang_map = {
        "si":       LanguagePreference.SINHALA,
        "ta":       LanguagePreference.TAMIL,
        "en":       LanguagePreference.ENGLISH,
        "singlish": LanguagePreference.SINHALA,  # Romanized Sinhala
        "tanglish": LanguagePreference.TAMIL,    # Romanized Tamil
    }
    db_candidate.language_preference = lang_map.get(language, LanguagePreference.ENGLISH)

    # Persist the exact register so we can tailor responses and frontend display
    existing_data: dict = db_candidate.extracted_data or {}
    existing_data["language_register"] = language  # e.g. "singlish", "tanglish", "si", "ta", "en"
    db_candidate.extracted_data = {**existing_data}

    db.commit()
    db.refresh(db_candidate)
    return db_candidate


def update_candidate_state(
    db: Session,
    candidate_id: int,
    state: str
) -> Optional[Candidate]:
    """Update candidate conversation state."""
    db_candidate = get_candidate_by_id(db, candidate_id)
    if not db_candidate:
        return None
    
    db_candidate.conversation_state = state
    db.commit()
    db.refresh(db_candidate)
    return db_candidate


# ============= Conversation CRUD =============

def create_conversation(db: Session, conversation: ConversationCreate) -> Conversation:
    """Create a new conversation entry."""
    db_conversation = Conversation(
        candidate_id=conversation.candidate_id,
        message_type=MessageType(conversation.message_type.value),
        message_text=conversation.message_text,
        detected_language=conversation.detected_language,
        sentiment_score=conversation.sentiment_score,
        sentiment_label=conversation.sentiment_label,
        has_profanity=conversation.has_profanity,
        media_type=conversation.media_type,
        media_url=conversation.media_url
    )
    db.add(db_conversation)
    db.commit()
    db.refresh(db_conversation)
    return db_conversation


def get_conversation_history(
    db: Session,
    candidate_id: int,
    limit: int = 10
) -> List[Conversation]:
    """Get recent conversation history for a candidate."""
    return db.query(Conversation).filter(
        Conversation.candidate_id == candidate_id
    ).order_by(desc(Conversation.timestamp)).limit(limit).all()


def get_conversation_context(
    db: Session,
    candidate_id: int,
    limit: int = 5
) -> str:
    """Get formatted conversation context for LLM."""
    conversations = get_conversation_history(db, candidate_id, limit)
    
    context_parts = []
    for conv in reversed(conversations):  # Oldest first
        role = "User" if conv.message_type == MessageType.USER else "Assistant"
        context_parts.append(f"{role}: {conv.message_text}")
    
    return "\n".join(context_parts)


# ============= Application CRUD =============

def create_application(db: Session, application: ApplicationCreate) -> Application:
    """Create a new job application."""
    db_application = Application(
        candidate_id=application.candidate_id,
        job_id=application.job_id,
        job_title=application.job_title
    )
    db.add(db_application)
    db.commit()
    db.refresh(db_application)
    logger.info(f"Created application for candidate: {application.candidate_id}")
    return db_application


def update_application(
    db: Session,
    application_id: int,
    update_data: ApplicationUpdate
) -> Optional[Application]:
    """Update application status."""
    db_application = db.query(Application).filter(
        Application.id == application_id
    ).first()
    
    if not db_application:
        return None
    
    update_dict = update_data.model_dump(exclude_unset=True)
    for key, value in update_dict.items():
        if key == "status":
            value = ApplicationStatus(value.value)
        setattr(db_application, key, value)
    
    db.commit()
    db.refresh(db_application)
    return db_application


def get_candidate_applications(
    db: Session,
    candidate_id: int
) -> List[Application]:
    """Get all applications for a candidate."""
    return db.query(Application).filter(
        Application.candidate_id == candidate_id
    ).all()


# ============= Knowledge Base CRUD =============

def create_knowledge_base_entry(
    db: Session,
    doc_id: str,
    doc_type: str,
    title: str,
    content: str,
    content_hash: str,
    embedding_id: str
) -> KnowledgeBaseMetadata:
    """Create a knowledge base entry."""
    db_entry = KnowledgeBaseMetadata(
        doc_id=doc_id,
        doc_type=doc_type,
        title=title,
        content=content,
        content_hash=content_hash,
        embedding_id=embedding_id
    )
    db.add(db_entry)
    db.commit()
    db.refresh(db_entry)
    return db_entry


def get_knowledge_base_by_hash(
    db: Session,
    content_hash: str
) -> Optional[KnowledgeBaseMetadata]:
    """Check if content already exists by hash."""
    return db.query(KnowledgeBaseMetadata).filter(
        KnowledgeBaseMetadata.content_hash == content_hash
    ).first()


def get_all_knowledge_base_entries(
    db: Session,
    doc_type: Optional[str] = None
) -> List[KnowledgeBaseMetadata]:
    """Get all knowledge base entries, optionally filtered by type."""
    query = db.query(KnowledgeBaseMetadata)
    if doc_type:
        query = query.filter(KnowledgeBaseMetadata.doc_type == doc_type)
    return query.all()
