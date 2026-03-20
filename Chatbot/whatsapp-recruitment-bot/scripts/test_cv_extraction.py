"""
CV Extraction Test Script
=========================
Tests the accuracy of CV extraction using both the intelligent extractor
and OCR engines. Run this to validate extraction quality.
"""

import os
import sys
import json
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Set default environment variables if not present (for testing only)
os.environ.setdefault('META_ACCESS_TOKEN', 'test_token')
os.environ.setdefault('META_PHONE_NUMBER_ID', 'test_id')
os.environ.setdefault('META_APP_SECRET', 'test_secret')
os.environ.setdefault('META_VERIFY_TOKEN', 'test_verify')
os.environ.setdefault('OPENAI_API_KEY', os.environ.get('OPENAI_API_KEY', ''))
os.environ.setdefault('PINECONE_API_KEY', 'test_pinecone')
os.environ.setdefault('DATABASE_URL', 'sqlite:///test.db')

from dotenv import load_dotenv
load_dotenv()



def test_intelligent_extraction():
    """Test the intelligent LLM-based extraction."""
    print("\n" + "=" * 60)
    print("TESTING INTELLIGENT CV EXTRACTION")
    print("=" * 60)
    
    from app.cv_parser.intelligent_extractor import get_intelligent_extractor
    
    extractor = get_intelligent_extractor()
    
    # Sample CV text for testing
    sample_cv = """
    JOHN MICHAEL SMITH
    Software Engineer
    
    Contact Information:
    Email: john.smith@email.com
    Phone: +94 77 123 4567
    Address: 123 Main Street, Colombo 03, Sri Lanka
    LinkedIn: linkedin.com/in/johnsmith
    
    PROFESSIONAL SUMMARY
    Experienced software engineer with 5+ years of experience in full-stack development.
    Passionate about building scalable web applications and mentoring junior developers.
    
    WORK EXPERIENCE
    
    Senior Software Engineer | ABC Tech Solutions
    January 2021 - Present
    - Lead a team of 5 developers building microservices architecture
    - Reduced deployment time by 40% through CI/CD automation
    - Implemented React-based dashboard used by 10,000+ users
    
    Software Developer | XYZ Software
    June 2018 - December 2020
    - Developed RESTful APIs using Python and FastAPI
    - Built real-time notification system using WebSockets
    - Collaborated with product team on feature specifications
    
    EDUCATION
    
    Bachelor of Science in Computer Science
    University of Colombo
    2014 - 2018
    GPA: 3.7/4.0
    
    TECHNICAL SKILLS
    Programming: Python, JavaScript, TypeScript, Java
    Frameworks: React, Node.js, FastAPI, Django
    Databases: PostgreSQL, MongoDB, Redis
    Cloud: AWS, Docker, Kubernetes
    Tools: Git, JIRA, Confluence
    
    LANGUAGES
    - English (Fluent)
    - Sinhala (Native)
    - Tamil (Basic)
    
    CERTIFICATIONS
    - AWS Solutions Architect Associate (2022)
    - Certified Kubernetes Administrator (2021)
    
    REFERENCES
    Available upon request
    """
    
    print("\nExtracting data from sample CV...")
    result = extractor.extract_from_text(sample_cv)
    
    print("\n--- EXTRACTION RESULTS ---")
    print(f"\nPersonal Information:")
    print(f"  Name: {result.full_name} (confidence: {result.full_name_confidence:.1%})")
    print(f"  Email: {result.email} (confidence: {result.email_confidence:.1%})")
    print(f"  Phone: {result.phone} (confidence: {result.phone_confidence:.1%})")
    print(f"  Address: {result.address}")
    print(f"  LinkedIn: {result.linkedin_url}")
    
    print(f"\nProfessional Information:")
    print(f"  Current Title: {result.current_job_title}")
    print(f"  Current Company: {result.current_company}")
    print(f"  Experience: {result.total_experience_years} years")
    
    print(f"\nEducation:")
    print(f"  Highest: {result.highest_qualification}")
    if result.education_details:
        for edu in result.education_details:
            print(f"    - {edu.get('degree', 'N/A')} @ {edu.get('institution', 'N/A')}")
    
    print(f"\nSkills:")
    print(f"  Technical: {', '.join(result.technical_skills[:10])}")
    print(f"  Soft: {', '.join(result.soft_skills[:5])}")
    
    print(f"\nLanguages: {', '.join(result.languages_spoken)}")
    
    print(f"\nCertifications: {result.certifications}")
    
    print(f"\nExtraction Quality:")
    print(f"  Overall Confidence: {result.overall_confidence:.1%}")
    print(f"  Missing Critical Fields: {result.missing_critical_fields}")
    print(f"  Warnings: {result.warnings}")
    print(f"  Application Ready: {result.is_application_ready()}")
    
    return result


