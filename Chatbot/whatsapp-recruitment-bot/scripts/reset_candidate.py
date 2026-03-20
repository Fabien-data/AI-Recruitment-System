"""Reset a candidate by phone number for fresh testing."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from app.database import SessionLocal
from app import crud

phone = sys.argv[1] if len(sys.argv) > 1 else "94765716780"

db = SessionLocal()
c = crud.get_candidate_by_phone(db, phone)
if c:
    db.delete(c)
    db.commit()
    print(f"Deleted candidate for {phone}")
else:
    print(f"No record found for {phone} — already clean")
db.close()
