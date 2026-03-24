"""
Intelligent CV Extractor
========================
Uses LLM (GPT-4) for highly accurate structured data extraction from CV text.
This provides much better accuracy than regex-based extraction.
"""

import logging
import json
from typing import Optional, Dict, Any, List, Tuple
from dataclasses import dataclass, asdict, field
from datetime import datetime

logger = logging.getLogger(__name__)

# Try to import OpenAI
try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    logger.warning("OpenAI not available for intelligent extraction")


@dataclass
class ExtractedCVData:
    """
    Comprehensive CV data structure with confidence scores.
    All fields include both value and confidence for validation.
    """
    # Personal Information
    full_name: Optional[str] = None
    full_name_confidence: float = 0.0
    
    email: Optional[str] = None
    email_confidence: float = 0.0
    
    phone: Optional[str] = None
    phone_confidence: float = 0.0
    
    address: Optional[str] = None
    address_confidence: float = 0.0
    
    date_of_birth: Optional[str] = None
    date_of_birth_confidence: float = 0.0
    
    age: Optional[int] = None
    age_confidence: float = 0.0
    
    height_cm: Optional[float] = None
    height_cm_confidence: float = 0.0
    
    gender: Optional[str] = None
    gender_confidence: float = 0.0
    
    nationality: Optional[str] = None
    nationality_confidence: float = 0.0
    
    # Professional Information
    current_job_title: Optional[str] = None
    current_job_title_confidence: float = 0.0
    
    current_company: Optional[str] = None
    current_company_confidence: float = 0.0
    
    total_experience_years: Optional[float] = None
    total_experience_years_confidence: float = 0.0
    
    notice_period: Optional[str] = None
    notice_period_confidence: float = 0.0
    
    expected_salary: Optional[str] = None
    expected_salary_confidence: float = 0.0
    
    # Education
    highest_qualification: Optional[str] = None
    highest_qualification_confidence: float = 0.0
    
    education_details: List[Dict[str, Any]] = field(default_factory=list)
    
    # Skills
    technical_skills: List[str] = field(default_factory=list)
    soft_skills: List[str] = field(default_factory=list)
    languages_spoken: List[str] = field(default_factory=list)
    
    # Work Experience
    work_history: List[Dict[str, Any]] = field(default_factory=list)
    
    # Certifications and Achievements
    certifications: List[str] = field(default_factory=list)
    achievements: List[str] = field(default_factory=list)
    
    # References
    references: List[Dict[str, Any]] = field(default_factory=list)
    
    # Additional Information
    profile_summary: Optional[str] = None
    linkedin_url: Optional[str] = None
    portfolio_url: Optional[str] = None
    
    # AI Insights
    candidate_summary: Optional[str] = None
    candidate_match_score: Optional[int] = None
    ai_insights: List[str] = field(default_factory=list)
    suggested_roles: List[str] = field(default_factory=list)
    
    # Metadata
    raw_text: Optional[str] = None
    extraction_method: str = "llm"
    extraction_timestamp: Optional[str] = None
    overall_confidence: float = 0.0
    missing_critical_fields: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)
    
    def get_required_fields_status(self) -> Dict[str, bool]:
        """Get status of required fields for job application."""
        return {
            'full_name': bool(self.full_name),
            'email': bool(self.email),
            'phone': bool(self.phone),
            'highest_qualification': bool(self.highest_qualification),
        }
    
    def is_application_ready(self) -> bool:
        """Check if CV has all required fields for application."""
        status = self.get_required_fields_status()
        return all(status.values())


