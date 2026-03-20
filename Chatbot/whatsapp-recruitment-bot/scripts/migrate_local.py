"""Apply any missing local DB column migrations."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import sqlalchemy as sa
from app.database import engine

MIGRATIONS = [
    # Phase 1.4 — CV sync tracking
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_sync_status VARCHAR(20) DEFAULT 'pending'",
    # Phase 1.2 — Drop and recreate pending_sync with correct schema
    "DROP TABLE IF EXISTS pending_sync",
    """
    CREATE TABLE pending_sync (
        id SERIAL PRIMARY KEY,
        candidate_id INTEGER NOT NULL REFERENCES candidates(id),
        idempotency_key VARCHAR(64) UNIQUE NOT NULL,
        payload JSONB NOT NULL,
        attempts INTEGER DEFAULT 0,
        last_error TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_pending_sync_status ON pending_sync(status)",
]

with engine.connect() as conn:
    for sql in MIGRATIONS:
        try:
            conn.execute(sa.text(sql.strip()))
            print(f"OK: {sql.strip()[:60]}")
        except Exception as e:
            print(f"SKIP (already exists or error): {e}")
    conn.commit()
    print("\nAll migrations done.")
