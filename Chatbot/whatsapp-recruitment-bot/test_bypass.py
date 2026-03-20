import asyncio
import sys
import os

sys.path.insert(0, os.path.abspath('.'))
from dotenv import load_dotenv
load_dotenv('.env')

from app.database import SessionLocal
from app.chatbot import chatbot
from app import crud

async def test_vacancy_question():
    db = SessionLocal()
    phone = "+94770000000"
    candidate = crud.get_or_create_candidate(db, phone)
    
    # Setup state
    crud.update_candidate_state(db, candidate.id, chatbot.STATE_AWAITING_CV)
    crud.update_candidate_language(db, candidate.id, 'en')
    db.commit()
    db.refresh(candidate)

    response = await chatbot._route_by_state(db, candidate, "what are the available vacancies?", "en", chatbot.STATE_AWAITING_CV)
    print("----- ROUTE BY STATE RESPONSE -----")
    print(response)
    print("-----------------------------------")
    
    db.close()

if __name__ == "__main__":
    asyncio.run(test_vacancy_question())
