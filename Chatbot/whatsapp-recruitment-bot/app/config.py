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
    # Single source of truth for the conversational brain. Bump this env var
    # (OPENAI_CHAT_MODEL) when OpenAI releases a newer flagship.
    chat_model: str = "gpt-5.5"
    # Used by sync_validator for the final pre-CRM-sync AI pass. Defaults to
    # the chat model so we get the same intelligence — override only if a
    # cheaper validator model is preferred.
    pre_sync_validator_model: str = "gpt-5.5"
    # Legacy aliases kept for one release so deployments without the new env
    # vars still boot. New code MUST read settings.chat_model.
    llm_primary_model: str = "gpt-5.5"
    llm_fallback_model: str = "gpt-5.5"
    classifier_model: str = "gpt-5.5"
    
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
