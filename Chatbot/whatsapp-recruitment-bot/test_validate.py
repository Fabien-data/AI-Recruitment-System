import sys
import os
import json
import asyncio

from dotenv import load_dotenv
load_dotenv('.env')

os.environ['META_VERIFY_TOKEN'] = 'dev'
os.environ['META_APP_SECRET'] = 'dev'
os.environ['DATABASE_URL'] = 'sqlite:///./recruitment_chatbot.db'

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '.')))

from app.llm.rag_engine import rag_engine

async def main():
    print("Testing 'Security job'")
    res = await rag_engine.validate_intake_answer_async('job_interest', 'Security job', 'en')
    print(json.dumps(res, indent=2))
    
if __name__ == '__main__':
    asyncio.run(main())
