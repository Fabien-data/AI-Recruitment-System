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

    # Test / Dev Numbers
    # Comma-separated phone numbers used for testing (e.g. "94771234567,94779876543").
    # Set TEST_NUMBERS in your .env to override.
    # These numbers are reset as a group via POST /admin/reset-test-numbers.
    test_numbers: str = ""

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
