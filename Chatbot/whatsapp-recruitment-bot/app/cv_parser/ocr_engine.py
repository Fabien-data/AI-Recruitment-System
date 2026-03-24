"""
OCR Engine
==========
Provides OCR capabilities for scanned documents and images using
multiple engines including Tesseract and OpenAI Vision API.
"""

import logging
import base64
import io
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path

logger = logging.getLogger(__name__)

# Try to import Tesseract OCR
try:
    import pytesseract
    from PIL import Image
    TESSERACT_AVAILABLE = True
except ImportError:
    TESSERACT_AVAILABLE = False
    logger.warning("pytesseract/PIL not available, Tesseract OCR will not work")

# Try to import OpenAI
try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    logger.warning("OpenAI not available, Vision-based OCR will not work")

# Try to import PyMuPDF for PDF to image conversion
try:
    import fitz
    PYMUPDF_AVAILABLE = True
except ImportError:
    PYMUPDF_AVAILABLE = False
    logger.warning("PyMuPDF not available, PDF image extraction will be limited")


class OCREngine:
    """
    Optical Character Recognition Engine.
    Provides multiple OCR backends for maximum accuracy:
    1. Tesseract OCR - Local, fast, good for clean documents
    2. OpenAI Vision API (GPT-4o) - Cloud, highly accurate, handles complex layouts
    """
    
    # Tesseract language codes
    TESSERACT_LANGS = {
        'en': 'eng',
        'si': 'sin',  # Sinhala
        'ta': 'tam',  # Tamil
    }
    
    def __init__(self, openai_api_key: Optional[str] = None):
        """
        Initialize OCR Engine.
        
        Args:
            openai_api_key: OpenAI API key for Vision API
        """
        self.openai_api_key = openai_api_key
        if openai_api_key and OPENAI_AVAILABLE:
            self.openai_client = openai.OpenAI(api_key=openai_api_key)
        else:
            self.openai_client = None
    
    def extract_text_from_image(
        self, 
        image_bytes: bytes,
        use_openai: bool = True,
        language: str = 'en'
    ) -> Tuple[str, float]:
        """
        Extract text from an image using best available OCR.
        
        Args:
            image_bytes: Image content as bytes
            use_openai: Whether to use OpenAI Vision API (more accurate)
            language: Expected language of the document
            
        Returns:
            Tuple of (extracted_text, confidence_score)
        """
        # Try OpenAI Vision first (most accurate)
        if use_openai and self.openai_client:
            text, confidence = self._extract_with_openai_vision(image_bytes)
            if text:
                return text, confidence
        
        # Fall back to Tesseract
        if TESSERACT_AVAILABLE:
            text, confidence = self._extract_with_tesseract(image_bytes, language)
            if text:
                return text, confidence
        
        logger.warning("No OCR engine available for text extraction")
        return "", 0.0
    
    def extract_text_from_pdf_images(
        self,
        pdf_bytes: bytes,
        use_openai: bool = True,
        language: str = 'en'
    ) -> Tuple[str, float]:
        """
        Extract text from a PDF by converting pages to images and applying OCR.
        Useful for scanned PDFs that don't have embedded text.
        
        Args:
            pdf_bytes: PDF content as bytes
            use_openai: Whether to use OpenAI Vision API
            language: Expected language of the document
            
        Returns:
            Tuple of (extracted_text, confidence_score)
        """
        if not PYMUPDF_AVAILABLE:
            logger.error("PyMuPDF required for PDF image extraction")
            return "", 0.0
        
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            all_text = []
            total_confidence = 0.0
            page_count = 0
            
            for page_num in range(len(doc)):
                page = doc[page_num]
                
                # Convert page to high-resolution image
                mat = fitz.Matrix(2.0, 2.0)  # 2x scale for better OCR
                pix = page.get_pixmap(matrix=mat)
                img_bytes = pix.tobytes("png")
                
                # Extract text from the image
                text, confidence = self.extract_text_from_image(
                    img_bytes, use_openai, language
                )
                
                if text:
                    all_text.append(f"--- Page {page_num + 1} ---\n{text}")
                    total_confidence += confidence
                    page_count += 1
            
            doc.close()
            
            combined_text = "\n\n".join(all_text)
            avg_confidence = total_confidence / page_count if page_count > 0 else 0.0
            
            return combined_text, avg_confidence
            
        except Exception as e:
            logger.error(f"Failed to extract text from PDF with OCR: {e}")
            return "", 0.0
    
    def _extract_with_openai_vision(
        self, 
        image_bytes: bytes
    ) -> Tuple[str, float]:
        """
        Extract text using OpenAI's Vision API (GPT-4o).
        This provides superior accuracy, especially for complex layouts.
        
        Args:
            image_bytes: Image content as bytes
            
        Returns:
            Tuple of (extracted_text, confidence_score)
        """
        if not self.openai_client:
            return "", 0.0
        
        try:
            # Encode image to base64
            base64_image = base64.b64encode(image_bytes).decode('utf-8')
            
            # Determine image type
            if image_bytes[:4] == b'\x89PNG':
                media_type = "image/png"
            elif image_bytes[:2] == b'\xff\xd8':
                media_type = "image/jpeg"
            else:
                media_type = "image/png"  # Default
            
            response = self.openai_client.chat.completions.create(
                model="gpt-4o",
                messages=[
                    {
                        "role": "system",
                        "content": """You are an expert OCR system specialized in extracting text from CV/Resume documents.
Your task is to extract ALL text from the image exactly as it appears, preserving the structure and formatting.
Include all text you can see: names, contact information, education, work experience, skills, etc.
Return ONLY the extracted text, no commentary or explanations."""
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "Extract all text from this CV/Resume document. Preserve the structure and formatting as much as possible."
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": f"data:{media_type};base64,{base64_image}",
                                    "detail": "high"
                                }
                            }
                        ]
                    }
                ],
            )
            
            extracted_text = response.choices[0].message.content.strip()
            
            # High confidence for OpenAI Vision
            confidence = 0.95 if extracted_text else 0.0
            
            logger.info(f"OpenAI Vision extracted {len(extracted_text)} characters")
            return extracted_text, confidence
            
        except Exception as e:
            logger.error(f"OpenAI Vision OCR failed: {e}")
            return "", 0.0
    
    def _extract_with_tesseract(
        self, 
        image_bytes: bytes,
        language: str = 'en'
    ) -> Tuple[str, float]:
        """
        Extract text using Tesseract OCR.
        
        Args:
            image_bytes: Image content as bytes
            language: Language code for OCR
            
        Returns:
            Tuple of (extracted_text, confidence_score)
        """
        if not TESSERACT_AVAILABLE:
            return "", 0.0
        
        try:
            # Open image
            image = Image.open(io.BytesIO(image_bytes))
            
            # Preprocess image for better OCR results
            image = self._preprocess_image(image)
            
            # Get Tesseract language code
            tess_lang = self.TESSERACT_LANGS.get(language, 'eng')
            
            # Try with multiple language support
            try:
                lang_param = f"{tess_lang}+eng" if tess_lang != 'eng' else 'eng'
            except:
                lang_param = 'eng'
            
            # Perform OCR with detailed output for confidence
            data = pytesseract.image_to_data(
                image, 
                lang=lang_param,
                output_type=pytesseract.Output.DICT
            )
            
            # Extract text and calculate confidence
            texts = []
            confidences = []
            
            for i, text in enumerate(data['text']):
                conf = int(data['conf'][i])
                if conf > 0 and text.strip():
                    texts.append(text)
                    confidences.append(conf)
            
            extracted_text = ' '.join(texts)
            avg_confidence = sum(confidences) / len(confidences) / 100 if confidences else 0.0
            
            logger.info(f"Tesseract extracted {len(extracted_text)} chars, confidence: {avg_confidence:.2f}")
            return extracted_text, avg_confidence
            
        except Exception as e:
            logger.error(f"Tesseract OCR failed: {e}")
            return "", 0.0
    
    def _preprocess_image(self, image: 'Image.Image') -> 'Image.Image':
        """
        Preprocess image for better OCR results.
        
        Args:
            image: PIL Image object
            
        Returns:
            Preprocessed PIL Image
        """
        try:
            # Convert to RGB if necessary
            if image.mode != 'RGB':
                image = image.convert('RGB')
            
            # Resize if too small (OCR works better on larger images)
            min_size = 1000
            if min(image.size) < min_size:
                scale = min_size / min(image.size)
                new_size = (int(image.size[0] * scale), int(image.size[1] * scale))
                image = image.resize(new_size, Image.Resampling.LANCZOS)
            
            # Resize if too large (to avoid memory issues)
            max_size = 4000
            if max(image.size) > max_size:
                scale = max_size / max(image.size)
                new_size = (int(image.size[0] * scale), int(image.size[1] * scale))
                image = image.resize(new_size, Image.Resampling.LANCZOS)
            
            return image
            
        except Exception as e:
            logger.warning(f"Image preprocessing failed: {e}")
            return image
    
    def is_scanned_pdf(self, pdf_bytes: bytes) -> bool:
        """
        Check if a PDF is scanned (contains mainly images, little text).
        
        Args:
            pdf_bytes: PDF content as bytes
            
        Returns:
            True if PDF appears to be scanned
        """
        if not PYMUPDF_AVAILABLE:
            return False
        
        try:
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            total_text_len = 0
            total_images = 0
            
            for page in doc:
                text = page.get_text("text")
                total_text_len += len(text.strip())
                total_images += len(page.get_images())
            
            doc.close()
            
            # If very little text but has images, likely scanned
            if total_text_len < 100 and total_images > 0:
                return True
            
            # Ratio of text to images
            if total_images > 0 and total_text_len / total_images < 50:
                return True
            
            return False
            
        except Exception as e:
            logger.error(f"Failed to check if PDF is scanned: {e}")
            return False


# Factory function to create OCR engine with config
def create_ocr_engine() -> OCREngine:
    """Create OCR engine with configuration from settings."""
    from app.config import settings
    return OCREngine(openai_api_key=settings.openai_api_key)


# Lazy-loaded singleton
_ocr_engine: Optional[OCREngine] = None

def get_ocr_engine() -> OCREngine:
    """Get or create the OCR engine singleton."""
    global _ocr_engine
    if _ocr_engine is None:
        _ocr_engine = create_ocr_engine()
    return _ocr_engine
