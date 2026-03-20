import asyncio
from app.database import SessionLocal
from app.chatbot import ChatbotEngine
from app import crud

async def run():
    db = SessionLocal()
    bot = ChatbotEngine()
    
    phone = "919012345678"
    cand = crud.get_or_create_candidate(db, phone)
    cand.conversation_state = bot.STATE_AWAITING_CV
    db.commit()
    
    with open('uploads/cv_uploads/2026-03/919012345678_20260318_194342_cf8a6371.pdf', 'rb') as f:
        content = f.read()

    res = await bot.process_message(db, phone, message_text=None, media_content=content, media_type='document', media_filename='my_cv.pdf')
    print(res)

if __name__ == '__main__':
    asyncio.run(run())
