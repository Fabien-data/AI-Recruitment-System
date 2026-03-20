"""
Sentiment Analyzer
==================
Analyzes sentiment and detects profanity in messages.
Handles frustration, abuse, and negative sentiment professionally.
"""

import logging
import re
from typing import Tuple, Dict, Any, Optional
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Try to import transformers for advanced sentiment analysis
try:
    from transformers import pipeline
    TRANSFORMERS_AVAILABLE = True
except ImportError:
    TRANSFORMERS_AVAILABLE = False
    logger.warning("Transformers not available, using rule-based sentiment analysis")


@dataclass
class SentimentResult:
    """Result of sentiment analysis."""
    score: float          # -1 (negative) to 1 (positive)
    label: str            # 'positive', 'negative', 'neutral'
    has_profanity: bool   # Whether profanity was detected
    is_aggressive: bool   # Whether message seems aggressive
    confidence: float     # Confidence in the analysis


class SentimentAnalyzer:
    """
    Analyzes sentiment and detects profanity in messages.
    Uses Hugging Face transformers when available, falls back to rule-based.
    """
    
    # Profanity patterns (common across languages, including transliterated)
    PROFANITY_PATTERNS = [
        # English
        r'\b(fuck|shit|damn|ass|bitch|bastard|crap|hell)\b',
        r'\b(idiot|stupid|dumb|useless|worthless)\b',
        # Singlish / Romanized Sinhala (50+ items)
        r'\b(huththo|ponnaya|ballo|pakaya|gona|modaya|moodaya|karuwa|bala|pissu)\b',
        r'\b(karapotthi|wadde|weddek|pissuwa|peththi|ponna|gaandu|gaanda)\b',
        r'\b(hora|horu|suddha|sudu|kella|kello|sanniya)\b',
        r'\b(karanna be|karanna behe|mona bala|mona pissu|vedak nehe)\b',
        r'\b(yako|yakka|yakko|yaksha|yakkunta|yakshini)\b',
        r'\b(bole|bolath|bolada|bohoma bole|amu|apala|narana)\b',
        r'\b(uda gammana|gihilla yanna|pol aluwa|pol aththe)\b',
        # Sinhala Unicode profanity (common abusive terms)
        r'(හුත්තා|බොල|පිස්සු|ගොනා|මෝඩ|කරුවා|පක්කිය|යකා|ශිෂ්ට)',
        r'(නාරාන|ගඩ්ඩ|ගාඩ|ගෑදා|ගෑ|අමු|අපලා|හොරා)',
        r'(ගොන|කෙල්ල|කෙළ්ල|‍‍රේංජ|බොළ|නිකම|ශිෂ්ට)',
        # Tanglish / Romanized Tamil (50+ items)
        r'\b(thayoli|oombuda|poda|podi|podithu|pundamavane|sunni)\b',
        r'\b(loosu|loosupodam|onnuku|onakku|namard|naaye|naayi|naai)\b',
        r'\b(kazhudhai|kazhuda|pei|pey|palakadu|koothichi|koothikku)\b',
        r'\b(velakku|velaku|thevudiya|kaakka|mucha|mucha paya)\b',
        r'\b(soothu|suthu|baadu|badu|kevalama|kovalama)\b',
        r'\b(pattalam|pattaalam|mudalali|unakku theriyathu)\b',
        r'\b(irruku mattom|waste pannatha|time waste|waste bot)\b',
        # Tamil Unicode profanity (common abusive terms)
        r'(தாயோளி|ஊம்பு|போடா|நாய்|கழுதை|பேய்|லூசு)',
        r'(சூது|கோழை|மூட|மூடன்|பட்டாளம்|திருடன்|கள்ளன்)',
        r'(கோவல|தேவடியா|கவர்ச்சி|பாடு|ஒன்றுக்கும்|தெரியல)',
    ]

    # ─────────────────────────────────────────────────────────────────────────
    # Frustration phrases triggering human-recruiter escalation (score >0.7)
    # ─────────────────────────────────────────────────────────────────────────
    FRUSTRATION_PHRASES = [
        # Singlish
        'bot ekata behe', 'yako mokda meka', 'waste time', 'useless bot',
        'theriyavey illa', 'mona bot ekeda', 'api thiyanawa kedeema',
        'respond karanna behe', 'vedak nehe', 'bohoma narakuyi',
        'theriyavey ne', 'bot respond ne', 'kelawela', 'danaganna behe',
        'weda karanne ne', 'weda nehe', 'help ne', 'kisi ekak nehe',
        'oyata nehe', 'oyata karanna behe', 'bai hinda', 'palaya',
        # Tanglish
        'theriyathu', 'unakku theriyathu', 'waste panreenga', 'time waste bot',
        'payan illai', 'useless', 'kadaisi mudi', 'oru payan illa',
        'payan ey illai', 'solla theriyathu', 'puriyala', 'etho panneenga',
        'bot payan illai', 'incorrect', 'tappana solreenga',
        # English
        'waste of time', 'useless bot', 'not helpful', 'terrible service',
        'you dont understand', "you don't understand", 'what is this',
        'this is useless', 'this bot is bad', 'stupid bot',
        'not working', "doesn't work", 'no help',
    ]
    
    # Negative sentiment indicators
    NEGATIVE_INDICATORS = {
        'angry', 'frustrated', 'annoyed', 'hate', 'terrible', 'worst',
        'useless', 'stupid', 'disappointed', 'upset', 'furious', 'mad',
        'ridiculous', 'pathetic', 'waste', 'scam', 'rubbish', 'garbage',
        'never', 'nothing', "won't", "can't",
        # Sinhala transliterated
        'honda nehe', 'karanna be', 'behe', 'mohosthang',
        # Tamil transliterated
        'mosam', 'kettadu', 'vendam'
    }
    
    # Positive sentiment indicators
    POSITIVE_INDICATORS = {
        'thank', 'thanks', 'great', 'good', 'excellent', 'wonderful',
        'amazing', 'helpful', 'perfect', 'love', 'appreciate', 'happy',
        'pleased', 'satisfied', 'awesome', 'fantastic', 'brilliant',
        # Sinhala transliterated
        'sthuthi', 'godak', 'honda', 'supiri', 'lassana',
        # Tamil transliterated
        'nandri', 'nalla', 'romba', 'super'
    }
    
    # Aggression indicators
    AGGRESSION_INDICATORS = [
        r'!{2,}',           # Multiple exclamation marks
        r'\b[A-Z]{3,}\b',   # ALL CAPS words
        r'\?{2,}',          # Multiple question marks
        r'(?:what|how|why).*!',  # Question + exclamation
    ]
    
    def __init__(self):
        self.transformer_pipeline = None
        
        # Try to load transformer model
        if TRANSFORMERS_AVAILABLE:
            try:
                # Use a lightweight model suitable for sentiment analysis
                self.transformer_pipeline = pipeline(
                    "sentiment-analysis",
                    model="distilbert-base-uncased-finetuned-sst-2-english",
                    device=-1  # CPU
                )
                logger.info("Loaded transformer sentiment model")
            except Exception as e:
                logger.warning(f"Failed to load transformer model: {e}")
                self.transformer_pipeline = None
    
    def analyze(self, text: str) -> SentimentResult:
        """
        Analyze sentiment of the given text.
        
        Args:
            text: Input text to analyze
            
        Returns:
            SentimentResult with analysis details
        """
        if not text or not text.strip():
            return SentimentResult(
                score=0.0,
                label='neutral',
                has_profanity=False,
                is_aggressive=False,
                confidence=0.0
            )
        
        text = text.strip()
        
        # Check for profanity
        has_profanity = self._check_profanity(text)
        
        # Check for aggression patterns
        is_aggressive = self._check_aggression(text)
        
        # Check frustration phrases (multi-word, language-agnostic)
        is_frustrated = self._check_frustration(text)
        if is_frustrated:
            is_aggressive = True  # frustration phrases also flag aggressive
        
        # Get sentiment
        if self.transformer_pipeline and len(text.split()) > 2:
            score, label, confidence = self._analyze_with_transformer(text)
        else:
            score, label, confidence = self._analyze_rule_based(text)
        
        # Adjust for profanity and aggression
        if has_profanity:
            score = max(score - 0.3, -1.0)
            if label == 'positive':
                label = 'neutral'
        
        if is_aggressive:
            score = max(score - 0.2, -1.0)
        
        # Determine final label
        if score > 0.2:
            label = 'positive'
        elif score < -0.2:
            label = 'negative'
        else:
            label = 'neutral'
        
        return SentimentResult(
            score=round(score, 3),
            label=label,
            has_profanity=has_profanity,
            is_aggressive=is_aggressive,
            confidence=round(confidence, 3)
        )
    
    def _check_frustration(self, text: str) -> bool:
        """Check if text matches known frustration phrases that trigger human escalation."""
        text_lower = text.lower()
        for phrase in self.FRUSTRATION_PHRASES:
            if phrase in text_lower:
                return True
        return False

    def _check_profanity(self, text: str) -> bool:
        """Check if text contains profanity."""
        text_lower = text.lower()
        
        for pattern in self.PROFANITY_PATTERNS:
            if re.search(pattern, text_lower, re.IGNORECASE):
                return True
        
        return False
    
    def _check_aggression(self, text: str) -> bool:
        """Check if text shows signs of aggression."""
        for pattern in self.AGGRESSION_INDICATORS:
            if re.search(pattern, text):
                return True
        return False
    
    def _analyze_with_transformer(self, text: str) -> Tuple[float, str, float]:
        """Use transformer model for sentiment analysis."""
        try:
            result = self.transformer_pipeline(text[:512])[0]
            
            label = result['label'].lower()
            confidence = result['score']
            
            if label == 'positive':
                score = confidence
            elif label == 'negative':
                score = -confidence
            else:
                score = 0.0
            
            return score, label, confidence
            
        except Exception as e:
            logger.error(f"Transformer analysis failed: {e}")
            return self._analyze_rule_based(text)
    
    def _analyze_rule_based(self, text: str) -> Tuple[float, str, float]:
        """Fallback rule-based sentiment analysis."""
        text_lower = text.lower()
        words = set(text_lower.split())
        
        positive_count = 0
        negative_count = 0
        
        for word in words:
            if word in self.POSITIVE_INDICATORS:
                positive_count += 1
            if word in self.NEGATIVE_INDICATORS:
                negative_count += 1
        
        # Check for phrases
        for phrase in self.POSITIVE_INDICATORS:
            if ' ' in phrase and phrase in text_lower:
                positive_count += 1
        
        for phrase in self.NEGATIVE_INDICATORS:
            if ' ' in phrase and phrase in text_lower:
                negative_count += 1
        
        total = positive_count + negative_count
        if total == 0:
            return 0.0, 'neutral', 0.5
        
        score = (positive_count - negative_count) / max(total, 1)
        confidence = min(total / 5, 1.0)  # More indicators = higher confidence
        
        if score > 0.2:
            label = 'positive'
        elif score < -0.2:
            label = 'negative'
        else:
            label = 'neutral'
        
        return score, label, confidence
    
    def get_de_escalation_response(self, sentiment_result: SentimentResult, language: str = 'en') -> Optional[str]:
        """
        Get a de-escalation response for negative sentiment.
        
        Args:
            sentiment_result: The sentiment analysis result
            language: Target language code
            
        Returns:
            De-escalation message or None if not needed
        """
        if sentiment_result.label != 'negative' and not sentiment_result.has_profanity:
            return None
        
        responses = {
            'en': {
                'profanity': "I understand you may be frustrated. I'm here to help you with your application. Could you please tell me more about your concern?",
                'negative': "I'm sorry you're having this experience. I want to help resolve your concern. What can I assist you with?",
                'aggressive': "I can see you're upset. Let me try to help you. Could you please share more details about what's troubling you?"
            },
            'si': {
                'profanity': "ඔබ කලකිරී ඇති බව මට තේරෙනවා. මම ඔබට උදව් කරන්න මෙහි සිටිනවා. ඔබේ ගැටලුව ගැන කරුණාකර මට වැඩිදුර කියන්න පුළුවන්ද?",
                'negative': "මට කණගාටුයි. ඔබේ ගැටලුව විසඳන්න මට උදව් කරන්න ඕනේ. මට ඔබට කෙසේ ද උදව් කළ හැක්කේ?",
                'aggressive': "ඔබ කලකිරී ඇති බව මට පෙනෙනවා. කරුණාකර ඔබේ ගැටලුව ගැන වැඩි විස්තර බෙදා ගන්න."
            },
            'ta': {
                'profanity': "நீங்கள் விரக்தியடைந்திருக்கலாம் என்பதை நான் புரிந்துகொள்கிறேன். உங்கள் விண்ணப்பத்திற்கு உதவ நான் இங்கே இருக்கிறேன். உங்கள் கவலை பற்றி மேலும் சொல்ல முடியுமா?",
                'negative': "நான் மன்னிப்பு கேட்கிறேன். உங்கள் கவலையை தீர்க்க நான் விரும்புகிறேன். நான் உங்களுக்கு எவ்வாறு உதவ முடியும்?",
                'aggressive': "நீங்கள் வருத்தமாக இருப்பதை என்னால் பார்க்க முடிகிறது. உங்களுக்கு என்ன பிரச்சனை என்று விவரங்களை பகிர்ந்து கொள்ளுங்கள்."
            }
        }
        
        lang_responses = responses.get(language, responses['en'])
        
        if sentiment_result.has_profanity:
            return lang_responses['profanity']
        elif sentiment_result.is_aggressive:
            return lang_responses['aggressive']
        else:
            return lang_responses['negative']


# Singleton instance
sentiment_analyzer = SentimentAnalyzer()


def analyze_sentiment(text: str) -> SentimentResult:
    """Convenience function for sentiment analysis."""
    return sentiment_analyzer.analyze(text)


def get_de_escalation(sentiment_result: SentimentResult, language: str = 'en') -> Optional[str]:
    """Convenience function for de-escalation responses."""
    return sentiment_analyzer.get_de_escalation_response(sentiment_result, language)
