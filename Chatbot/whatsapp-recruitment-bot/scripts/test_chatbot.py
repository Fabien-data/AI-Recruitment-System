"""
Test Script
===========
Test the chatbot locally without WhatsApp integration.
Simulates a conversation in the terminal.
"""

import sys
import os
import asyncio

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal, init_db
from app.chatbot import chatbot


async def simulate_conversation():
    """Simulate a conversation with the chatbot."""
    
    print("=" * 60)
    print("WhatsApp Recruitment Chatbot - Test Mode")
    print("=" * 60)
    print("Type 'quit' or 'exit' to end the conversation")
    print("Type 'reset' to start a new conversation")
    print("-" * 60)
    
    # Initialize database
    try:
        init_db()
    except Exception as e:
        print(f"Warning: Database initialization issue: {e}")
    
    db = SessionLocal()
    test_phone = "+94771234567"  # Test phone number
    
    print(f"\n[Simulating user: {test_phone}]\n")
    
    while True:
        try:
            # Get user input
            user_input = input("You: ").strip()
            
            if not user_input:
                continue
            
            if user_input.lower() in ['quit', 'exit']:
                print("\nGoodbye! 👋")
                break
            
            if user_input.lower() == 'reset':
                # Reset by using a new phone number
                test_phone = f"+9477{hash(str(os.urandom(8))) % 10000000:07d}"
                print(f"\n[New session started: {test_phone}]\n")
                continue
            
            # Process message
            response = await chatbot.process_message(
                db=db,
                phone_number=test_phone,
                message_text=user_input
            )
            
            print(f"\nBot: {response}\n")
            
        except KeyboardInterrupt:
            print("\n\nInterrupted. Goodbye! 👋")
            break
        except Exception as e:
            print(f"\nError: {e}\n")
    
    db.close()


def test_cv_processing():
    """Test CV processing with a sample file."""
    from app.cv_parser.text_extractor import text_extractor
    
    print("=" * 60)
    print("CV Processing Test")
    print("=" * 60)
    
    # Sample CV text
    sample_cv = """
    JOHN DOE
    Software Engineer
    
    Email: john.doe@email.com
    Phone: +94 77 123 4567
    
    EDUCATION
    Bachelor of Science in Computer Science
    University of Colombo, 2020
    
    SKILLS
    Python, JavaScript, React, Node.js, SQL, Docker
    
    EXPERIENCE
    Software Developer at Tech Corp (2020 - Present)
    - Developed web applications
    - 3 years of experience
    
    LANGUAGES
    English, Sinhala
    """
    
    print("Extracting information from sample CV...")
    cv_data = text_extractor.extract_from_text(sample_cv)
    
    print("\nExtracted Data:")
    print(f"  Name: {cv_data.name}")
    print(f"  Email: {cv_data.email}")
    print(f"  Phone: {cv_data.phone}")
    print(f"  Qualification: {cv_data.highest_qualification}")
    print(f"  Skills: {cv_data.skills}")
    print(f"  Experience: {cv_data.experience_years} years")
    print(f"  Languages: {cv_data.languages}")
    print(f"  Missing Fields: {cv_data.missing_fields}")


def test_language_detection():
    """Test language detection."""
    from app.nlp.language_detector import detect_language
    
    print("=" * 60)
    print("Language Detection Test")
    print("=" * 60)
    
    test_messages = [
        ("Hello, I want to apply for a job", "Expected: en"),
        ("ආයුබෝවන්, මට රැකියාවකට අයදුම් කරන්න ඕනේ", "Expected: si"),
        ("வணக்கம், நான் வேலைக்கு விண்ணப்பிக்க விரும்புகிறேன்", "Expected: ta"),
        ("Kohomada, oyata job ekak thiyenawada?", "Expected: si (transliterated)"),
    ]
    
    for text, expected in test_messages:
        lang, confidence = detect_language(text)
        print(f"\n'{text[:50]}...'")
        print(f"  Detected: {lang} (confidence: {confidence:.2f}) - {expected}")


def test_sentiment_analysis():
    """Test sentiment analysis."""
    from app.nlp.sentiment_analyzer import analyze_sentiment
    
    print("=" * 60)
    print("Sentiment Analysis Test")
    print("=" * 60)
    
    test_messages = [
        "Thank you so much for your help!",
        "This is useless, I've been waiting forever!",
        "I would like to know about the job opening",
        "What the hell is wrong with this system?!",
    ]
    
    for text in test_messages:
        result = analyze_sentiment(text)
        print(f"\n'{text}'")
        print(f"  Score: {result.score:.2f}, Label: {result.label}")
        print(f"  Profanity: {result.has_profanity}, Aggressive: {result.is_aggressive}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        command = sys.argv[1].lower()
        
        if command == 'cv':
            test_cv_processing()
        elif command == 'lang':
            test_language_detection()
        elif command == 'sentiment':
            test_sentiment_analysis()
        else:
            print(f"Unknown command: {command}")
            print("Available commands: cv, lang, sentiment")
    else:
        # Run interactive conversation
        asyncio.run(simulate_conversation())