def test_document_processor():
    """Test the unified document processor."""
    print("\n" + "=" * 60)
    print("TESTING DOCUMENT PROCESSOR")
    print("=" * 60)
    
    from app.cv_parser.document_processor import get_document_processor
    
    processor = get_document_processor()
    
    # Test with sample text file content
    sample_cv = """
    SARAH JOHNSON
    Marketing Manager
    
    Email: sarah.j@company.com
    Phone: +1 555 987 6543
    
    EXPERIENCE
    Marketing Manager at Global Corp (2019-Present)
    - Led campaigns reaching 1M+ customers
    - Managed $500K annual budget
    
    Marketing Specialist at StartUp Inc (2016-2019)
    - Created content strategy
    - Grew social media by 200%
    
    EDUCATION
    MBA, Marketing - Stanford University (2016)
    BA, Communications - UCLA (2014)
    
    SKILLS
    Digital Marketing, SEO, Google Analytics, Social Media, Content Strategy
    """
    
    print("\nProcessing sample CV text...")
    result = processor.process_document(
        file_content=sample_cv.encode('utf-8'),
        filename="sarah_cv.txt",
        use_intelligent_extraction=True
    )
    
    print(f"\nProcessing Result:")
    print(f"  Success: {result.success}")
    print(f"  Text Source: {result.text_source}")
    print(f"  Text Confidence: {result.text_confidence:.1%}")
    print(f"  Extraction Confidence: {result.extraction_confidence:.1%}")
    
    if result.extracted_data:
        data = result.extracted_data
        print(f"\nExtracted Data:")
        print(f"  Name: {data.full_name}")
        print(f"  Email: {data.email}")
        print(f"  Phone: {data.phone}")
        print(f"  Qualification: {data.highest_qualification}")
        print(f"  Current Role: {data.current_job_title}")
        print(f"  Skills: {data.technical_skills}")
    
    if result.warnings:
        print(f"\nWarnings: {result.warnings}")
    
    return result


def test_ocr_capability():
    """Test OCR engine availability."""
    print("\n" + "=" * 60)
    print("TESTING OCR CAPABILITIES")
    print("=" * 60)
    
    from app.cv_parser.ocr_engine import get_ocr_engine, TESSERACT_AVAILABLE, OPENAI_AVAILABLE, PYMUPDF_AVAILABLE
    
    print(f"\nOCR Engine Status:")
    print(f"  Tesseract Available: {TESSERACT_AVAILABLE}")
    print(f"  OpenAI Vision Available: {OPENAI_AVAILABLE}")
    print(f"  PyMuPDF Available: {PYMUPDF_AVAILABLE}")
    
    if not OPENAI_AVAILABLE:
        print("\n⚠️ WARNING: OpenAI is not available. Intelligent extraction will not work.")
        print("   Make sure you have set OPENAI_API_KEY in your .env file.")
    
    if not TESSERACT_AVAILABLE:
        print("\n⚠️ WARNING: Tesseract is not available. OCR fallback will not work.")
        print("   Install Tesseract: https://github.com/tesseract-ocr/tesseract")
    
    ocr = get_ocr_engine()
    print(f"\n  OCR Engine initialized: {ocr is not None}")
    print(f"  OpenAI Client available: {ocr.openai_client is not None}")


def test_multilingual_cv():
    """Test extraction from multilingual CV (Sinhala/Tamil/English mix)."""
    print("\n" + "=" * 60)
    print("TESTING MULTILINGUAL CV EXTRACTION")
    print("=" * 60)
    
    from app.cv_parser.intelligent_extractor import get_intelligent_extractor
    
    extractor = get_intelligent_extractor()
    
    # Multilingual CV sample
    multilingual_cv = """
    නිමාල් පෙරේරා / Nimal Perera
    Technical Support Engineer
    
    Contact / සම්බන්ධ කරගන්න:
    Email: nimal.perera@email.lk
    Phone: 0771234567
    Address: 45/2, ගාලු පාර, කොළඹ 04
    
    Professional Summary / වෘත්තීය සාරාංශය:
    Experienced IT professional with 8 years of experience in technical support.
    සිංහල සහ English භාෂා දෙකෙන්ම ක්ෂේත්‍ර සහාය ලබා දීමට හැකියාව.
    
    Experience / පළපුරුද්ද:
    
    Senior Technical Support Engineer
    Dialog Axiata PLC
    2018 - Present
    
    IT Support Specialist
    Sri Lanka Telecom
    2015 - 2018
    
    Education / අධ්‍යාපනය:
    BSc in Information Technology
    University of Moratuwa
    2011 - 2015
    
    Skills / කුසලතා:
    Windows Server, Active Directory, Networking, Python, SQL
    
    Languages / භාෂා:
    - Sinhala (Native / මවු භාෂාව)
    - English (Fluent / දක්ෂ)
    - Tamil (Basic / මූලික)
    """
    
    print("\nExtracting from multilingual CV...")
    result = extractor.extract_from_text(multilingual_cv)
    
    print(f"\nResults:")
    print(f"  Name: {result.full_name}")
    print(f"  Email: {result.email}")
    print(f"  Phone: {result.phone}")
    print(f"  Experience: {result.total_experience_years} years")
    print(f"  Languages: {result.languages_spoken}")
    print(f"  Skills: {result.technical_skills}")
    print(f"  Confidence: {result.overall_confidence:.1%}")
    
    return result


def run_all_tests():
    """Run all extraction tests."""
    print("\n" + "=" * 60)
    print("CV EXTRACTION ACCURACY TESTS")
    print("=" * 60)
    
    # Test OCR capabilities first
    test_ocr_capability()
    
    try:
        # Test intelligent extraction
        test_intelligent_extraction()
    except Exception as e:
        print(f"\n❌ Intelligent extraction test failed: {e}")
    
    try:
        # Test document processor
        test_document_processor()
    except Exception as e:
        print(f"\n❌ Document processor test failed: {e}")
    
    try:
        # Test multilingual
        test_multilingual_cv()
    except Exception as e:
        print(f"\n❌ Multilingual test failed: {e}")
    
    print("\n" + "=" * 60)
    print("TESTS COMPLETE")
    print("=" * 60)


if __name__ == "__main__":
    run_all_tests()
