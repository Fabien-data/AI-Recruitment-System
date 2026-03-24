import sys
import os
import asyncio

sys.path.insert(0, os.path.abspath('.'))
from dotenv import load_dotenv
load_dotenv('.env')

import logging
logging.basicConfig(filename='test_output.log', level=logging.ERROR, force=True)

from app.database import SessionLocal
from app.chatbot import chatbot
from app import crud

async def test_job_suggestion():
    db = SessionLocal()
    phone = "+94771234567"
    
    # Get or create a candidate
    candidate = crud.get_or_create_candidate(db, phone)
        
    # Set extracted data to mock a CV
    extracted = {
        "job_interest": "Driver",
        "total_experience_years": "5",
    }
    candidate.extracted_data = extracted
    candidate.experience_years = 5
    candidate.skills = "Driving, Heavy Vehicle License"
    
    crud.update_candidate_state(db, candidate.id, chatbot.STATE_APPLICATION_COMPLETE)
    crud.update_candidate_language(db, candidate.id, 'en')
    db.commit()
    db.refresh(candidate)

    # Simulate "suggest me a job"
    try:
        print("\n--- Testing 'suggest me some reliable job opportunities' ---")
        reply = await chatbot._handle_text_message(
            db, candidate, "suggest me some reliable job opportunities for me", phone
        )
        print("\nBOT REPLY:\n")
        print(reply)
    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback
        traceback.print_exc()
        
    db.close()

if __name__ == "__main__":
    asyncio.run(test_job_suggestion())
