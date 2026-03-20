"""
Diagnose DB schema and test Conversation insert.
"""
import sys
sys.path.insert(0, ".")
from dotenv import load_dotenv
load_dotenv()

from app.database import engine, SessionLocal, init_db
from sqlalchemy import inspect, text

# 1. Re-create tables (drop + create)
print("=== Dropping and recreating all tables ===")
from app.database import Base
from app import models  # registers all models

Base.metadata.drop_all(bind=engine)
Base.metadata.create_all(bind=engine)
print("Tables recreated!\n")

# 2. Show schema
inspector = inspect(engine)
tables = inspector.get_table_names()
print("Tables:", tables)
for t in tables:
    cols = inspector.get_columns(t)
    print(f"\n{t}:")
    for col in cols:
        print(f"  {col['name']} : {col['type']} nullable={col['nullable']}")

# 3. Test Conversation insert
print("\n=== Testing Conversation insert ===")
from app.models import Conversation, MessageType

db = SessionLocal()
try:
    # First create a candidate
    from app.models import Candidate
    cand = Candidate(phone_number="94765716780")
    db.add(cand)
    db.commit()
    db.refresh(cand)
    print(f"Candidate created: id={cand.id}")

    conv = Conversation(
        candidate_id=cand.id,
        message_type=MessageType.USER,
        message_text="hello",
        detected_language="en"
    )
    db.add(conv)
    db.commit()
    db.refresh(conv)
    print(f"Conversation created: id={conv.id}")
    print("\nSUCCESS! DB is working correctly.")
except Exception as exc:
    db.rollback()
    print(f"ERROR: {exc}")
    import traceback
    traceback.print_exc()
finally:
    db.close()
