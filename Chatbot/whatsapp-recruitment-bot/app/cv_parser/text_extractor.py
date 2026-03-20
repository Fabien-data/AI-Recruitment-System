"""
Text Extractor
==============
Extracts and parses structured information from CV text.
Handles multiple file formats and uses NLP to extract key fields.
"""

import logging
import re
from typing import Optional, Dict, Any, List, Tuple
from pathlib import Path
from dataclasses import dataclass, asdict

logger = logging.getLogger(__name__)

# Try to import python-docx for Word documents
try:
    from docx import Document as DocxDocument
    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False
    logger.warning("python-docx not available, Word document parsing will be limited")

from app.cv_parser.pdf_parser import pdf_parser


@dataclass
class CVData:
    """Structured CV data."""
    name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    highest_qualification: Optional[str] = None
    skills: Optional[str] = None
    experience_years: Optional[int] = None
    current_company: Optional[str] = None
    current_position: Optional[str] = None
    notice_period: Optional[str] = None
    summary: Optional[str] = None
    education: Optional[List[str]] = None
    work_experience: Optional[List[str]] = None
    languages: Optional[List[str]] = None
    raw_text: Optional[str] = None
    missing_fields: Optional[List[str]] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)


class TextExtractor:
    """
    Extracts structured information from CV text.
    Supports PDF, Word documents, and plain text.
    """
    
    # Email pattern
    EMAIL_PATTERN = re.compile(
        r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'
    )
    
    # Phone patterns (international and local)
    PHONE_PATTERNS = [
        re.compile(r'\+?\d{1,3}[-.\s]?\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4}'),
        re.compile(r'\b0\d{9,10}\b'),  # Local format
        re.compile(r'\(\d{2,4}\)\s*\d{3,4}[-.\s]?\d{3,4}'),  # With area code
    ]
    
    # Education keywords
    EDUCATION_KEYWORDS = [
        'bachelor', 'master', 'phd', 'diploma', 'degree', 'bsc', 'msc',
        'mba', 'ba', 'ma', 'beng', 'meng', 'btech', 'mtech',
        'university', 'college', 'institute', 'school', 'academy',
        'o/l', 'a/l', 'o level', 'a level', 'gcse', 'hnc', 'hnd'
    ]
    
    # Skills keywords
    SKILLS_KEYWORDS = [
        'skill', 'proficient', 'expert', 'knowledge', 'experience in',
        'programming', 'language', 'framework', 'tool', 'software'
    ]
    
    # Experience keywords
    EXPERIENCE_KEYWORDS = [
        'experience', 'work history', 'employment', 'career',
        'position', 'role', 'job', 'worked at', 'worked as'
    ]
    
    # Required fields for a complete application
    REQUIRED_FIELDS = ['name', 'email', 'phone', 'highest_qualification']
    
    def __init__(self):
        pass
    
    def extract_from_file(self, file_path: str) -> CVData:
        """
        Extract CV data from a file.
        
        Args:
            file_path: Path to the CV file
            
        Returns:
            CVData object with extracted information
        """
        path = Path(file_path)
        ext = path.suffix.lower()
        
        text = None
        
        if ext == '.pdf':
            text = pdf_parser.extract_text(file_path)
        elif ext in ['.doc', '.docx']:
            text = self._extract_from_word(file_path)
        elif ext in ['.txt', '.rtf']:
            text = self._extract_from_text(file_path)
        
        if not text:
            logger.warning(f"Could not extract text from {file_path}")
            return CVData(missing_fields=self.REQUIRED_FIELDS.copy())
        
        return self.extract_from_text(text)
    
    def extract_from_bytes(self, file_bytes: bytes, filename: str) -> CVData:
        """
        Extract CV data from file bytes.
        
        Args:
            file_bytes: File content as bytes
            filename: Original filename (for format detection)
            
        Returns:
            CVData object with extracted information
        """
        ext = Path(filename).suffix.lower()
        
        text = None
        
        if ext == '.pdf':
            text = pdf_parser.extract_text_from_bytes(file_bytes)
        elif ext in ['.doc', '.docx']:
            # Save temporarily for Word processing
            from app.utils.file_handler import file_manager
            temp_path = file_manager.save_temp_file(file_bytes, filename)
            text = self._extract_from_word(temp_path)
            file_manager.delete_file(temp_path)
        elif ext in ['.txt', '.rtf']:
            text = file_bytes.decode('utf-8', errors='ignore')
        
        if not text:
            logger.warning(f"Could not extract text from {filename}")
            return CVData(missing_fields=self.REQUIRED_FIELDS.copy())
        
        return self.extract_from_text(text)
    
    def extract_from_text(self, text: str) -> CVData:
        """
        Extract structured CV data from raw text.
        
        Args:
            text: Raw CV text
            
        Returns:
            CVData object with extracted information
        """
        cv_data = CVData(raw_text=text)
        
        # Extract email
        cv_data.email = self._extract_email(text)
        
        # Extract phone
        cv_data.phone = self._extract_phone(text)
        
        # Extract name (usually at the beginning)
        cv_data.name = self._extract_name(text)
        
        # Extract education
        education_info = self._extract_education(text)
        cv_data.education = education_info.get('list', [])
        cv_data.highest_qualification = education_info.get('highest')
        
        # Extract skills
        cv_data.skills = self._extract_skills(text)
        
        # Extract experience
        experience_info = self._extract_experience(text)
        cv_data.work_experience = experience_info.get('list', [])
        cv_data.experience_years = experience_info.get('years')
        cv_data.current_company = experience_info.get('current_company')
        cv_data.current_position = experience_info.get('current_position')
        
        # Extract languages
        cv_data.languages = self._extract_languages(text)
        
        # Calculate missing fields
        cv_data.missing_fields = self._get_missing_fields(cv_data)
        
        logger.info(
            f"Extracted CV data: name={cv_data.name}, "
            f"email={cv_data.email}, missing={cv_data.missing_fields}"
        )
        
        return cv_data
    
    def _extract_email(self, text: str) -> Optional[str]:
        """Extract email address from text."""
        matches = self.EMAIL_PATTERN.findall(text)
        return matches[0] if matches else None
    
    def _extract_phone(self, text: str) -> Optional[str]:
        """Extract phone number from text."""
        for pattern in self.PHONE_PATTERNS:
            matches = pattern.findall(text)
            if matches:
                # Clean up and return first valid phone
                phone = matches[0].strip()
                # Remove common separators for normalization
                clean_phone = re.sub(r'[-.\s()]', '', phone)
                if len(clean_phone) >= 9:
                    return phone
        return None
    
    def _extract_name(self, text: str) -> Optional[str]:
        """Extract candidate name from text."""
        lines = text.strip().split('\n')
        
        for line in lines[:5]:  # Check first 5 lines
            line = line.strip()
            
            # Skip empty lines
            if not line:
                continue
            
            # Skip lines that look like headers
            lower_line = line.lower()
            skip_patterns = [
                'curriculum vitae', 'resume', 'cv', 'personal details',
                'profile', 'objective', 'summary'
            ]
            if any(pattern in lower_line for pattern in skip_patterns):
                continue
            
            # Skip lines with email or phone
            if '@' in line or re.search(r'\d{3,}', line):
                continue
            
            # Check if line looks like a name (2-4 words, mostly letters)
            words = line.split()
            if 1 <= len(words) <= 5:
                is_name = all(
                    word.replace('.', '').replace('-', '').isalpha()
                    for word in words
                    if len(word) > 1
                )
                if is_name and len(line) > 3:
                    return line.title()
        
        return None
    
    def _extract_education(self, text: str) -> Dict[str, Any]:
        """Extract education information."""
        result = {'list': [], 'highest': None}
        
        lines = text.split('\n')
        in_education_section = False
        education_entries = []
        
        for line in lines:
            line_lower = line.lower().strip()
            
            # Check if we're entering education section
            if any(kw in line_lower for kw in ['education', 'qualification', 'academic']):
                in_education_section = True
                continue
            
            # Check if we're leaving education section
            if in_education_section and any(
                kw in line_lower for kw in ['experience', 'skill', 'project', 'reference']
            ):
                in_education_section = False
            
            # Look for education keywords
            if any(kw in line_lower for kw in self.EDUCATION_KEYWORDS):
                if line.strip():
                    education_entries.append(line.strip())
        
        result['list'] = education_entries[:5]  # Limit to 5 entries
        
        # Determine highest qualification
        qualifications_priority = [
            ('phd', 'PhD'),
            ('doctor', 'Doctorate'),
            ('master', "Master's Degree"),
            ('mba', 'MBA'),
            ('msc', 'MSc'),
            ('bachelor', "Bachelor's Degree"),
            ('bsc', 'BSc'),
            ('degree', 'Degree'),
            ('diploma', 'Diploma'),
            ('a/l', 'A/L'),
            ('a level', 'A Level'),
            ('o/l', 'O/L'),
            ('o level', 'O Level'),
        ]
        
        text_lower = text.lower()
        for keyword, label in qualifications_priority:
            if keyword in text_lower:
                result['highest'] = label
                break
        
        return result
    
    def _extract_skills(self, text: str) -> Optional[str]:
        """Extract skills from text."""
        skills = []
        lines = text.split('\n')
        in_skills_section = False
        
        # Common technical skills to look for
        tech_skills = [
            'python', 'java', 'javascript', 'typescript', 'react', 'angular',
            'node', 'sql', 'mysql', 'postgresql', 'mongodb', 'aws', 'azure',
            'docker', 'kubernetes', 'git', 'linux', 'html', 'css', 'php',
            'c++', 'c#', '.net', 'django', 'flask', 'spring', 'vue',
            'excel', 'word', 'powerpoint', 'photoshop', 'illustrator',
            'sap', 'oracle', 'salesforce', 'tableau', 'power bi'
        ]
        
        for line in lines:
            line_lower = line.lower().strip()
            
            # Check if entering skills section
            if 'skill' in line_lower or 'technical' in line_lower:
                in_skills_section = True
                continue
            
            # Check if leaving skills section
            if in_skills_section and any(
                kw in line_lower for kw in ['experience', 'education', 'project', 'reference']
            ):
                in_skills_section = False
            
            # Extract skills from line
            for skill in tech_skills:
                if skill in line_lower and skill not in [s.lower() for s in skills]:
                    skills.append(skill.title())
        
        return ', '.join(skills[:15]) if skills else None
    
    def _extract_experience(self, text: str) -> Dict[str, Any]:
        """Extract work experience information."""
        result = {
            'list': [],
            'years': None,
            'current_company': None,
            'current_position': None
        }
        
        # Try to find years of experience
        year_patterns = [
            r'(\d+)\+?\s*years?\s*(?:of\s*)?experience',
            r'experience\s*:?\s*(\d+)\+?\s*years?',
            r'(\d+)\+?\s*years?\s*in\s*(?:the\s*)?(?:industry|field)',
        ]
        
        for pattern in year_patterns:
            match = re.search(pattern, text.lower())
            if match:
                try:
                    result['years'] = int(match.group(1))
                    break
                except ValueError:
                    pass
        
        # Extract work experience entries
        lines = text.split('\n')
        in_experience_section = False
        
        for line in lines:
            line_lower = line.lower().strip()
            
            if any(kw in line_lower for kw in ['experience', 'employment', 'work history']):
                in_experience_section = True
                continue
            
            if in_experience_section and any(
                kw in line_lower for kw in ['education', 'skill', 'reference', 'project']
            ):
                in_experience_section = False
            
            if in_experience_section and line.strip():
                # Look for company/position patterns
                if any(kw in line_lower for kw in ['company', 'ltd', 'inc', 'pvt', 'corp']):
                    result['list'].append(line.strip())
        
        result['list'] = result['list'][:5]  # Limit entries
        
        return result
    
    def _extract_languages(self, text: str) -> Optional[List[str]]:
        """Extract spoken languages."""
        common_languages = [
            'english', 'sinhala', 'tamil', 'hindi', 'french', 'german',
            'spanish', 'chinese', 'japanese', 'korean', 'arabic'
        ]
        
        found_languages = []
        text_lower = text.lower()
        
        for lang in common_languages:
            if lang in text_lower:
                found_languages.append(lang.title())
        
        return found_languages if found_languages else None
    
    def _extract_from_word(self, file_path: str) -> Optional[str]:
        """Extract text from Word document."""
        if not DOCX_AVAILABLE:
            logger.error("python-docx not available")
            return None
        
        try:
            doc = DocxDocument(file_path)
            paragraphs = [para.text for para in doc.paragraphs if para.text.strip()]
            return '\n'.join(paragraphs)
        except Exception as e:
            logger.error(f"Failed to extract text from Word document {file_path}: {e}")
            return None
    
    def _extract_from_text(self, file_path: str) -> Optional[str]:
        """Extract text from plain text file."""
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read()
        except Exception as e:
            logger.error(f"Failed to read text file {file_path}: {e}")
            return None
    
    def _get_missing_fields(self, cv_data: CVData) -> List[str]:
        """Get list of missing required fields."""
        missing = []
        
        if not cv_data.name:
            missing.append('name')
        if not cv_data.email:
            missing.append('email')
        if not cv_data.phone:
            missing.append('phone')
        if not cv_data.highest_qualification:
            missing.append('highest_qualification')
        
        return missing
    
    def get_missing_field_question(self, field: str, language: str = 'en') -> str:
        """
        Get a question to ask the user for a missing field.
        
        Args:
            field: The missing field name
            language: Language code for the question
            
        Returns:
            Question string in the specified language
        """
        questions = {
            'en': {
                'name': "Could you please provide your full name?",
                'email': "What is your email address?",
                'phone': "Could you please share your phone number?",
                'highest_qualification': "What is your highest educational qualification?",
                'experience_years': "How many years of work experience do you have?",
                'notice_period': "What is your notice period at your current job?",
                'skills': "What are your key skills?",
                # Role-screening fields
                'nursing_license': "Do you hold a valid nursing license or registration certificate? 📜",
                'qualification_level': "What level of qualification do you hold for this role? (e.g. Diploma, Degree, Professional Certificate)",
                'passport_status': "Do you have a valid passport? If yes, what is the expiry date? 🛂",
                'availability': "When would you be available to start? 📅",
                'english_proficiency': "What is your English proficiency level? (e.g. Basic, Intermediate, Fluent, IELTS score if available)",
                'technical_certification': "Do you hold any relevant technical certifications or trade qualifications? 🔧",
                'license_type': "What type of driving license do you hold, and is it valid? 🚗",
                'driving_experience': "How many years of professional driving experience do you have?",
                'abroad_experience': "Have you previously worked abroad? If yes, which country/countries?",
                'age': "Could you please share your age?",
                'height_cm': "Could you please share your height (in cm)?",
                'licenses': "Do you hold any relevant professional licenses? Please describe.",
                'languages_spoken': "Which languages do you speak fluently?",
            },
            'si': {
                'name': "කරුණාකර ඔබේ සම්පූර්ණ නම සපයන්න පුළුවන්ද?",
                'email': "ඔබේ ඊමේල් ලිපිනය කුමක්ද?",
                'phone': "කරුණාකර ඔබේ දුරකථන අංකය බෙදා ගන්න පුළුවන්ද?",
                'highest_qualification': "ඔබේ ඉහළම අධ්‍යාපන සුදුසුකම කුමක්ද?",
                'experience_years': "ඔබට වැඩ පළපුරුද්ද කොපමණ වසරක්ද?",
                'notice_period': "ඔබේ දැනට රැකියාවේ කැඳවීමේ කාලය කොපමණද?",
                'skills': "ඔබේ ප්‍රධාන කුසලතා මොනවාද?",
                'nursing_license': "ඔබ සතු වලංගු හෙදිකා බලපත්‍රයක් හෝ ලියාපදිංචි සහතිකයක් තිබේද? 📜",
                'qualification_level': "ඔබ සතු වෘත්තීය සුදුසුකම් මට්ටම කුමක්ද? (උදා: ඩිප්ලෝමා, උපාධිය, වෘත්තීය සහතිකය)",
                'passport_status': "ඔබ සතු වලංගු විදේශ ගමන් බලපත්‍රයක් තිබේද? කල් ඉකුත් වන දිනය? 🛂",
                'availability': "ඔබට කසාරක (Start) කල හැකි ආරම්භ දිනය කුමක්ද? 📅",
                'english_proficiency': "ඔබේ ඉංග්‍රීසි භාෂා ප්‍රවීණතාවය කොහොමද? (IELTS ලකුණු ඇත්නම් සඳහන් කරන්න)",
                'technical_certification': "ඔබ සතු කෙළිக්‍රා/තාක්ෂණික සහතික මොනවාද? 🔧",
                'license_type': "ඔබ සතු රිය පැදවීමේ බලපත්‍ර වර්ගය කුමක්ද? 🚗",
                'age': "ඔබේ වයස කීයද?",
                'height_cm': "ඔබේ උස (cm වලින්) කීයද?",
                'licenses': "ඔබ සතු වෘත්තීය බලපත්‍ර මොනවාද?",
                'languages_spoken': "ඔබ ්‍රවීණව කතා කරන භාෂා මොනවාද?",
            },
            'ta': {
                'name': "உங்கள் முழு பெயரை தயவுசெய்து சொல்லுங்கள்?",
                'email': "உங்கள் மின்னஞ்சல் முகவரி என்ன?",
                'phone': "உங்கள் தொலைபேசி எண்ணை பகிர முடியுமா?",
                'highest_qualification': "உங்கள் மிக உயர்ந்த கல்வித் தகுதி என்ன?",
                'experience_years': "உங்களுக்கு எத்தனை வருட பணி அனுபவம் உள்ளது?",
                'notice_period': "உங்கள் தற்போதைய வேலையில் அறிவிப்பு காலம் என்ன?",
                'skills': "உங்கள் முக்கிய திறன்கள் என்ன?",
                'nursing_license': "உங்களிடம் செல்லுபடியாகும் நர்சிங் உரிமம் அல்லது பதிவுச் சான்றிதழ் உள்ளதா? 📜",
                'qualification_level': "இந்தப் பதவிக்கான உங்கள் தகுதி நிலை என்ன? (டிப்ளோமா, பட்டம், தொழில்முறை சான்றிதழ்)",
                'passport_status': "உங்களிடம் செல்லுபடியாகும் பாஸ்போர்ட் உள்ளதா? காலாவதி தேதி என்ன? 🛂",
                'availability': "நீங்கள் எப்போது கிடைக்கலாம்? 📅",
                'english_proficiency': "உங்கள் ஆங்கில திறன் நிலை என்ன? (IELTS மதிப்பெண் இருந்தால் சொல்லுங்கள்)",
                'technical_certification': "உங்களிடம் ஏதேனும் தொழில்நுட்ப சான்றிதழ்கள் உள்ளதா? 🔧",
                'license_type': "உங்களிடம் உள்ள வாகன உரிம வகை என்ன? 🚗",
                'age': "உங்கள் வயது என்ன?",
                'height_cm': "உங்கள் உயரம் (cm-ல்) என்ன?",
                'licenses': "உங்களிடம் ஏதேனும் தொழில்முறை உரிமங்கள் உள்ளதா?",
                'languages_spoken': "நீங்கள் சரளமாக பேசும் மொழிகள் என்னென்ன?",
            }
        }
        
        lang_questions = questions.get(language, questions['en'])
        return lang_questions.get(field, f"Please provide your {field}.")


# Singleton instance
text_extractor = TextExtractor()
