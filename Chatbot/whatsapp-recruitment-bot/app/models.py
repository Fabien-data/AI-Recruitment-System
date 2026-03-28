"""
Database Models
===============
SQLAlchemy ORM models for the recruitment chatbot.
Includes Candidates, Conversations, Applications, and Knowledge Base metadata.
"""

from sqlalchemy import (
    Column, Integer, String, Text, Float, Boolean,
    Enum, JSON, TIMESTAMP, ForeignKey, Index
)
from sqlalchemy.ext.mutable import MutableDict, MutableList
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from datetime import datetime
import enum

from app.database import Base


class LanguagePreference(str, enum.Enum):
    """Supported languages."""
    SINHALA = "si"
    TAMIL = "ta"
    ENGLISH = "en"


class MessageType(str, enum.Enum):
    """Message sender types."""
    USER = "user"
    BOT = "bot"


class ApplicationStatus(str, enum.Enum):
    """Application status options."""
    PENDING = "pending"
    REVIEWED = "reviewed"
    REJECTED = "rejected"
    SHORTLISTED = "shortlisted"


class DocumentType(str, enum.Enum):
    """Knowledge base document types."""
    FAQ = "faq"
    JOB_DESC = "job_desc"
    POLICY = "policy"


class Candidate(Base):
    """
    Candidate/Applicant model.
    Stores candidate profile information and CV data.
    """
    __tablename__ = "candidates"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    phone_number = Column(String(20), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=True)
    email = Column(String(255), nullable=True)
    highest_qualification = Column(String(255), nullable=True)
    skills = Column(Text, nullable=True)
    experience_years = Column(Integer, nullable=True)
    notice_period = Column(String(50), nullable=True)
    resume_file_path = Column(String(500), nullable=True)
    extracted_data = Column(MutableDict.as_mutable(JSON), nullable=True)  # Full CV data as JSON
    language_preference = Column(
        Enum(LanguagePreference),
        default=LanguagePreference.ENGLISH
    )
    conversation_state = Column(String(50), default="initial")  # Track conversation flow
    status = Column(String(50), default="active")
    confusion_streak = Column(Integer, default=0)
    question_retries = Column(Integer, default=0)
    extracted_profile = Column(
        MutableDict.as_mutable(JSON),
        nullable=False,
        default=dict
    )
    recent_bot_messages = Column(
        MutableList.as_mutable(JSON),
        nullable=False,
        default=list
    )
    is_general_pool = Column(Boolean, default=False, nullable=False)
    cv_sync_status = Column(String(20), default=None, nullable=True)  # pending|synced|failed
    created_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    updated_at = Column(
        TIMESTAMP,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp()
    )
    
    # Relationships
    conversations = relationship("Conversation", back_populates="candidate")
    applications = relationship("Application", back_populates="candidate")
    
    # Indexes
    __table_args__ = (
        Index("idx_phone", "phone_number"),
        Index("idx_created", "created_at"),
        Index("idx_email", "email"),
    )
    
    def __repr__(self):
        return f"<Candidate(id={self.id}, phone={self.phone_number}, name={self.name})>"


class Conversation(Base):
    """
    Conversation/Message history model.
    Stores all messages with sentiment analysis results.
    """
    __tablename__ = "conversations"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=False)
    message_type = Column(Enum(MessageType), nullable=False)
    message_text = Column(Text, nullable=True)
    detected_language = Column(String(10), nullable=True)
    sentiment_score = Column(Float, nullable=True)  # -1 to 1
    sentiment_label = Column(String(20), nullable=True)  # positive/negative/neutral
    has_profanity = Column(Boolean, default=False)
    media_type = Column(String(50), nullable=True)  # document, image, etc.
    media_url = Column(String(500), nullable=True)
    timestamp = Column(TIMESTAMP, server_default=func.current_timestamp())
    
    # Relationships
    candidate = relationship("Candidate", back_populates="conversations")
    
    # Indexes
    __table_args__ = (
        Index("idx_candidate_time", "candidate_id", "timestamp"),
    )
    
    def __repr__(self):
        return f"<Conversation(id={self.id}, type={self.message_type}, candidate={self.candidate_id})>"


class Application(Base):
    """
    Job Application model.
    Links candidates to job positions with status tracking.
    """
    __tablename__ = "applications"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=False)
    job_id = Column(String(100), nullable=True)
    job_title = Column(String(255), nullable=True)
    status = Column(
        Enum(ApplicationStatus),
        default=ApplicationStatus.PENDING
    )
    compatibility_score = Column(Float, nullable=True)  # 0-100
    notes = Column(Text, nullable=True)
    applied_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    updated_at = Column(
        TIMESTAMP,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp()
    )
    
    # Relationships
    candidate = relationship("Candidate", back_populates="applications")
    
    # Indexes
    __table_args__ = (
        Index("idx_status", "status"),
        Index("idx_candidate_job", "candidate_id", "job_id"),
    )
    
    def __repr__(self):
        return f"<Application(id={self.id}, candidate={self.candidate_id}, status={self.status})>"


class PendingSync(Base):
    """
    Persistent queue for candidate sync retries.
    When a push to the recruitment system fails with a retryable error,
    the payload is stored here so a background worker can retry later.
    """
    __tablename__ = "pending_sync"

    id = Column(Integer, primary_key=True, autoincrement=True)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=False, index=True)
    idempotency_key = Column(String(64), unique=True, nullable=False)
    payload = Column(JSON, nullable=False)
    attempts = Column(Integer, default=0)
    last_error = Column(Text, nullable=True)
    status = Column(String(20), default="pending")  # pending | success | failed
    created_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    updated_at = Column(
        TIMESTAMP,
        server_default=func.current_timestamp(),
        onupdate=func.current_timestamp()
    )

    candidate = relationship("Candidate")

    __table_args__ = (
        Index("idx_pending_sync_status", "status"),
    )

    def __repr__(self):
        return f"<PendingSync(id={self.id}, candidate={self.candidate_id}, status={self.status})>"


class KnowledgeBaseMetadata(Base):
    """
    Knowledge Base document metadata.
    Stores references to indexed documents in vector DB.
    """
    __tablename__ = "knowledge_base_metadata"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    doc_id = Column(String(255), unique=True, nullable=False)
    doc_type = Column(Enum(DocumentType), nullable=False)
    title = Column(String(500), nullable=True)
    content = Column(Text, nullable=True)  # Original content
    content_hash = Column(String(64), nullable=True)  # SHA256 for deduplication
    embedding_id = Column(String(255), nullable=True)  # Pinecone/Weaviate ID
    indexed_at = Column(TIMESTAMP, server_default=func.current_timestamp())
    
    # Indexes
    __table_args__ = (
        Index("idx_doc_type", "doc_type"),
        Index("idx_hash", "content_hash"),
    )
    
    def __repr__(self):
        return f"<KnowledgeBaseMetadata(id={self.id}, doc_id={self.doc_id}, type={self.doc_type})>"
