"""
PDF Parser
==========
Extracts text content from PDF files using PyMuPDF.
"""

import logging
from typing import Optional, List
from pathlib import Path

logger = logging.getLogger(__name__)

# Try to import PyMuPDF
try:
    import fitz  # PyMuPDF
    PYMUPDF_AVAILABLE = True
except ImportError:
    PYMUPDF_AVAILABLE = False
    logger.warning("PyMuPDF not available, PDF parsing will be limited")


class PDFParser:
    """
    Parses PDF files and extracts text content.
    Uses PyMuPDF (fitz) for extraction.
    """
    
    def __init__(self):
        if not PYMUPDF_AVAILABLE:
            logger.warning("PDFParser initialized but PyMuPDF is not available")
    
    def extract_text(self, file_path: str) -> Optional[str]:
        """
        Extract text from a PDF file.
        
        Args:
            file_path: Path to the PDF file
            
        Returns:
            Extracted text or None if failed
        """
        if not PYMUPDF_AVAILABLE:
            logger.error("PyMuPDF not available")
            return None
        
        try:
            doc = fitz.open(file_path)
            text_parts = []
            
            for page_num in range(len(doc)):
                page = doc[page_num]
                text = page.get_text("text")
                if text.strip():
                    text_parts.append(text)
            
            doc.close()
            
            full_text = "\n".join(text_parts)
            logger.info(f"Extracted {len(full_text)} characters from PDF: {file_path}")
            return full_text
            
        except Exception as e:
            logger.error(f"Failed to extract text from PDF {file_path}: {e}")
            return None
    
    def extract_text_from_bytes(self, file_bytes: bytes) -> Optional[str]:
        """
        Extract text from PDF bytes.
        
        Args:
            file_bytes: PDF file content as bytes
            
        Returns:
            Extracted text or None if failed
        """
        if not PYMUPDF_AVAILABLE:
            logger.error("PyMuPDF not available")
            return None
        
        try:
            doc = fitz.open(stream=file_bytes, filetype="pdf")
            text_parts = []
            
            for page_num in range(len(doc)):
                page = doc[page_num]
                text = page.get_text("text")
                if text.strip():
                    text_parts.append(text)
            
            doc.close()
            
            full_text = "\n".join(text_parts)
            logger.info(f"Extracted {len(full_text)} characters from PDF bytes")
            return full_text
            
        except Exception as e:
            logger.error(f"Failed to extract text from PDF bytes: {e}")
            return None
    
    def get_page_count(self, file_path: str) -> int:
        """Get the number of pages in a PDF."""
        if not PYMUPDF_AVAILABLE:
            return 0
        
        try:
            doc = fitz.open(file_path)
            count = len(doc)
            doc.close()
            return count
        except Exception:
            return 0
    
    def extract_images(self, file_path: str) -> List[bytes]:
        """
        Extract images from a PDF file.
        Useful for CVs with embedded images (photos, certificates).
        
        Args:
            file_path: Path to the PDF file
            
        Returns:
            List of image bytes
        """
        if not PYMUPDF_AVAILABLE:
            return []
        
        images = []
        
        try:
            doc = fitz.open(file_path)
            
            for page_num in range(len(doc)):
                page = doc[page_num]
                image_list = page.get_images()
                
                for img_index, img in enumerate(image_list):
                    try:
                        xref = img[0]
                        base_image = doc.extract_image(xref)
                        image_bytes = base_image["image"]
                        images.append(image_bytes)
                    except Exception as e:
                        logger.debug(f"Failed to extract image {img_index} from page {page_num}: {e}")
            
            doc.close()
            logger.info(f"Extracted {len(images)} images from PDF: {file_path}")
            
        except Exception as e:
            logger.error(f"Failed to extract images from PDF {file_path}: {e}")
        
        return images


# Singleton instance
pdf_parser = PDFParser()
