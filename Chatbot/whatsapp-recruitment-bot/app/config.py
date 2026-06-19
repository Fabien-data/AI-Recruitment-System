"""
Application Configuration
=========================
Centralized configuration using Pydantic Settings.
"""

from pydantic_settings import BaseSettings
from typing import Optional
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    # Application
    app_name: str = "WhatsApp Recruitment Chatbot"
    debug: bool = False
    log_level: str = "INFO"
    
    # Meta WhatsApp Business API
    meta_access_token: str
    meta_phone_number_id: str
    meta_app_secret: str = ""          # Optional in dev mode
    meta_verify_token: str = "dewan_recruitment_webhook_2024"
    meta_whatsapp_business_account_id: str = ""
    meta_api_version: str = "v18.0"
    
    # OpenAI
    openai_api_key: str
    # Single source of truth for the conversational brain. Override CHAT_MODEL
    # in env.yaml to bump to a newer flagship as OpenAI releases one.
    chat_model: str = "gpt-4o"
    # Used by sync_validator for the final pre-CRM-sync AI pass. Defaults to
    # the chat model so we get the same intelligence — override only if a
    # cheaper validator model is preferred.
    pre_sync_validator_model: str = "gpt-4o"
    # Legacy aliases used by the run_ai_supervisor fallback path.
    llm_primary_model: str = "gpt-4o"
    llm_fallback_model: str = "gpt-4o-mini"
    classifier_model: str = "gpt-4o-mini"
    
    # Pinecone (OPTIONAL — if empty, falls back to PostgreSQL text search)
    pinecone_api_key: Optional[str] = None
    pinecone_environment: Optional[str] = None
    pinecone_index_name: str = "recruitment-kb"
    
    # Database (local PostgreSQL)
    database_url: str
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "recruitment_db"
    db_user: str = "postgres"
    db_password: str = ""
    
    # Recruitment System Integration
    recruitment_api_url: str = "http://localhost:3000"
    chatbot_api_key: str = ""
    recruitment_sync_enabled: bool = True
    human_handoff_webhook_url: Optional[str] = None
    # Direct PostgreSQL fallback (read-only) — used when REST API is unavailable.
    # Format: postgresql://user:password@host:port/dbname
    recruitment_db_url: Optional[str] = None

    # Redis (Optional)
    redis_url: Optional[str] = None
    
    # File Storage
    upload_dir: str = "./uploads"
    max_file_size_mb: int = 10
    
    # Company Info
    company_name: str = "Your Company"
    company_website: str = ""

    # Unified onboarding rollout control.
    # Use "*" to enable all intake states.
    # Example: "awaiting_job_interest,awaiting_destination_country"
    unified_onboarding_rollout_states: str = "*"

    # Test / Dev Numbers
    # Comma-separated phone numbers used for testing (e.g. "94771234567,94779876543").
    # Set TEST_NUMBERS in your .env to override.
    # These numbers are reset as a group via POST /admin/reset-test-numbers.
    test_numbers: str = ""

    # Controlled rollout flags for modular architecture
    enable_modular_orchestrator: bool = True
    enable_celery_webhook_dispatch: bool = True
    enable_webhook_reaction_signal: bool = False
    enable_ai_classifier: bool = True
    enable_voice_pipeline: bool = True
    enable_cv_priority_interrupt: bool = True
    handoff_confusion_threshold: int = 3

    # ── Proactive follow-up nudges (stuck-candidate re-engagement) ───────────
    # Dark-launched: keep False until the Meta WhatsApp templates are approved,
    # then flip to True. Out-of-24h-window nudges REQUIRE an approved template
    # (free-form is silently dropped by Meta after 24h of candidate silence).
    enable_followup_nudges: bool = False
    # Approved Meta template names (register these in WhatsApp Business Manager).
    followup_template_missing_info: str = "dewan_followup_missing_info"
    # Quiet hours in Asia/Colombo — never send proactive nudges in this window.
    followup_quiet_start_hour: int = 21   # 21:00
    followup_quiet_end_hour: int = 8      # 08:00
    # Smart send-time: prefer each candidate's typical active hour (from their
    # last inbound message) instead of blasting everyone the moment they're due.
    followup_smart_send_time: bool = True

    # Approved Meta templates for proactive STATUS messages sent OUTSIDE the 24h
    # window (interview reminders, job re-engagement). In-window sends still use
    # rich free-form text. Leave EMPTY until the template is approved by Meta —
    # empty means "always free-form" (today's behavior, no regression). Set the
    # env vars (TEMPLATE_INTERVIEW_REMINDER=…) once approved to light up
    # out-of-window delivery.
    # Interview INVITE template (the "you have an interview" first message). Needed
    # to reach candidates outside the 24h window — the #1 cause of "can't send the
    # interview message". Empty = free-form only (dropped out-of-window, but now
    # reported as out_of_window so the candidate lands in the manual-call CSV).
    template_interview_scheduled: str = ""
    template_interview_reminder: str = ""
    template_interview_day_reminder: str = ""
    template_job_now_available: str = ""
    # Rich interview INVITE template with three quick-reply buttons (Confirm /
    # Reschedule / Can't make it) declared ON the template, so they deliver
    # OUT-OF-WINDOW (the common case). Body params: [first_name, job_title,
    # date_time, location, what_to_bring, dress_code]. When empty, the
    # interview_scheduled path falls back to template_interview_scheduled (no
    # buttons) — so leaving this unset is a safe no-op until the template is approved.
    template_interview_invite: str = ""
    # Bulk-campaign template (the UAE walk-in blast) — a STATIC promotional body
    # with three quick-reply buttons (Confirm my slot / Suggest to a friend / Not
    # Interested) declared ON the template, so it delivers OUT-OF-WINDOW (the whole
    # point of a mass send). No body params (fully static). Set
    # TEMPLATE_CAMPAIGN_WALKIN=<approved name> once Meta approves it; the campaign
    # runner / referral flow read it as the fallback template name.
    template_campaign_walkin: str = ""
    # Out-of-window teasers that re-open the 24h window after a candidate taps
    # Reschedule / Can't-make-it (the actual slot/job lists are sent in-window as
    # interactive lists). Body params: reschedule_options=[first_name];
    # cant_make_job_offer=[first_name, job_title].
    template_interview_reschedule_options: str = ""
    template_cant_make_job_offer: str = ""
    # Welcome/intro template for candidates an agent ADDS manually from the
    # Messages panel. These numbers have never messaged in, so they're outside
    # the 24h window and a free-form welcome is dropped by Meta — only this
    # approved template can open the conversation. Body param: [first_name].
    # Empty = free-form only (delivers only if the candidate is already in-window;
    # otherwise reported out_of_window). Set TEMPLATE_WELCOME=… once approved.
    template_welcome: str = ""
    # GENERIC status-update template — the out-of-window fallback for every
    # proactive status that has no specific template above (certified,
    # application_complete, job_assignment, shortlisted, hired, general_pool,
    # rejected_with_alternatives, prescreening_certified, interview_rescheduled,
    # interview_cancelled, transferred). Body params: [first_name, one_line_summary].
    # The full free-form text is queued backend-side and auto-delivers when the
    # candidate replies to the template.
    template_status_update: str = ""
    # Agent-takeover re-engagement template — sent when an agent writes to a
    # candidate outside the 24h window. Body param: [first_name] ("we have an
    # update / a message waiting — reply to receive it"). The agent's actual
    # message is queued backend-side and auto-delivers on the candidate's reply.
    template_reengage: str = ""
    # Apology + onboarding-restart template for candidates wrongly told a role
    # was unavailable, re-engaged OUTSIDE the 24h window. In-window remediation
    # uses free-form text (see scripts/remediate_ad_declines.py); this is only
    # needed for the out-of-window pass. Leave EMPTY until approved by Meta.
    apology_restart_template: str = ""

    # AI-driven intake feature flag. When True, every webhook turn routes
    # through app/llm/conversation_agent.run_turn (the new GPT-5.5 brain).
    # When False, the legacy ad_intake_flow state machine + run_ai_supervisor
    # path runs — same code, instant rollback without redeploy.
    use_ai_driven_intake: bool = True

    @property
    def test_number_list(self) -> list[str]:
        """Return the test numbers as a cleaned list."""
        return [n.strip() for n in self.test_numbers.split(",") if n.strip()]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"   # Ignore unknown env vars


def get_settings() -> Settings:
    """Get settings instance (reads fresh from .env each time)."""
    return Settings()


# Export settings instance
settings = get_settings()
