"""
Database Initialization Script
==============================
Creates database tables and adds initial data.
Run this script after setting up your MySQL database.
"""

import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import engine, Base, SessionLocal
from app.models import Candidate, Conversation, Application, KnowledgeBaseMetadata


def create_tables():
    """Create all database tables."""
    print("Creating database tables...")
    Base.metadata.create_all(bind=engine)
    print("✓ Tables created successfully!")


def verify_tables():
    """Verify tables exist."""
    from sqlalchemy import inspect
    
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    
    expected_tables = ['candidates', 'conversations', 'applications', 'knowledge_base_metadata']
    
    print("\nVerifying tables:")
    for table in expected_tables:
        if table in tables:
            print(f"  ✓ {table}")
        else:
            print(f"  ✗ {table} - MISSING!")


def show_table_info():
    """Show table column information."""
    from sqlalchemy import inspect
    
    inspector = inspect(engine)
    
    print("\nTable schemas:")
    for table_name in inspector.get_table_names():
        print(f"\n{table_name}:")
        for column in inspector.get_columns(table_name):
            nullable = "NULL" if column['nullable'] else "NOT NULL"
            print(f"  - {column['name']}: {column['type']} {nullable}")


if __name__ == "__main__":
    print("=" * 50)
    print("WhatsApp Recruitment Chatbot - Database Setup")
    print("=" * 50)
    
    try:
        create_tables()
        verify_tables()
        show_table_info()
        print("\n✓ Database initialization complete!")
    except Exception as e:
        print(f"\n✗ Error: {e}")
        sys.exit(1)
