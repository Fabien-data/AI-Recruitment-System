"""
Database Configuration
======================
SQLAlchemy setup for PostgreSQL on Google Cloud SQL.
Optimized for Cloud Run with connection pooling.
"""

from sqlalchemy import create_engine, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from contextlib import contextmanager
import logging

from app.config import settings

logger = logging.getLogger(__name__)

# Engine configuration — SQLite (local dev) vs PostgreSQL (Cloud SQL)
_is_sqlite = settings.database_url.startswith("sqlite")

if _is_sqlite:
    # SQLite: no pool settings, needs check_same_thread=False for multi-thread
    engine = create_engine(
        settings.database_url,
        connect_args={"check_same_thread": False},
        echo=settings.debug
    )
else:
    # PostgreSQL (local) via psycopg2-binary
    engine = create_engine(
        settings.database_url,
        pool_size=5,
        max_overflow=10,
        pool_recycle=1800,
        pool_pre_ping=True,
        echo=settings.debug,
    )

# Session factory
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)

# Base class for models
Base = declarative_base()


def get_db():
    """
    Dependency for FastAPI to get database session.
    Ensures proper cleanup after request.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_db_context():
    """
    Context manager for database session.
    Use this for non-FastAPI contexts.
    """
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception as e:
        db.rollback()
        logger.error(f"Database error: {e}")
        raise
    finally:
        db.close()


def init_db():
    """
    Initialize database tables.
    Call this on application startup.
    """
    from app import models  # Import models to register them
    Base.metadata.create_all(bind=engine)

    # Lightweight schema self-heal for deployments where legacy DB schema
    # is behind the SQLAlchemy model (prevents UndefinedColumn runtime errors).
    try:
        with engine.begin() as conn:
            if _is_sqlite:
                cols = {
                    row[1]
                    for row in conn.execute(text("PRAGMA table_info(candidates)"))
                }
                if "status" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN status VARCHAR(50) DEFAULT 'active'"))
                if "confusion_streak" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN confusion_streak INTEGER DEFAULT 0"))
                if "question_retries" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN question_retries INTEGER DEFAULT 0"))
                if "extracted_profile" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN extracted_profile JSON"))
                if "is_general_pool" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN is_general_pool BOOLEAN DEFAULT FALSE"))
                if "recent_bot_messages" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN recent_bot_messages JSON DEFAULT '[]'"))
            else:
                cols = {
                    row[0]
                    for row in conn.execute(text("""
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'candidates'
                    """))
                }
                if "status" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN status VARCHAR(50) DEFAULT 'active'"))
                if "confusion_streak" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN confusion_streak INTEGER DEFAULT 0"))
                if "question_retries" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN question_retries INTEGER DEFAULT 0"))
                if "extracted_profile" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN extracted_profile JSONB DEFAULT '{}'::jsonb"))
                if "is_general_pool" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN is_general_pool BOOLEAN DEFAULT FALSE"))
                if "recent_bot_messages" not in cols:
                    conn.execute(text("ALTER TABLE candidates ADD COLUMN recent_bot_messages JSONB DEFAULT '[]'::jsonb"))
    except Exception as schema_err:
        logger.warning(f"Schema self-heal skipped/failed: {schema_err}")

    logger.info("Database tables created successfully")


def check_db_connection() -> bool:
    """
    Check if database connection is healthy.
    Returns True if connection is successful.
    """
    try:
        from sqlalchemy import text
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception as e:
        logger.error(f"Database connection check failed: {e}")
        return False

