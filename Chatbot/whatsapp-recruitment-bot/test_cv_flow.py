import asyncio
from app.database import SessionLocal
from app.chatbot import ChatbotEngine
from app import crud

async def run():
    db = SessionLocal()
    bot = ChatbotEngine()
    
    phone = "919012345678"
    cand = crud.get_or_create_candidate(db, phone)
    cand.conversation_state = bot.STATE_COLLECTING_JOB_REQS
    cand.extracted_data = {
        "job_interest": "Nurse",
        "pending_job_reqs": ["passport_status"],
        "early_cv_path": "uploads/dummy.pdf"
    }
    db.commit()
    
    res = await bot.process_message(db, phone, message_text="Yes, valid till 2030")
    print(res)

if __name__ == '__main__':
    asyncio.run(run())
