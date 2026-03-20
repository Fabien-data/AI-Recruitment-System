import sys
import os
import json
import asyncio

# Ensure app is in path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '.')))

from dotenv import load_dotenv
load_dotenv('.env')

from app.llm.rag_engine import rag_engine

def test_validation():
    print("Testing Job Interest: '1'")
    res = rag_engine.validate_intake_answer('job_interest', '1', 'en')
    print(json.dumps(res, indent=2))
    
    print("\nTesting Destination Country: 'Driver'")
    res = rag_engine.validate_intake_answer('destination_country', 'Driver', 'en')
    print(json.dumps(res, indent=2))
    
    print("\nTesting Experience Years: 'Dubai'")
    res = rag_engine.validate_intake_answer('experience_years', 'Dubai', 'en')
    print(json.dumps(res, indent=2))

if __name__ == "__main__":
    if not rag_engine.openai_client:
        print("OpenAI client not initialized!")
    else:
        test_validation()