class IntelligentCVExtractor:
    """
    Intelligent CV extractor using LLM for accurate structured data extraction.
    Provides much better accuracy than regex-based extraction.
    """
    
    # Extraction prompt template
    EXTRACTION_PROMPT = '''You are an expert HR assistant specialized in extracting structured information from CV/Resume documents.

Analyze the following CV text and extract ALL available information into the specified JSON format.
Be thorough and accurate. If information is not clearly stated, mark confidence as low.

IMPORTANT:
1. Extract EXACTLY what is written - do not infer or guess
2. For each field, provide a confidence score (0.0-1.0) based on clarity
3. Standardize phone numbers to include country code if possible
4. Standardize email to lowercase
5. For experience years, calculate from work history if not explicitly stated
6. List ALL skills mentioned, categorized as technical and soft skills
7. Extract education in reverse chronological order (most recent first)
8. Extract work history in reverse chronological order
9. If date of birth is mentioned, calculate age. If height is mentioned, extract it in cm (convert if necessary).

CV TEXT:
---
{cv_text}
---

Return ONLY a valid JSON object with this exact structure:
{{
    "personal_info": {{
        "full_name": {{"value": "string or null", "confidence": 0.0-1.0}},
        "email": {{"value": "string or null", "confidence": 0.0-1.0}},
        "phone": {{"value": "string or null", "confidence": 0.0-1.0}},
        "address": {{"value": "string or null", "confidence": 0.0-1.0}},
        "date_of_birth": {{"value": "string or null", "confidence": 0.0-1.0}},
        "gender": {{"value": "string or null", "confidence": 0.0-1.0}},
        "nationality": {{"value": "string or null", "confidence": 0.0-1.0}},
        "linkedin_url": {{"value": "string or null", "confidence": 0.0-1.0}},
        "portfolio_url": {{"value": "string or null", "confidence": 0.0-1.0}},
        "age": {{"value": "number or null", "confidence": 0.0-1.0}},
        "height_cm": {{"value": "number or null", "confidence": 0.0-1.0}}
    }},
    "professional_info": {{
        "current_job_title": {{"value": "string or null", "confidence": 0.0-1.0}},
        "current_company": {{"value": "string or null", "confidence": 0.0-1.0}},
        "total_experience_years": {{"value": "number or null", "confidence": 0.0-1.0}},
        "notice_period": {{"value": "string or null", "confidence": 0.0-1.0}},
        "expected_salary": {{"value": "string or null", "confidence": 0.0-1.0}},
        "profile_summary": {{"value": "string or null", "confidence": 0.0-1.0}}
    }},
    "education": {{
        "highest_qualification": {{"value": "string or null", "confidence": 0.0-1.0}},
        "details": [
            {{
                "degree": "string",
                "institution": "string",
                "field_of_study": "string or null",
                "year_completed": "string or null",
                "grade": "string or null"
            }}
        ]
    }},
    "work_history": [
        {{
            "company": "string",
            "job_title": "string",
            "start_date": "string or null",
            "end_date": "string or null (use 'Present' if current)",
            "responsibilities": ["string"],
            "achievements": ["string"]
        }}
    ],
    "skills": {{
        "technical": ["string"],
        "soft": ["string"],
        "languages_spoken": ["string with proficiency level if mentioned"]
    }},
    "certifications": ["string"],
    "achievements": ["string"],
    "references": [
        {{
            "name": "string",
            "relationship": "string or null",
            "contact": "string or null"
        }}
    ],
    "ai_insights": {{
        "candidate_summary": "string (A short, compelling summarizing paragraph of candidate profile for recruiters)",
        "candidate_match_score": "number 0-100 indicating general resume and profile quality",
        "strengths_and_weaknesses": ["string (bullet points of insights including risks or strengths)"],
        "suggested_roles": ["string (job titles this candidate is highly suited for)"]
    }},
    "missing_critical_information": ["List of missing essential facts: e.g., 'full_name', 'email', 'phone', 'highest_qualification', 'years_experience' if not found"],
    "extraction_warnings": ["Any issues or unclear information found"]
}}

Remember: Return ONLY the JSON object, no other text.'''

    def __init__(self, openai_api_key: Optional[str] = None):
        """
        Initialize the intelligent extractor.
        
        Args:
            openai_api_key: OpenAI API key
        """
        self.openai_api_key = openai_api_key
        if openai_api_key and OPENAI_AVAILABLE:
            self.openai_client = openai.OpenAI(api_key=openai_api_key)
        else:
            self.openai_client = None
    
    def extract_from_text(self, cv_text: str) -> ExtractedCVData:
        """
        Extract structured CV data from text using LLM.
        
        Args:
            cv_text: Raw CV text content
            
        Returns:
            ExtractedCVData object with all extracted information
        """
        if not self.openai_client:
            logger.error("OpenAI client not available for intelligent extraction")
            return self._fallback_extraction(cv_text)
        
        try:
            # Call OpenAI for extraction
            response = self.openai_client.chat.completions.create(
                model="gpt-4o",  # Upgraded for better accuracy
                messages=[
                    {
                        "role": "system",
                        "content": "You are an expert CV parser. Extract information accurately and return valid JSON only."
                    },
                    {
                        "role": "user",
                        "content": self.EXTRACTION_PROMPT.format(cv_text=cv_text[:15000])  # Limit text
                    }
                ],
                response_format={"type": "json_object"}
            )
            
            # Parse the response
            json_str = response.choices[0].message.content
            extracted_json = json.loads(json_str)
            
            # Convert to ExtractedCVData
            return self._json_to_extracted_data(extracted_json, cv_text)
            
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse LLM response as JSON: {e}")
            return self._fallback_extraction(cv_text)
        except Exception as e:
            logger.error(f"Intelligent extraction failed: {e}")
            return self._fallback_extraction(cv_text)
    
    def _json_to_extracted_data(
        self, 
        json_data: Dict[str, Any], 
        raw_text: str
    ) -> ExtractedCVData:
        """Convert extracted JSON to ExtractedCVData object."""
        
        try:
            personal = json_data.get('personal_info', {})
            professional = json_data.get('professional_info', {})
            education = json_data.get('education', {})
            skills = json_data.get('skills', {})
            ai_insights = json_data.get('ai_insights', {})
            
            data = ExtractedCVData(
                # Personal Info
                full_name=self._get_value(personal, 'full_name'),
                full_name_confidence=self._get_confidence(personal, 'full_name'),
                email=self._get_value(personal, 'email'),
                email_confidence=self._get_confidence(personal, 'email'),
                phone=self._get_value(personal, 'phone'),
                phone_confidence=self._get_confidence(personal, 'phone'),
                address=self._get_value(personal, 'address'),
                address_confidence=self._get_confidence(personal, 'address'),
                date_of_birth=self._get_value(personal, 'date_of_birth'),
                date_of_birth_confidence=self._get_confidence(personal, 'date_of_birth'),
                age=self._get_value(personal, 'age'),
                age_confidence=self._get_confidence(personal, 'age'),
                height_cm=self._get_value(personal, 'height_cm'),
                height_cm_confidence=self._get_confidence(personal, 'height_cm'),
                gender=self._get_value(personal, 'gender'),
                gender_confidence=self._get_confidence(personal, 'gender'),
                nationality=self._get_value(personal, 'nationality'),
                nationality_confidence=self._get_confidence(personal, 'nationality'),
                linkedin_url=self._get_value(personal, 'linkedin_url'),
                portfolio_url=self._get_value(personal, 'portfolio_url'),
                
                # Professional Info
                current_job_title=self._get_value(professional, 'current_job_title'),
                current_job_title_confidence=self._get_confidence(professional, 'current_job_title'),
                current_company=self._get_value(professional, 'current_company'),
                current_company_confidence=self._get_confidence(professional, 'current_company'),
                total_experience_years=self._get_value(professional, 'total_experience_years'),
                total_experience_years_confidence=self._get_confidence(professional, 'total_experience_years'),
                notice_period=self._get_value(professional, 'notice_period'),
                notice_period_confidence=self._get_confidence(professional, 'notice_period'),
                expected_salary=self._get_value(professional, 'expected_salary'),
                expected_salary_confidence=self._get_confidence(professional, 'expected_salary'),
                profile_summary=self._get_value(professional, 'profile_summary'),
                
                # Education
                highest_qualification=self._get_value(education, 'highest_qualification'),
                highest_qualification_confidence=self._get_confidence(education, 'highest_qualification'),
                education_details=education.get('details', []),
                
                # Skills
                technical_skills=skills.get('technical', []),
                soft_skills=skills.get('soft', []),
                languages_spoken=skills.get('languages_spoken', []),
                
                # Work History
                work_history=json_data.get('work_history', []),
                
                # Others
                certifications=json_data.get('certifications', []),
                achievements=json_data.get('achievements', []),
                references=json_data.get('references', []),
                
                # AI Insights
                candidate_summary=ai_insights.get('candidate_summary'),
                candidate_match_score=ai_insights.get('candidate_match_score'),
                ai_insights=ai_insights.get('strengths_and_weaknesses', []),
                suggested_roles=ai_insights.get('suggested_roles', []),
                
                # Metadata
                raw_text=raw_text,
                extraction_method="llm",
                extraction_timestamp=datetime.utcnow().isoformat(),
                warnings=json_data.get('extraction_warnings', []),
                missing_critical_fields=json_data.get('missing_critical_information', [])
            )
            
            # Calculate overall confidence
            data.overall_confidence = self._calculate_overall_confidence(data)
            
            # Merge with explicitly missing fields if any dynamically calculated are missing
            computed_missing = self._get_missing_critical_fields(data)
            for field in computed_missing:
                if field not in data.missing_critical_fields:
                    data.missing_critical_fields.append(field)
            
            logger.info(
                f"Intelligent extraction complete: "
                f"name={data.full_name}, email={data.email}, "
                f"confidence={data.overall_confidence:.2f}, "
                f"missing={data.missing_critical_fields}"
            )
            
            return data
            
        except Exception as e:
            logger.error(f"Error converting JSON to ExtractedCVData: {e}")
            return ExtractedCVData(
                raw_text=raw_text,
                extraction_method="llm_partial",
                warnings=[f"Partial extraction due to error: {str(e)}"]
            )
    
    def _get_value(self, obj: Dict, key: str) -> Any:
        """Get value from nested structure."""
        item = obj.get(key, {})
        if isinstance(item, dict):
            return item.get('value')
        return item
    
    def _get_confidence(self, obj: Dict, key: str) -> float:
        """Get confidence from nested structure."""
        item = obj.get(key, {})
        if isinstance(item, dict):
            return float(item.get('confidence', 0.0))
        return 0.0
    
    def _calculate_overall_confidence(self, data: ExtractedCVData) -> float:
        """Calculate overall extraction confidence."""
        confidences = [
            data.full_name_confidence,
            data.email_confidence,
            data.phone_confidence,
            data.highest_qualification_confidence,
        ]
        
        valid_confidences = [c for c in confidences if c > 0]
        if not valid_confidences:
            return 0.0
        
        return sum(valid_confidences) / len(valid_confidences)
    
    def _get_missing_critical_fields(self, data: ExtractedCVData) -> List[str]:
        """Get list of missing critical fields."""
        missing = []
        
        if not data.full_name:
            missing.append('full_name')
        if not data.email:
            missing.append('email')
        if not data.phone:
            missing.append('phone')
        if not data.highest_qualification:
            missing.append('highest_qualification')
        
        return missing
    
    def _fallback_extraction(self, cv_text: str) -> ExtractedCVData:
        """Fallback to regex-based extraction when LLM is not available."""
        from app.cv_parser.text_extractor import text_extractor
        
        basic_data = text_extractor.extract_from_text(cv_text)
        
        return ExtractedCVData(
            full_name=basic_data.name,
            full_name_confidence=0.6 if basic_data.name else 0.0,
            email=basic_data.email,
            email_confidence=0.9 if basic_data.email else 0.0,
            phone=basic_data.phone,
            phone_confidence=0.8 if basic_data.phone else 0.0,
            highest_qualification=basic_data.highest_qualification,
            highest_qualification_confidence=0.5 if basic_data.highest_qualification else 0.0,
            technical_skills=basic_data.skills.split(', ') if basic_data.skills else [],
            languages_spoken=basic_data.languages or [],
            raw_text=cv_text,
            extraction_method="regex_fallback",
            extraction_timestamp=datetime.utcnow().isoformat(),
            missing_critical_fields=basic_data.missing_fields or []
        )


# Factory function
def create_intelligent_extractor() -> IntelligentCVExtractor:
    """Create intelligent extractor with configuration from settings."""
    from app.config import settings
    return IntelligentCVExtractor(openai_api_key=settings.openai_api_key)


# Lazy-loaded singleton
_intelligent_extractor: Optional[IntelligentCVExtractor] = None

def get_intelligent_extractor() -> IntelligentCVExtractor:
    """Get or create the intelligent extractor singleton."""
    global _intelligent_extractor
    if _intelligent_extractor is None:
        _intelligent_extractor = create_intelligent_extractor()
    return _intelligent_extractor
