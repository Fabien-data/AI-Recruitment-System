"""
Passenger WSGI Entry Point
==========================
Entry point for Passenger on shared hosting (Serverbyt).
"""

import sys
import os

# Add app directory to Python path
sys.path.insert(0, os.path.dirname(__file__))

# Import the FastAPI app
from app.main import app as application

# For compatibility with some WSGI servers
if __name__ == "__main__":
    from uvicorn import run
    run(application, host="0.0.0.0", port=8000)
