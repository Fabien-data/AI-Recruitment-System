"""
Knowledge Base Loader
=====================
Loads documents into the knowledge base (Pinecone vector DB).
Use this to index your company FAQs, job descriptions, and policies.
"""

import sys
import os
import hashlib
import json
from typing import List, Dict

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import SessionLocal
from app.llm.rag_engine import rag_engine
from app.crud import create_knowledge_base_entry, get_knowledge_base_by_hash


# Sample knowledge base content - REPLACE WITH YOUR ACTUAL CONTENT
SAMPLE_KNOWLEDGE_BASE = [
    {
        "doc_type": "faq",
        "title": "How to Apply",
        "content": """
        How to Apply for a Job:
        1. Send your CV (PDF or Word format) via WhatsApp
        2. Our AI assistant will extract your information
        3. Provide any missing details when asked
        4. Your application will be reviewed by our HR team
        5. We will contact you if you're shortlisted
        
        Documents accepted: PDF, DOC, DOCX
        Languages supported: English, Sinhala, Tamil
        """
    },
    {
        "doc_type": "faq",
        "title": "Contact Information",
        "content": """
        Contact Us:
        - WhatsApp: This chat
        - Email: careers@yourcompany.com
        - Website: www.yourcompany.com/careers
        - Office Hours: Monday to Friday, 9 AM - 5 PM
        
        For urgent matters, please email us directly.
        """
    },
    {
        "doc_type": "faq",
        "title": "Application Status",
        "content": """
        Checking Application Status:
        - After submitting your CV, you'll receive a confirmation
        - Our HR team reviews applications within 5-7 business days
        - If shortlisted, you'll be contacted for an interview
        - You can ask this chatbot about your application status anytime
        
        Please note: Due to the volume of applications, we may not be able to 
        respond to every candidate individually.
        """
    },
    {
        "doc_type": "policy",
        "title": "Privacy Policy",
        "content": """
        Your Privacy Matters:
        - We only collect information necessary for the recruitment process
        - Your CV and personal data are stored securely
        - We do not share your information with third parties
        - You can request deletion of your data at any time
        - All conversations are confidential
        
        By submitting your CV, you consent to our data processing for 
        recruitment purposes.
        """
    },
    {
        "doc_type": "job_desc",
        "title": "General Requirements",
        "content": """
        General Job Requirements:
        - Most positions require a minimum of O/L or A/L qualifications
        - Technical roles may require specific degrees or certifications
        - We welcome fresh graduates and experienced professionals
        - Good communication skills are essential
        - Fluency in English, Sinhala, or Tamil is acceptable
        
        Specific requirements vary by position. Ask about a specific role 
        for more details.
        """
    }
]


def load_knowledge_base(documents: List[Dict] = None):
    """
    Load documents into the knowledge base.
    
    Args:
        documents: List of documents with doc_type, title, and content
    """
    if documents is None:
        documents = SAMPLE_KNOWLEDGE_BASE
    
    db = SessionLocal()
    
    print(f"Loading {len(documents)} documents into knowledge base...")
    
    success_count = 0
    skip_count = 0
    error_count = 0
    
    for i, doc in enumerate(documents):
        try:
            content = doc['content'].strip()
            content_hash = hashlib.sha256(content.encode()).hexdigest()
            
            # Check if already exists
            existing = get_knowledge_base_by_hash(db, content_hash)
            if existing:
                print(f"  [{i+1}] Skipping (duplicate): {doc['title']}")
                skip_count += 1
                continue
            
            # Generate doc_id
            doc_id = f"{doc['doc_type']}_{i}_{content_hash[:8]}"
            
            # Index in vector DB
            indexed = rag_engine.index_document(
                doc_id=doc_id,
                text=content,
                metadata={
                    "doc_type": doc['doc_type'],
                    "title": doc['title']
                }
            )
            
            if indexed:
                # Save metadata to MySQL
                create_knowledge_base_entry(
                    db=db,
                    doc_id=doc_id,
                    doc_type=doc['doc_type'],
                    title=doc['title'],
                    content=content,
                    content_hash=content_hash,
                    embedding_id=doc_id
                )
                print(f"  ✓ [{i+1}] Indexed: {doc['title']}")
                success_count += 1
            else:
                print(f"  ! [{i+1}] Vector DB unavailable, saved metadata only: {doc['title']}")
                # Save metadata anyway
                create_knowledge_base_entry(
                    db=db,
                    doc_id=doc_id,
                    doc_type=doc['doc_type'],
                    title=doc['title'],
                    content=content,
                    content_hash=content_hash,
                    embedding_id=""
                )
                success_count += 1
                
        except Exception as e:
            print(f"  ✗ [{i+1}] Error: {doc['title']} - {e}")
            error_count += 1
    
    db.close()
    
    print(f"\nSummary:")
    print(f"  ✓ Loaded: {success_count}")
    print(f"  ○ Skipped: {skip_count}")
    print(f"  ✗ Errors: {error_count}")


def load_from_json_file(filepath: str):
    """
    Load knowledge base from a JSON file.
    
    Expected format:
    [
        {"doc_type": "faq", "title": "...", "content": "..."},
        ...
    ]
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        documents = json.load(f)
    
    load_knowledge_base(documents)


if __name__ == "__main__":
    print("=" * 50)
    print("Knowledge Base Loader")
    print("=" * 50)
    
    if len(sys.argv) > 1:
        # Load from provided JSON file
        filepath = sys.argv[1]
        print(f"Loading from: {filepath}")
        load_from_json_file(filepath)
    else:
        # Load sample data
        print("Loading sample knowledge base...")
        print("(Provide a JSON file path to load custom content)")
        load_knowledge_base()
    
    print("\n✓ Knowledge base loading complete!")
