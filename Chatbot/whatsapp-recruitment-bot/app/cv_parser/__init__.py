"""
CV Parser Package
=================
Comprehensive CV/Resume parsing and extraction system.

Components:
- PDFParser: Extract text from PDF files
- TextExtractor: Regex-based text extraction (legacy)
- OCREngine: OCR for scanned documents and images
- IntelligentExtractor: LLM-powered accurate extraction
- DocumentProcessor: Unified processor for all document types
"""

from app.cv_parser.pdf_parser import pdf_parser, PDFParser
from app.cv_parser.text_extractor import text_extractor, TextExtractor, CVData
from app.cv_parser.ocr_engine import get_ocr_engine, OCREngine
from app.cv_parser.intelligent_extractor import (
    get_intelligent_extractor, 
    IntelligentCVExtractor, 
    ExtractedCVData
)
from app.cv_parser.document_processor import (
    get_document_processor, 
    DocumentProcessor, 
    ProcessingResult
)

__all__ = [
    # PDF Parser
    'pdf_parser',
    'PDFParser',
    
    # Text Extractor (legacy)
    'text_extractor',
    'TextExtractor',
    'CVData',
    
    # OCR Engine
    'get_ocr_engine',
    'OCREngine',
    
    # Intelligent Extractor
    'get_intelligent_extractor',
    'IntelligentCVExtractor',
    'ExtractedCVData',
    
    # Document Processor
    'get_document_processor',
    'DocumentProcessor',
    'ProcessingResult',
]
