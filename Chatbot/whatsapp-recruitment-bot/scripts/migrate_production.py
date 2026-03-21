import sqlalchemy as sa
from app.database import engine

SQLS = [
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50)",
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_sync_status VARCHAR(20) DEFAULT 'pending'",
    "CREATE INDEX IF NOT EXISTS ix_candidates_phone_number ON candidates(phone_number)",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_sync_idempotency_key ON pending_sync(idempotency_key)",
    "CREATE INDEX IF NOT EXISTS idx_pending_sync_status ON pending_sync(status)",
]

CREATE_PENDING_SYNC = """
CREATE TABLE IF NOT EXISTS pending_sync (
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
"""

COPY_PHONE = """
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='candidates' AND column_name='phone'
    ) THEN
        EXECUTE 'UPDATE candidates SET phone_number = phone WHERE phone_number IS NULL AND phone IS NOT NULL';
    END IF;
END $$;
"""

with engine.connect() as conn:
    conn.execute(sa.text(CREATE_PENDING_SYNC))
    conn.execute(sa.text(COPY_PHONE))
    for sql in SQLS:
        try:
            conn.execute(sa.text(sql))
            print(f"OK: {sql}")
        except Exception as exc:
            print(f"WARN: {sql} -> {exc}")
    conn.commit()

print("Migration complete")
