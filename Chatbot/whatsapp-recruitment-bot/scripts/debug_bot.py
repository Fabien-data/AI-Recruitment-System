"""Full flow debug test — fresh candidate, all intake steps."""
import asyncio
import logging
import sys
import os

logging.basicConfig(
    level=logging.WARNING,   # Only show warnings/errors — less noise
    stream=sys.stdout,
    format="%(levelname)s: %(message)s"
)

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))


async def chat(db, phone, text):
    from app.chatbot import chatbot
    resp = await chatbot.process_message(db=db, phone_number=phone, message_text=text)
    print(f"\n👤 User: {text}")
    print(f"🤖 Dilan: {resp}")
    return resp


async def main():
    from app.database import SessionLocal
    from app import crud

    phone = "test_flow_fresh_002"

    # Clean up any previous test record
    db = SessionLocal()
    c = crud.get_candidate_by_phone(db, phone)
    if c:
        db.delete(c)
        db.commit()
    db.close()

    print("\n" + "="*60)
    print("FULL FLOW TEST — Fresh Candidate")
    print("="*60)

    steps = [
        ("Step 1 — Greeting", "Hi"),
        ("Step 2 — Job interest", "I want to work as a Mason / Plumber"),
        ("Step 3 — Destination", "Qatar"),
        ("Step 4 — Experience", "I have 5 years experience"),
    ]

    db = SessionLocal()
    try:
        for label, text in steps:
            print(f"\n--- {label} ---")
            await chat(db, phone, text)
    except Exception as e:
        import traceback
        print(f"\n❌ ERROR: {e}")
        traceback.print_exc()
    finally:
        db.close()

    print("\n" + "="*60)
    print("✅ Flow test complete — CV step would follow in real WhatsApp")
    print("="*60)


asyncio.run(main())
