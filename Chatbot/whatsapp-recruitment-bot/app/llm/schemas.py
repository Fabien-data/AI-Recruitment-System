"""
Pydantic schemas shared by the LLM brain and the sync validator.

These were previously defined inside `app.utils.candidate_validator` but the
new architecture has two LLM call sites (`conversation_agent` for every turn,
`sync_validator` for the final pre-CRM-sync pass) — so the schemas live here
to break the circular dependency.
"""

from __future__ import annotations

from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Legacy schema — kept temporarily so the old `run_ai_supervisor` path
# (gated by settings.use_ai_driven_intake=False) still parses its response.
# Removed in the release after AI-driven intake is fully promoted.
# ---------------------------------------------------------------------------
class AIConversationState(BaseModel):
    extracted_name: Optional[str] = Field(None, description="The user's name if mentioned")
    experience_years: Optional[int] = Field(None, description="Years of experience as an integer")
    extracted_age: Optional[int] = Field(None, description="The user's age as an integer if mentioned")
    extracted_email: Optional[str] = Field(None, description="The user's email address if mentioned")
    extracted_countries: Optional[list] = Field(
        None, description="List of preferred countries to work in (e.g. ['UAE', 'Qatar'])"
    )
    job_interest: Optional[str] = Field(None, description="Job role or interest if mentioned")
    country: Optional[str] = Field(None, description="Primary preferred country to work in")
    reply_message: str = Field(..., description="Reply in the exact language/register the user used")
    is_ready_to_sync: bool = Field(
        False,
        description="True when name, job_interest, countries, age, email, experience_years, and cv are all captured",
    )
    intervention_needed: bool = Field(
        False, description="True if the user asks for a human or sounds frustrated"
    )
    next_question_type: Optional[str] = Field(
        None,
        description="The field name you are asking for in this reply (name/job_role/countries/age/email/experience_years/cv). Null if not asking.",
    )


# ---------------------------------------------------------------------------
# Sync validator schemas — produced by the final pre-CRM AI pass and
# persisted on candidate.agent_state["validation"].
# ---------------------------------------------------------------------------
class ValidatedField(BaseModel):
    name: str
    value: Any = None
    confidence: float = Field(0.0, ge=0.0, le=1.0)
    source: Literal["user", "cv", "ad_prefill"] = "user"
    source_turn_id: Optional[str] = None


class ValidationIssue(BaseModel):
    field: str
    kind: Literal["low_confidence", "missing", "format", "inconsistent"]
    detail: str


class ValidatedCandidatePayload(BaseModel):
    fields: List[ValidatedField] = Field(default_factory=list)
    overall_confidence: float = Field(0.0, ge=0.0, le=1.0)
    ready_to_sync: bool = False
    issues: List[ValidationIssue] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Conversation-agent helpers (not serialized to the model — just convenient
# internal types used between conversation_agent.py and tool handlers).
# ---------------------------------------------------------------------------
class AskedQuestion(BaseModel):
    turn: int
    field: str
    phrasing: Optional[str] = None
    answered_value: Optional[Any] = None
    ts: Optional[str] = None


class AlternativeOffer(BaseModel):
    job_id: str
    reason: Literal[
        "skill_mismatch", "country_mismatch", "age_mismatch", "experience_mismatch"
    ]
    offered_at_turn: int
    outcome: Literal["pending", "accepted", "declined"] = "pending"
