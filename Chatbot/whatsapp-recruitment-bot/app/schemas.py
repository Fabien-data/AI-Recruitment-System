"""
Pydantic Schemas
================
Request/Response models for API validation.
"""

from pydantic import BaseModel, Field, EmailStr
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum


# ============= Enums =============

class LanguageCode(str, Enum):
    SINHALA = "si"
    TAMIL = "ta"
    ENGLISH = "en"


class MessageTypeEnum(str, Enum):
    USER = "user"
    BOT = "bot"


class ApplicationStatusEnum(str, Enum):
    PENDING = "pending"
    REVIEWED = "reviewed"
    REJECTED = "rejected"
    SHORTLISTED = "shortlisted"


# ============= Candidate Schemas =============

class CandidateBase(BaseModel):
    """Base candidate schema."""
    phone_number: str
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    highest_qualification: Optional[str] = None
    skills: Optional[str] = None
    experience_years: Optional[int] = None
    notice_period: Optional[str] = None


class CandidateCreate(CandidateBase):
    """Schema for creating a candidate."""
    pass


class CandidateUpdate(BaseModel):
    """Schema for updating a candidate."""
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    highest_qualification: Optional[str] = None
    skills: Optional[str] = None
    experience_years: Optional[int] = None
    notice_period: Optional[str] = None
    extracted_data: Optional[Dict[str, Any]] = None
    language_preference: Optional[LanguageCode] = None
    conversation_state: Optional[str] = None


class CandidateResponse(CandidateBase):
    """Schema for candidate response."""
    id: int
    resume_file_path: Optional[str] = None
    extracted_data: Optional[Dict[str, Any]] = None
    language_preference: LanguageCode = LanguageCode.ENGLISH
    conversation_state: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ============= Conversation Schemas =============

class ConversationBase(BaseModel):
    """Base conversation schema."""
    candidate_id: int
    message_type: MessageTypeEnum
    message_text: Optional[str] = None


class ConversationCreate(ConversationBase):
    """Schema for creating a conversation entry."""
    detected_language: Optional[str] = None
    sentiment_score: Optional[float] = None
    sentiment_label: Optional[str] = None
    has_profanity: bool = False
    media_type: Optional[str] = None
    media_url: Optional[str] = None


class ConversationResponse(ConversationBase):
    """Schema for conversation response."""
    id: int
    detected_language: Optional[str] = None
    sentiment_score: Optional[float] = None
    sentiment_label: Optional[str] = None
    has_profanity: bool = False
    media_type: Optional[str] = None
    media_url: Optional[str] = None
    timestamp: datetime

    class Config:
        from_attributes = True


# ============= Application Schemas =============

class ApplicationCreate(BaseModel):
    """Schema for creating an application."""
    candidate_id: int
    job_id: Optional[str] = None
    job_title: Optional[str] = None


class ApplicationUpdate(BaseModel):
    """Schema for updating an application."""
    status: Optional[ApplicationStatusEnum] = None
    compatibility_score: Optional[float] = None
    notes: Optional[str] = None


class ApplicationResponse(BaseModel):
    """Schema for application response."""
    id: int
    candidate_id: int
    job_id: Optional[str] = None
    job_title: Optional[str] = None
    status: ApplicationStatusEnum
    compatibility_score: Optional[float] = None
    notes: Optional[str] = None
    applied_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


# ============= WhatsApp Webhook Schemas =============

class WhatsAppTextMessage(BaseModel):
    """WhatsApp text message structure."""
    body: str


class WhatsAppMediaMessage(BaseModel):
    """WhatsApp media message structure."""
    id: str
    mime_type: Optional[str] = None
    sha256: Optional[str] = None
    filename: Optional[str] = None


class WhatsAppMessage(BaseModel):
    """WhatsApp incoming message structure."""
    id: str = Field(..., alias="id")
    from_: str = Field(..., alias="from")
    timestamp: str
    type: str
    text: Optional[WhatsAppTextMessage] = None
    document: Optional[WhatsAppMediaMessage] = None
    image: Optional[WhatsAppMediaMessage] = None

    class Config:
        populate_by_name = True


class WhatsAppContact(BaseModel):
    """WhatsApp contact structure."""
    wa_id: str
    profile: Optional[Dict[str, Any]] = None


class WhatsAppWebhookValue(BaseModel):
    """WhatsApp webhook value structure."""
    messaging_product: str
    metadata: Dict[str, Any]
    contacts: Optional[List[WhatsAppContact]] = None
    messages: Optional[List[WhatsAppMessage]] = None


class WhatsAppWebhookChange(BaseModel):
    """WhatsApp webhook change structure."""
    field: str
    value: WhatsAppWebhookValue


class WhatsAppWebhookEntry(BaseModel):
    """WhatsApp webhook entry structure."""
    id: str
    changes: List[WhatsAppWebhookChange]


class WhatsAppWebhookPayload(BaseModel):
    """WhatsApp webhook payload structure."""
    object: str
    entry: List[WhatsAppWebhookEntry]


# ============= Chat Response Schemas =============

class ChatResponse(BaseModel):
    """Schema for chat response."""
    message: str
    language: LanguageCode
    sentiment: Optional[str] = None
    action_taken: Optional[str] = None


class HealthCheckResponse(BaseModel):
    """Schema for health check response."""
    status: str
    memory_usage: float
    disk_usage: float
    database: str
    version: str
