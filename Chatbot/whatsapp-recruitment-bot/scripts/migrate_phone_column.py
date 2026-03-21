import sqlalchemy as sa
from app.database import engine

SQLS = [
    "ALTER TABLE candidates ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50)",
    "CREATE INDEX IF NOT EXISTS ix_candidates_phone_number ON candidates(phone_number)",
]

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
    for sql in SQLS:
        conn.execute(sa.text(sql))
        print(f"OK: {sql}")
    conn.execute(sa.text(COPY_PHONE))
    print("OK: copied phone -> phone_number when possible")
    conn.commit()

print("phone_number migration complete")
