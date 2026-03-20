"""
Full end-to-end bot flow test.
Run from project root: python scripts/test_full_flow.py
"""
import asyncio
import logging
import os
import sys

sys.path.insert(0, ".")

from dotenv import load_dotenv
load_dotenv()

# Enable verbose logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s: %(message)s"
)
logger = logging.getLogger("test_full_flow")


async def test():
    from app.database import SessionLocal
    from app.utils.meta_client import meta_client
    from app.chatbot import chatbot

    import random
    phone        = f"9477{random.randint(1000000, 9999999)}"
    message_text = "hello"

    print("=" * 60)
    print("FULL BOT FLOW TEST")
    print("=" * 60)
    print(f"From    : {phone}")
    print(f"Message : {message_text}")
    print()

    db = SessionLocal()
    try:
        # ── Step 1: chatbot.process_message ───────────────────────
        print("--- Step 1: chatbot.process_message ---")
        response = await chatbot.process_message(
            db=db,
            phone_number=phone,
            message_text=message_text
        )
        print(f"Bot response: {response!r}")
        db.commit()
        print()

        # ── Step 2: meta_client.send_message ──────────────────────
        print("--- Step 2: meta_client.send_message ---")
        print(f"Token  : {meta_client.access_token[:25]}...")
        print(f"PhoneID: {meta_client.phone_number_id}")
        try:
            result = await meta_client.send_message(phone, response)
            print(f"API Result: {result}")
        except Exception as e:
            print(f"FAILED — {e}")
            result = {}
            msg_id = result["messages"][0]["id"]
            print()
            print(f"SUCCESS! Message sent — ID: {msg_id}")
            print("Check WhatsApp on +94 76 571 6780!")
        else:
            print()
            print("FAILED — see result above for error details")

    except Exception as exc:
        db.rollback()
        import traceback
        print(f"ERROR: {exc}")
        traceback.print_exc()
    finally:
        db.close()


if __name__ == "__main__":
    asyncio.run(test())
