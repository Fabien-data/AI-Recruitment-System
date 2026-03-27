"""
RAG Engine
==========
Retrieval-Augmented Generation engine using OpenAI gpt-5.4-mini.
Integrates with Pinecone for vector storage and retrieval.
"""

import asyncio
import logging
import hashlib
import time
from typing import Optional, List, Dict, Any, Tuple
import os

# â”€â”€â”€ RAG retrieval configuration (PDF spec) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
RAG_MIN_SCORE: float = 0.5      # was 0.7 â€” lower to reduce false-negatives
RAG_RETRIEVE_TOP_K: int = 5     # fetch 5 candidates from Pinecone
RAG_RERANK_TOP_N: int = 3       # keep top 3 after LLM re-rank

# â”€â”€â”€ Lightweight in-memory caches (avoids redundant LLM calls) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# classify_message results for identical (text, state, language) tuples
_CLASSIFY_CACHE: Dict[str, tuple] = {}
_CLASSIFY_CACHE_TTL = 300   # 5 minutes â€” same intent doesn't change quickly

# validate_intake_answer results for identical (field, text, language) tuples
_VALIDATE_CACHE: Dict[str, tuple] = {}
_VALIDATE_CACHE_TTL = 300   # 5 minutes


def _cache_get(store: Dict, key: str, ttl: int):
    entry = store.get(key)
    if entry and (time.time() - entry[1]) < ttl:
        return entry[0]
    return None


def _cache_set(store: Dict, key: str, value, max_size: int = 1000):
    if len(store) >= max_size:
        # Evict oldest 20 % when full
        oldest = sorted(store.items(), key=lambda x: x[1][1])[:max_size // 5]
        for k, _ in oldest:
            del store[k]
    store[key] = (value, time.time())

logger = logging.getLogger(__name__)

# Try to import required libraries
try:
    from openai import OpenAI, AsyncOpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    logger.warning("OpenAI not available")

try:
    from pinecone import Pinecone
    PINECONE_AVAILABLE = True
except (ImportError, Exception) as _pinecone_err:
    PINECONE_AVAILABLE = False
    logger.warning(f"Pinecone not available ({_pinecone_err}) â€” will use keyword fallback")

from app.config import settings
from app.llm.prompt_templates import PromptTemplates, GLOBAL_AI_TAKEOVER_PROMPT


class RAGEngine:
    """
    Retrieval-Augmented Generation engine.
    Uses OpenAI gpt-5.4-mini for classification and generation, and Pinecone for retrieval.
    """
    
    def __init__(self):
        self.openai_client = None
        self.async_openai_client = None
        self.pinecone_index = None
        self.embedding_model = "text-embedding-ada-002"
        # Classification: fast model for intent/entity extraction (low latency)
        self.classify_model = "gpt-5.4-mini"
        # RAG / conversational generation model
        self.chat_model = "gpt-5.4-mini"
        self.complex_chat_model = "gpt-5.4-mini"

        # Initialize OpenAI (sync for embeddings / index operations)
        if OPENAI_AVAILABLE:
            try:
                self.openai_client = OpenAI(api_key=settings.openai_api_key)
                self.async_openai_client = AsyncOpenAI(api_key=settings.openai_api_key)
                logger.info("OpenAI clients (sync + async) initialized")
            except Exception as e:
                logger.error(f"Failed to initialize OpenAI: {e}")
        
        # Initialize Pinecone (optional â€” only if PINECONE_API_KEY is set)
        if PINECONE_AVAILABLE and settings.pinecone_api_key:
            try:
                pc = Pinecone(api_key=settings.pinecone_api_key)
                self.pinecone_index = pc.Index(settings.pinecone_index_name)
                logger.info(f"Pinecone index '{settings.pinecone_index_name}' connected")
            except Exception as e:
                logger.warning(f"Pinecone not available (will use keyword fallback): {e}")
                self.pinecone_index = None
        else:
            if not settings.pinecone_api_key:
                logger.info("PINECONE_API_KEY not set â€” RAG will use keyword-based fallback from DB")
            self.pinecone_index = None
    
    def generate_response(
        self,
        user_message: str,
        conversation_history: Optional[str] = None,
        candidate_info: Optional[Dict[str, Any]] = None,
        language: str = "en",
        use_rag: bool = True
    ) -> str:
        """
        Generate a response using gpt-5.4-mini with optional RAG.
        
        Args:
            user_message: The user's message
            conversation_history: Previous conversation context
            candidate_info: Candidate's profile information
            language: Response language code
            use_rag: Whether to use knowledge base retrieval
            
        Returns:
            Generated response string
        """
        if not self.openai_client:
            return self._get_fallback_response(language)
        
        try:
            # Retrieve context from knowledge base
            kb_context = ""
            if use_rag and self.pinecone_index:
                kb_context = self._retrieve_context(user_message)
            
            # Build the prompt
            messages = self._build_messages(
                user_message=user_message,
                conversation_history=conversation_history,
                candidate_info=candidate_info,
                kb_context=kb_context,
                language=language
            )

            # Route code-mixed languages to conversational model (same target here)
            selected_model = self.complex_chat_model if language in ('singlish', 'tanglish') else self.chat_model
            
            # Generate response
            response = self.openai_client.chat.completions.create(
                model=selected_model,
                messages=messages,
                # Optimize for extreme brevity to reduce backend latency
            )
            
            return response.choices[0].message.content.strip()
            
        except Exception as e:
            logger.error(f"Error generating response: {e}")
            return self._get_error_response(language)
    
    def _build_messages(
        self,
        user_message: str,
        conversation_history: Optional[str],
        candidate_info: Optional[Dict[str, Any]],
        kb_context: str,
        language: str
    ) -> List[Dict[str, str]]:
        """Build the messages array for the API call."""

        # Format candidate info
        candidate_str = ""
        candidate_name = ""
        if candidate_info:
            candidate_str = self._format_candidate_info(candidate_info)
            raw_name = candidate_info.get('name') or ""
            candidate_name = raw_name.strip().split()[0] if raw_name.strip() else ""

        # Format context for system prompt
        context_str = ""
        if kb_context:
            context_str += f"Relevant company information:\n{kb_context}\n\n"
        # Add state info
        if candidate_info and candidate_info.get('conversation_state'):
            context_str += f"Current stage: {candidate_info['conversation_state']}"

        # System prompt specifically for RAG QA (no rigid flow loops)
        system_prompt = PromptTemplates.get_rag_prompt(
            company_name=settings.company_name,
            context=context_str,
            candidate_info=candidate_str,
            question=user_message,
            language=language
        )

        # Add personalisation note if we know the name
        if candidate_name:
            system_prompt += f"\n\nIMPORTANT: The candidate's first name is {candidate_name}. Use their name naturally in conversations â€” it feels more personal."

        # Strong language instruction
        language_names = {
            'en': 'English',
            'si': 'Sinhala (à·ƒà·’à¶‚à·„à¶½)',
            'ta': 'Tamil (à®¤à®®à®¿à®´à¯)',
            'tanglish': 'Tanglish (Tamilâ€“English mix)',
            'singlish': 'Singlish (Sinhalaâ€“English mix)',
        }
        lang_name = language_names.get(language, 'English')

        lang_instruction = f"""

=== LANGUAGE & STYLE ===
User language: {lang_name}. Match their communication style in your reply.
- English â†’ English only
- Sinhala script â†’ pure Sinhala Unicode, no English
- Tamil script â†’ pure Tamil Unicode, no English
- Tanglish (Tamil in Latin) â†’ natural Tamil/English code-switch, e.g. "Dubai la driver job irriki! Apply panna ready-ah?"
- Singlish (Sinhala in Latin) â†’ natural Sinhala/English code-switch, e.g. "Dubai driver job tiyenawa! Apply karanna ready da?"
Understand intent regardless of script. Keep replies short â€” WhatsApp messages.
=============================="""

        # Append cultural context block for non-English registers
        if language != 'en':
            lang_instruction += PromptTemplates.SYSTEM_PROMPT_SRI_LANKA

        # Build messages array
        messages = [
            {"role": "system", "content": system_prompt + lang_instruction},
        ]

        # Inject conversation history as proper turns for better context
        if conversation_history:
            # conversation_history is a plain string summary; add it as assistant context
            messages.append({
                "role": "assistant",
                "content": f"[Context from our conversation so far: {conversation_history}]"
            })

        messages.append({"role": "user", "content": user_message})

        return messages
    
    def _format_candidate_info(self, info: Dict[str, Any]) -> str:
        """Format candidate info for the prompt."""
        lines = []
        
        if info.get('name'):
            lines.append(f"Name: {info['name']}")
        if info.get('email'):
            lines.append(f"Email: {info['email']}")
        if info.get('phone'):
            lines.append(f"Phone: {info['phone']}")
        if info.get('highest_qualification'):
            lines.append(f"Qualification: {info['highest_qualification']}")
        if info.get('skills'):
            lines.append(f"Skills: {info['skills']}")
        if info.get('experience_years'):
            lines.append(f"Experience: {info['experience_years']} years")
        if info.get('conversation_state'):
            lines.append(f"Current State: {info['conversation_state']}")
        
        return '\n'.join(lines) if lines else "No candidate info available yet."
    
    def _retrieve_context(self, query: str, top_k: int = 3) -> str:
        """Retrieve relevant context from the knowledge base."""
        try:
            # Generate embedding for the query
            embedding = self._get_embedding(query)
            
            if not embedding:
                return ""
            
            # Query Pinecone
            results = self.pinecone_index.query(
                vector=embedding,
                top_k=RAG_RETRIEVE_TOP_K,
                include_metadata=True
            )
            
            # Extract text from results
            contexts = []
            for match in results.matches:
                if match.score > RAG_MIN_SCORE:  # Lowered from 0.7 to reduce false-negatives
                    metadata = match.metadata or {}
                    text = metadata.get('text', '')
                    if text:
                        contexts.append(text)
            
            return '\n\n'.join(contexts[:RAG_RERANK_TOP_N])
            
        except Exception as e:
            logger.error(f"Error retrieving context: {e}")
            return ""
    
    def _get_embedding(self, text: str) -> Optional[List[float]]:
        """Generate embedding for text using OpenAI."""
        if not self.openai_client:
            return None
        
        try:
            response = self.openai_client.embeddings.create(
                model=self.embedding_model,
                input=text
            )
            return response.data[0].embedding
        except Exception as e:
            logger.error(f"Error generating embedding: {e}")
            return None
    
    def index_document(
        self,
        doc_id: str,
        text: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Index a document in the knowledge base.
        
        Args:
            doc_id: Unique document ID
            text: Document text content
            metadata: Additional metadata
            
        Returns:
            True if successful
        """
        if not self.pinecone_index or not self.openai_client:
            logger.warning("Cannot index: Pinecone or OpenAI not available")
            return False
        
        try:
            # Generate embedding
            embedding = self._get_embedding(text)
            if not embedding:
                return False
            
            # Prepare metadata
            meta: Dict[str, Any] = metadata.copy() if metadata else {}
            meta['text'] = text[:1000]  # Store truncated text
            meta['content_hash'] = hashlib.sha256(text.encode()).hexdigest()
            
            # Upsert to Pinecone
            self.pinecone_index.upsert(
                vectors=[{
                    'id': doc_id,
                    'values': embedding,
                    'metadata': meta
                }]
            )
            
            logger.info(f"Indexed document: {doc_id}")
            return True
            
        except Exception as e:
            logger.error(f"Error indexing document: {e}")
            return False

    def delete_document(self, doc_id: str) -> bool:
        """
        Delete a document from the knowledge base.
        
        Args:
            doc_id: Unique document ID
            
        Returns:
            True if successful
        """
        if not self.pinecone_index:
            logger.warning("Cannot delete: Pinecone not available")
            return False
        
        try:
            self.pinecone_index.delete(ids=[doc_id])
            logger.info(f"Deleted document from index: {doc_id}")
            return True
        except Exception as e:
            logger.error(f"Error deleting document {doc_id}: {e}")
            return False
    
    def analyze_cv(self, cv_text: str) -> str:
        """
        Analyze CV text and provide a summary.
        
        Args:
            cv_text: Extracted CV text
            
        Returns:
            Analysis summary
        """
        if not self.openai_client:
            return "Unable to analyze CV at this time."
        
        try:
            prompt = PromptTemplates.CV_ANALYSIS_PROMPT.format(cv_text=cv_text[:3000])
            
            response = self.openai_client.chat.completions.create(
                model=self.chat_model,
                messages=[
                    {"role": "system", "content": "You are a professional HR assistant analyzing CVs."},
                    {"role": "user", "content": prompt}
                ],
            )
            
            return response.choices[0].message.content.strip()
            
        except Exception as e:
            logger.error(f"Error analyzing CV: {e}")
            return "Unable to analyze CV at this time."
    
    def generate_missing_field_question(
        self,
        field: str,
        language: str = "en"
    ) -> str:
        """
        Generate a natural question to ask for a missing field.
        
        Args:
            field: The missing field name
            language: Target language
            
        Returns:
            Question string
        """
        if not self.openai_client:
            # Fallback to template
            from app.cv_parser.text_extractor import text_extractor
            return text_extractor.get_missing_field_question(field, language)
        
        try:
            prompt = PromptTemplates.MISSING_FIELD_PROMPT.format(
                field=field,
                language=language
            )
            
            response = self.openai_client.chat.completions.create(
                model=self.chat_model,
                messages=[
                    {"role": "user", "content": prompt}
                ],
            )
            
            return response.choices[0].message.content.strip()
            
        except Exception as e:
            logger.error(f"Error generating question: {e}")
            from app.cv_parser.text_extractor import text_extractor
            return text_extractor.get_missing_field_question(field, language)
    
    def validate_intake_answer(self, field: str, text: str, language: str) -> Dict[str, Any]:
        """
        Validates if the user's text is a valid response for the given 'field'
        (e.g., job_interest, destination_country, experience_years).
        """
        if not self.openai_client:
            # Fallback heuristic
            return {"is_valid": len(text) > 2, "extracted_value": text, "clarification_message": None}
            
        try:
            lang_name = {'en': 'English', 'si': 'Sinhala', 'ta': 'Tamil'}.get(language, language)
            prompt = f"""You are an AI validating a candidate's answer during a recruitment chatbot intake.
The candidate was asked for their: {field} (e.g. job_interest, destination_country, experience_years).
Conversation language: {lang_name} (code: {language})

Candidate's response: "{text}"

IMPORTANT: The response may be in:
- Native script (Sinhala/Tamil Unicode)
- Romanized/transliterated Sinhala (Singlish) or Tamil (Tanglish)
- Mixed English and local language (code-switching)
Treat ALL of these as valid language use. Do NOT mark a response as invalid just because it uses transliterated words.

You are a Sri Lankan recruitment data extractor. Users will speak in English, Sinhala, Tamil, Singlish (Romanized Sinhala), or Tanglish (Romanized Tamil). You must aggressively extract the underlying meaning. If a user says 'Mata dubai yanna one', the destination_country is 'United Arab Emirates'. If they say 'Driver wedak', the job_interest is 'Driver'. Do not return null if a conversational intent is reasonably clear. Guess the standard English translation for the database.

Analyze the response to determine if it provides a valid answer for the '{field}':
- "job_interest": Any job title, role name, category or industry mentioned â€” VALID. Romanized Tamil/Sinhala job names are valid ("nurse paniyidam" = nurse job, "driver wadeema" = driver job).
- "destination_country": Any country, region or destination mentioned â€” VALID. If the user expresses flexibility, such as "anywhere", "open to anything", "any", "nothing specific", "onama ratak" (Sinhala), or "entha nadum" (Tamil), you MUST output exactly "ANY". If the user says "Dubai", output "United Arab Emirates". Do not return null if they express flexibility.
- "experience_years": Any number or time period mentioned â€” VALID.
- If it is a pure question, off-topic, or completely irrelevant with no job/country/year info â†’ NOT valid.
- If it is NOT valid, write a polite, short clarification message in {lang_name} asking them to provide the correct information.

Respond ONLY with a valid JSON object in exactly this format:
{{
    "is_valid": true or false,
    "extracted_value": "normalized English value or null",
    "clarification_message": "polite message in {lang_name} or null"
}}"""

            response = self.openai_client.chat.completions.create(
                model=self.chat_model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"}
            )
            
            import json
            content = response.choices[0].message.content.strip()
            if content.startswith('```json'): content = content[7:]
            elif content.startswith('```'): content = content[3:]
            if content.endswith('```'): content = content[:-3]
            content = content.strip()
            return json.loads(content)
            
        except Exception as e:
            logger.error(f"Error validating intake answer: {e}")
            return {"is_valid": len(text) > 2, "extracted_value": text, "clarification_message": None}

    def classify_message(self, text: str, state: str, stored_language: str = 'en') -> Dict[str, Any]:
        """
        Unified single-call LLM intent + language + entity classifier.
        Replaces ALL regex-based intent detection for every language input type:
        English, Sinhala (script + Singlish), Tamil (script + Tanglish), mixed.

        Returns::
            {
              "intent":   vacancy_query | apply_intent | language_selection |
                          job_title | country | years_experience | question |
                          no_intent | greeting | cv_upload | other,
              "language": en | si | ta | tanglish | singlish,
              "confidence": 0.0â€“1.0,
              "entities": {
                  "job_roles":        [str, ...],
                  "countries":        [str, ...],
                  "skills":           [str, ...],
                  "experience_years": int | null
              }
            }
        """
        if not self.openai_client:
            return {
                "intent": "other",
                "language": stored_language,
                "confidence": 0.5,
                "entities": {"job_roles": [], "countries": [], "skills": [], "experience_years": None},
            }

        try:
            prompt = f"""You are a multilingual NLU engine for a Sri Lankan overseas recruitment chatbot (Dewan Consultants).
The chatbot recruits Sri Lankan candidates for jobs in the Middle East and Asia.

User message: "{text}"
Stored language preference: {stored_language}
Current conversation state: {state}

=== LANGUAGE DETECTION ===
Detect the language the user is WRITING in:
- "en"        â†’ English only
- "si"        â†’ Sinhala Unicode script (à·, à¶š, etc.)
- "ta"        â†’ Tamil Unicode script (à®•, à®¨, etc.)
- "tanglish"  â†’ Tamil words written in Latin/English letters (Romanized Tamil)
                 Signs: enna, irriki, irukku, paniyidam, velai, vanakkam, nalla, seri, theriyuma
- "singlish"  â†’ Sinhala words written in Latin/English letters (Romanized Sinhala)
                 Signs: mokakda, thiyanawa, tiyenawa, kohomada, ewanda, karanna, aney, machang, innawa
- If the message is mixed (e.g. 50% Tamil words + 50% English), choose tanglish or singlish.

=== INTENT CLASSIFICATION ===
Classify into EXACTLY ONE intent:
- "vacancy_query"       User asks what jobs/vacancies/positions are available.
                        Tanglish: "enna job irriki", "paniyidam irukku", "evvalo job"
                        Singlish: "mokakda job", "job thiyanawada", "ewanda job karanna"
                        Tamil: "à®Žà®©à¯à®© à®µà¯‡à®²à¯ˆ", "à®µà¯‡à®²à¯ˆ à®µà®¾à®¯à¯à®ªà¯à®ªà¯à®•à®³à¯"
                        Sinhala: "à¶»à·à¶šà·’à¶ºà·", "à¶‡à¶­à·’ à¶»à·à¶šà·’à¶ºà·"
- "apply_intent"        User wants to apply, says yes/ok/ready/begin/interested.
- "language_selection"  User is choosing a language (English / Sinhala / Tamil, or 1/2/3).
- "job_title"           User is naming a specific job role they want.
- "country"             User is naming a destination country.
- "years_experience"    User is stating their years of experience.
- "question"            User asks about salary, visa, process, benefits, requirements.
- "no_intent"           User declines or says no.
- "greeting"            User is just greeting (hello, hi, ayubowan, vanakkam, etc.).
- "cv_upload"           User says they are sending or have sent their CV.
- "other"               Everything else.

=== ENTITY EXTRACTION ===
Extract these entities (use English names for job roles and countries):
- job_roles:        List of job roles/titles mentioned. Map local names:
                    "driver" = driver, "nurse" = nurse, "cook" = cook,
                    "security" = security guard, "factory" = factory worker,
                    "cleaner" = cleaner, "weldere" = welder, "electrician" = electrician.
- countries:        List of countries. Map: Dubaiâ†’UAE, Qatar, Saudiâ†’Saudi Arabia,
                    Kuwait, Malaysia, Singapore, Maldives.
- skills:           List of skills or qualifications mentioned.
- experience_years: Integer if years of experience is mentioned, else null.

Respond ONLY with valid JSON (no markdown, no extra keys):
{{
  "intent": "<intent>",
  "language": "<language code>",
  "confidence": <0.0â€“1.0>,
  "entities": {{
    "job_roles": [],
    "countries": [],
    "skills": [],
    "experience_years": null
  }}
}}"""

            response = self.openai_client.chat.completions.create(
                model=self.classify_model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
            )

            import json
            content = response.choices[0].message.content.strip()
            if content.startswith('```json'): content = content[7:]
            elif content.startswith('```'): content = content[3:]
            if content.endswith('```'): content = content[:-3]
            content = content.strip()
            result = json.loads(content)
            logger.info(
                f"classify_message: '{text[:60]}' â†’ "
                f"intent={result.get('intent')} lang={result.get('language')} "
                f"conf={result.get('confidence')} entities={result.get('entities')}"
            )
            return result

        except Exception as e:
            logger.error(f"classify_message LLM error: {e}")
            return {
                "intent": "other",
                "language": stored_language,
                "confidence": 0.5,
                "entities": {"job_roles": [], "countries": [], "skills": [], "experience_years": None},
            }

    def classify_intent(self, text: str, language: str, current_state: str) -> Dict[str, Any]:
        """
        Use the LLM to classify the user's intent from ANY language input,
        including romanized/transliterated Tamil and Sinhala.

        Returns a dict with keys:
          - intent: one of vacancy_query | apply_intent | language_selection |
                    job_title | country | years_experience | question |
                    no_intent | other
          - extracted_value: normalized value when applicable (job title, country, years, language)
          - confidence: float 0.0â€“1.0
        """
        if not self.openai_client:
            return {"intent": "other", "extracted_value": None, "confidence": 0.5}

        try:
            prompt = f"""You are a multilingual intent classifier for a Sri Lankan overseas recruitment chatbot (Dewan Consultants).
The user sent this message: "{text}"
Detected language hint: {language}
Current conversation state: {current_state}

The chatbot supports English, Sinhala (script + romanized/Singlish), and Tamil (script + romanized/Tanglish).

Classify the INTENT into EXACTLY ONE of:
- "vacancy_query"    : User asks what jobs/vacancies are available.
                       Examples: "enna job irriki", "what jobs", "à®Žà®©à¯à®© job", "what are the vacancies",
                                 "enna enna position", "jobs available", "mokakda jobs", "job list karanna",
                                 "evanda jobs thiyanawada", "enna position irukku", "job ulladha"
- "apply_intent"     : User wants to apply, says yes/ok/sure/ready/begin.
- "language_selection": User is choosing a language. Examples: "Tamil", "Sinhala", "English", "1", "2", "3",
                                                               "à®¤à®®à®¿à®´à¯", "à·ƒà·’à¶‚à·„à¶½", "tamil please"
- "job_title"        : User is naming a specific job role (driver, nurse, cook, electrician, etc.)
- "country"          : User is naming a destination country (Dubai, Qatar, Saudi, Kuwait, etc.)
- "years_experience" : User is stating their years of experience (e.g., "5 years", "3 à®µà®°à¯à®Ÿà®®à¯", "3 years")
- "question"         : User is asking a specific question about salary, visa, process, requirements, benefits.
- "no_intent"        : User is declining or saying no.
- "other"            : Everything else.

IMPORTANT: Romanized Tamil (Tanglish) phrases asking about available jobs MUST map to "vacancy_query".
"enna" means "what" in Tamil. "irriki/irukku/iruku" means "there is/are" in Tamil.
"mokakda" means "what" in Sinhala. "thiyanawa/tiyenawa" means "there is" in Sinhala.

Respond ONLY with valid JSON (no markdown):
{{
    "intent": "<intent>",
    "extracted_value": "<value or null>",
    "confidence": <0.0-1.0>
}}"""

            response = self.openai_client.chat.completions.create(
                model=self.classify_model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"}
            )

            import json
            content = response.choices[0].message.content.strip()
            if content.startswith('```json'): content = content[7:]
            elif content.startswith('```'): content = content[3:]
            if content.endswith('```'): content = content[:-3]
            content = content.strip()
            result = json.loads(content)
            logger.info(f"LLM intent classification: '{text[:50]}' â†’ {result.get('intent')} ({result.get('confidence', '?')})")
            return result

        except Exception as e:
            logger.error(f"Error classifying intent via LLM: {e}")
            return {"intent": "other", "extracted_value": None, "confidence": 0.5}

    def _get_fallback_response(self, language: str) -> str:
        """Get a fallback response when API is unavailable."""
        responses = {
            'en': "I apologize, but I'm experiencing technical difficulties. Please try again in a moment or contact our support team.",
            'si': "à¶¸à¶§ à¶šà¶«à¶œà·à¶§à·”à¶ºà·’, à¶±à¶¸à·”à¶­à·Š à¶¸à¶§ à¶­à·à¶šà·Šà·‚à¶«à·’à¶š à¶¯à·”à·‚à·Šà¶šà¶»à¶­à· à¶…à¶­à·Šà·€à·’à¶³à·’à¶¸à·’à¶±à·Š à·ƒà·’à¶§à·’à¶¸à·’. à¶šà¶»à·”à¶«à·à¶šà¶» à¶¸à·œà·„à·œà¶­à¶šà·’à¶±à·Š à¶±à·à·€à¶­ à¶‹à¶­à·Šà·ƒà·à·„ à¶šà¶»à¶±à·Šà¶±.",
            'ta': "à®®à®©à¯à®©à®¿à®•à¯à®•à®µà¯à®®à¯, à®¨à®¾à®©à¯ à®¤à¯Šà®´à®¿à®²à¯à®¨à¯à®Ÿà¯à®ª à®šà®¿à®•à¯à®•à®²à¯à®•à®³à¯ˆ à®Žà®¤à®¿à®°à¯à®•à¯Šà®³à¯à®•à®¿à®±à¯‡à®©à¯. à®šà®¿à®±à®¿à®¤à¯ à®¨à¯‡à®°à®¤à¯à®¤à®¿à®²à¯ à®®à¯€à®£à¯à®Ÿà¯à®®à¯ à®®à¯à®¯à®±à¯à®šà®¿à®•à¯à®•à®µà¯à®®à¯."
        }
        return responses.get(language, responses['en'])
    
    def _get_error_response(self, language: str) -> str:
        """Get an error response."""
        responses = {
            'en': "I encountered an error processing your request. Could you please try again?",
            'si': "à¶”à¶¶à·š à¶‰à¶½à·Šà¶½à·“à¶¸ à·ƒà·à¶šà·ƒà·“à¶¸à·šà¶¯à·“ à¶¯à·à·‚à¶ºà¶šà·Š à¶‡à¶­à·’ à·€à·’à¶º. à¶šà¶»à·”à¶«à·à¶šà¶» à¶±à·à·€à¶­ à¶‹à¶­à·Šà·ƒà·à·„ à¶šà¶»à¶±à·Šà¶±.",
            'ta': "à®‰à®™à¯à®•à®³à¯ à®•à¯‹à®°à®¿à®•à¯à®•à¯ˆà®¯à¯ˆ à®šà¯†à®¯à®²à®¾à®•à¯à®•à¯à®µà®¤à®¿à®²à¯ à®ªà®¿à®´à¯ˆ à®à®±à¯à®ªà®Ÿà¯à®Ÿà®¤à¯. à®®à¯€à®£à¯à®Ÿà¯à®®à¯ à®®à¯à®¯à®±à¯à®šà®¿à®•à¯à®•à®µà¯à®®à¯."
        }
        return responses.get(language, responses['en'])

    # â”€â”€â”€ True async wrappers (use AsyncOpenAI â€” no thread blocking) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    # AsyncOpenAI makes native async HTTP calls via httpx, so these never block
    # the event loop and can be awaited concurrently with asyncio.gather().

    async def classify_message_async(
        self, text: str, state: str, stored_language: str = 'en',
        last_messages: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """True async classify â€” uses AsyncOpenAI directly.
        
        Args:
            last_messages: Up to 5 recent messages for context (newest last).
                           Pass db conversation turns so classifier can resolve
                           pronoun and intent ambiguities across turns.
        """
        _default = {
            "intent": "other", "language": stored_language, "confidence": 0.5,
            "entities": {"job_roles": [], "countries": [], "skills": [], "experience_years": None},
        }
        # Check cache first (common greetings / short answers repeat across users)
        _ckey = f"{text[:120]}|{state}|{stored_language}"
        _cached = _cache_get(_CLASSIFY_CACHE, _ckey, _CLASSIFY_CACHE_TTL)
        if _cached is not None:
            return _cached
        if not self.async_openai_client:
            return await asyncio.to_thread(self.classify_message, text, state, stored_language)
        try:
            # Build conversation context snippet (up to 5 previous messages)
            ctx_block = ""
            if last_messages:
                ctx_lines = [f"  [{i+1}] {m[:120]}" for i, m in enumerate(last_messages[-5:])]
                ctx_block = "Recent conversation (oldestâ†’newest):\n" + "\n".join(ctx_lines) + "\n\n"

            prompt = (
                f'Multilingual NLU for Sri Lankan overseas recruitment chatbot (Dewan Consultants).\n'
                f'{ctx_block}'
                f'Current message: "{text}" | Lang: {stored_language} | State: {state}\n\n'
                'DETECT language the user is WRITING in:\n'
                'en=English only | si=Sinhala script | ta=Tamil script\n'
                'tanglish=Tamil in Latin (enna,irriki,irukku,paniyidam,velai,vanakkam,nalla,seri)\n'
                'singlish=Sinhala in Latin (mokakda,thiyanawa,tiyenawa,kohomada,machang,karanna,aney)\n\n'
                'CLASSIFY intent (pick ONE):\n'
                '| intent | triggers |\n'
                '|---|---|\n'
                '| vacancy_query | asks what jobs/positions available |\n'
                '| apply_intent | yes/ok/sure/ready/wants to apply |\n'
                '| language_selection | chooses English/Sinhala/Tamil or 1/2/3 |\n'
                '| job_title | names a specific job role |\n'
                '| country | names a destination country |\n'
                '| years_experience | states years of experience |\n'
                '| question | asks about salary/visa/process/benefits |\n'
                '| no_intent | declines or says no |\n'
                '| greeting | just greeting |\n'
                '| cv_upload | sending or sent CV |\n'
                '| other | everything else |\n\n'
                'Sri Lankan few-shot examples (20+):\n'
                '"bro meka apply karanna puluwanda?" â†’ apply_intent, singlish\n'
                '"salary kiyadha?" (ctx: driver job) â†’ question, singlish\n'
                '"Dubai" â†’ country, en, countries=["UAE"]\n'
                '"vanakkam da" â†’ greeting, tanglish\n'
                '"drv jb uae?" â†’ vacancy_query, en, job_roles=["driver"], countries=["UAE"]\n'
                '"ow eka da" (ctx: cook job) â†’ apply_intent, singlish\n'
                '"welding job tiyenawada, salary kiyadha?" â†’ vacancy_query, singlish, job_roles=["welder"]\n'
                '"anubavam 3 varsham" â†’ years_experience, tanglish, experience_years=3\n'
                '"kohomada" â†’ greeting, singlish\n'
                '"nurse job tiyenawada?" â†’ vacancy_query, singlish, job_roles=["nurse"]\n'
                '"na" â†’ no_intent, singlish\n'
                '"how many years experience they want?" â†’ question, en\n'
                '"mchng, meka kohomada apply karanne" â†’ question, singlish\n'
                '"aluth" (fresh/new) â†’ years_experience, singlish, experience_years=0\n'
                '"visa requirements for bahrain" â†’ question, en, countries=["Bahrain"]\n'
                '"ippo apply panna mudiyuma?" â†’ question, tanglish\n'
                '"waste time this bot" â†’ other, en\n'
                '"ow, apply karanna" (ctx: driver) â†’ apply_intent, singlish, job_roles=["driver"]\n'
                '"2 varusham" â†’ years_experience, tanglish, experience_years=2\n'
                '"oman la nurse job tiyenawada?" â†’ vacancy_query, singlish, job_roles=["nurse"], countries=["Oman"]\n'
                '"mokakda jobs thiyanawa" â†’ vacancy_query, singlish\n'
                '"job paniyidam irukku" â†’ vacancy_query, tanglish\n'
                '"enna job irriki" â†’ vacancy_query, tanglish\n'
                '"aama" â†’ apply_intent, tanglish\n'
                '"driver karanna" â†’ job_title, singlish, job_roles=["driver"]\n\n'
                'EXTRACT entities (English names): job_roles[], countries[], skills[], experience_years\n'
                'Map: Dubaiâ†’UAE | Saudiâ†’Saudi Arabia | driver/riyaduru/à®“à®Ÿà¯à®Ÿà¯à®¨à®°à¯â†’driver\n\n'
                'JSON only (no markdown):\n'
                '{"intent":"<>","language":"<>","confidence":<0-1>,'
                '"entities":{"job_roles":[],"countries":[],"skills":[],"experience_years":null}}'
            )
            response = await self.async_openai_client.chat.completions.create(
                model=self.classify_model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                timeout=8,
            )
            import json
            content = response.choices[0].message.content.strip()
            if content.startswith('```json'): content = content[7:]
            elif content.startswith('```'): content = content[3:]
            if content.endswith('```'): content = content[:-3]
            content = content.strip()
            result = json.loads(content)
            logger.info(
                f"classify_message_async: '{text[:60]}' â†’ "
                f"intent={result.get('intent')} lang={result.get('language')} "
                f"conf={result.get('confidence')}"
            )
            _cache_set(_CLASSIFY_CACHE, _ckey, result)
            return result
        except Exception as e:
            logger.error(f"classify_message_async error: {e}")
            return _default

    async def generate_response_async(
        self,
        user_message: str,
        conversation_history: Optional[str] = None,
        candidate_info: Optional[Dict[str, Any]] = None,
        language: str = "en",
        use_rag: bool = True,
    ) -> str:
        """True async generate â€” uses AsyncOpenAI directly."""
        if not self.async_openai_client:
            return await asyncio.to_thread(
                self.generate_response, user_message, conversation_history,
                candidate_info, language, use_rag
            )
        try:
            kb_context = ""
            if use_rag and self.pinecone_index:
                # Run sync Pinecone call in thread to avoid blocking
                kb_context = await asyncio.to_thread(self._retrieve_context, user_message)

            messages = self._build_messages(
                user_message=user_message,
                conversation_history=conversation_history,
                candidate_info=candidate_info,
                kb_context=kb_context,
                language=language,
            )

            # Route code-mixed languages to conversational model (same target here)
            selected_model = self.complex_chat_model if language in ('singlish', 'tanglish') else self.chat_model
            
            response = await self.async_openai_client.chat.completions.create(
                model=selected_model,
                messages=messages,
                # Optimize for extreme brevity to reduce backend latency
                timeout=10,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"generate_response_async error: {e}")
            return self._get_error_response(language)

    async def validate_intake_answer_async(
        self, field: str, text: str, language: str = "en"
    ) -> Dict[str, Any]:
        """True async validate â€” uses AsyncOpenAI directly."""
        # NEW FAIL-CLOSED FALLBACK
        _fallback = {
            "is_valid": False,
            "extracted_value": None,
            "clarification_message": None # Let chatbot.py use its default fallback templates
        }
        # Check cache â€” common answers like "Dubai", "driver", "2 years" are frequent
        _vkey = f"{field}|{text[:120]}|{language}"
        _vcached = _cache_get(_VALIDATE_CACHE, _vkey, _VALIDATE_CACHE_TTL)
        if _vcached is not None:
            return _vcached
        if not self.async_openai_client:
            return await asyncio.to_thread(self.validate_intake_answer, field, text, language)
        try:
            lang_name = {"en": "English", "si": "Sinhala", "ta": "Tamil",
                         "tanglish": "Tanglish", "singlish": "Singlish"}.get(language, language)
            prompt = (
                f'You are validating a recruitment chatbot intake answer for a Sri Lankan overseas recruitment agency.\n'
                f'Field: {field} | User language: {lang_name} ({language})\n'
                f'User answer: "{text}"\n\n'
                'The user may write in English, Sinhala script, Tamil script, Singlish (Romanized Sinhala),\n'
                'Tanglish (Romanized Tamil), or abbreviations. All are valid.\n\n'
                '=== FIELD RULES ===\n'
                'job_interest: MUST be a distinct job title, professional role, or industry.\n'
                '  CRITICAL: REJECT conversational filler, greetings, gibberish, or vague answers like "I don\'t know", "anything", "yes", "no".\n'
                '  If it does NOT contain a clear professional role, mark as INVALID.\n'
                '  Tanglish examples (â†’ extracted_value):\n'
                '  "driver paniyidam"â†’"driver", "nurse velai"â†’"nurse"\n'
                '\n'
                'destination_country: MUST be a specific country name, city, or recognized region. If the user expresses flexibility, such as "anywhere", "open to anything", "any", "nothing specific", "onama ratak" (Sinhala), or "entha nadum" (Tamil), you MUST output exactly "ANY". If the user says "Dubai", output "United Arab Emirates". Do not return null if they express flexibility.\n'
                '  CRITICAL: REJECT answers like "abroad", "outside", or gibberish unless it clearly means flexibility.\n'
                '\n'
                'experience_years: MUST be a number, word description of a number, or time period.\n'
                '  "3 varusham"â†’"3", "fresh"/"new"â†’"0", "no experience"â†’"0"\n'
                '  REJECT off-topic text.\n'
                '\n'
                'NOT valid: a pure question ("how much salary?"), fully off-topic text, conversational filler, or random gibberish.\n\n'
                f'If invalid, write a short polite clarification in {lang_name} asking for the {field}.\n\n'
                'JSON only (no markdown):\n'
                '{"is_valid":true/false,"extracted_value":"normalized English value or null",'
                '"clarification_message":"clarification string or null"}'
            )
            response = await self.async_openai_client.chat.completions.create(
                model=self.classify_model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                timeout=8,
            )
            import json
            content = response.choices[0].message.content.strip()
            if content.startswith('```json'): content = content[7:]
            elif content.startswith('```'): content = content[3:]
            if content.endswith('```'): content = content[:-3]
            content = content.strip()
            result = json.loads(content)
            _cache_set(_VALIDATE_CACHE, _vkey, result)
            return result
        except Exception as e:
            logger.error(f"validate_intake_answer_async error: {e}")
            return _fallback

    async def generate_missing_field_question_async(self, field: str, language: str = "en") -> str:
        """True async question generator â€” uses AsyncOpenAI directly."""
        if not self.async_openai_client:
            return await asyncio.to_thread(self.generate_missing_field_question, field, language)
        try:
            lang_name = {"en": "English", "si": "Sinhala", "ta": "Tamil",
                         "tanglish": "Tanglish", "singlish": "Singlish"}.get(language, "English")
            prompt = (
                f'Generate a short, friendly question asking a job candidate for their "{field}" '
                f'in {lang_name}. One sentence max. No extra explanation.'
            )
            response = await self.async_openai_client.chat.completions.create(
                model=self.classify_model,
                messages=[{"role": "user", "content": prompt}],
                timeout=8,
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"generate_missing_field_question_async error: {e}")
            from app.cv_parser.text_extractor import text_extractor
            return text_extractor.get_missing_field_question(field, language)


    async def classify_and_validate_async(
        self,
        text: str,
        state: str,
        field: str,
        language: str,
    ):
        """
        Single LLM call returning BOTH classification AND validation.
        Saves ~800ms vs two separate async calls.

        Returns:
            (classification_dict, validation_dict)
        """
        import json

        # Try caches first
        _ckey = f"{text[:120]}|{state}|{language}"
        _vkey = f"{field}|{text[:120]}|{language}"
        _cached_c = _cache_get(_CLASSIFY_CACHE, _ckey, _CLASSIFY_CACHE_TTL)
        _cached_v = _cache_get(_VALIDATE_CACHE, _vkey, _VALIDATE_CACHE_TTL)
        if _cached_c is not None and _cached_v is not None:
            return _cached_c, _cached_v

        if not self.async_openai_client:
            classify_result = await asyncio.to_thread(self.classify_message, text, state, language)
            validate_result = await asyncio.to_thread(self.validate_intake_answer, field, text, language)
            return classify_result, validate_result

        _default_c = {
            "intent": "other", "language": language, "confidence": 0.5,
            "entities": {"job_roles": [], "countries": [], "skills": [], "experience_years": None},
        }
        _default_v = {"is_valid": False, "extracted_value": None, "clarification_message": None}

        lang_name = {"en": "English", "si": "Sinhala", "ta": "Tamil",
                     "tanglish": "Tanglish", "singlish": "Singlish"}.get(language, language)

        try:
            prompt = (
                f'Sri Lankan overseas recruitment chatbot NLU.\n'
                f'Message: "{text}" | Lang: {language} | State: {state} | Field: {field}\n\n'
                'PART 1 â€” CLASSIFY:\n'
                'Detect language (en/si/ta/singlish/tanglish) and classify intent:\n'
                'vacancy_query|apply_intent|language_selection|job_title|country|'
                'years_experience|question|no_intent|greeting|cv_upload|other\n'
                'Extract: job_roles[], countries[], skills[], experience_years\n\n'
                'Few-shot: "enna job irriki"â†’vacancy_query,tanglish | "dubai poganum"â†’country,tanglish,UAE\n'
                '"aama"â†’apply_intent,tanglish | "mokakda job"â†’vacancy_query,singlish\n\n'
                f'PART 2 â€” VALIDATE for field "{field}":\n'
                'job_interest: MUST be a distinct job title/role. REJECT conversational filler, greetings, gibberish ("anything", "yes").\n'
                'destination_country: MUST be country/city. If user expresses flexibility ("anywhere", "open to anything", "any", "onama ratak", "entha nadum"), MUST output "ANY". REJECT "abroad", gibberish.\n'
                'experience_years: MUST be number/period. REJECT off-topic.\n'
                'pure question/off-topic/gibberish = NOT valid\n'
                f'If invalid, short clarification in {lang_name}.\n\n'
                'JSON only (no extra keys):\n'
                '{"classify":{"intent":"<>","language":"<>","confidence":<0-1>,'
                '"entities":{"job_roles":[],"countries":[],"skills":[],"experience_years":null}},'
                '"validate":{"is_valid":true/false,"extracted_value":"normalized or null",'
                '"clarification_message":"message or null"}}'
            )

            response = await self.async_openai_client.chat.completions.create(
                model=self.classify_model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                timeout=9,
            )
            data = json.loads(response.choices[0].message.content)
            classify_result = data.get("classify", _default_c)
            validate_result = data.get("validate", _default_v)

            _cache_set(_CLASSIFY_CACHE, _ckey, classify_result)
            _cache_set(_VALIDATE_CACHE, _vkey, validate_result)

            logger.info(
                f"classify_and_validate_async: '{text[:60]}' ? "
                f"intent={classify_result.get('intent')} "
                f"valid={validate_result.get('is_valid')}"
            )
            return classify_result, validate_result

        except Exception as e:
            logger.error(f"classify_and_validate_async error: {e}")
            # Fallback to separate calls
            classify_result = _cached_c if _cached_c else await self.classify_message_async(text, state, language)
            validate_result = _cached_v if _cached_v else await self.validate_intake_answer_async(field, text, language)
            return classify_result, validate_result

    async def generate_agentic_response(
        self,
        user_message: str,
        current_goal: str,
        language: str = "en",
    ) -> str:
        """
        Generate an agentic, contextual steering response when a candidate's message
        is off-topic or unclear during the intake flow.

        Instead of a static robotic fallback, the LLM:
          - Acknowledges the user's message warmly in their register
          - Rephrases the current goal question naturally
          - Stays concise (WhatsApp brevity: 2 sentences + emojis)

        Args:
            user_message:  The raw off-topic message from the candidate.
            current_goal:  Human-readable description of what we need from them
                           (e.g. from PromptTemplates.CURRENT_GOAL_MAP).
            language:      Candidate's language register (en/si/ta/singlish/tanglish).

        Returns:
            A natural, warm steering response string.
        """
        # Multilingual static fallbacks (used on API error)
        _fallbacks = {
            'en':       "Got it! ðŸ˜Š Please share your answer to the current step so I can continue.",
            'si':       "à·„à¶»à·’! ðŸ˜Š à¶‰à¶¯à·’à¶»à·’à¶ºà¶§ à¶ºà¶±à·Šà¶±, à¶¯à·à¶±à¶§ à¶…à·„à¶± à¶´à·Šâ€à¶»à·à·Šà¶±à¶ºà¶§ à¶´à·’à·…à·’à¶­à·”à¶»à¶šà·Š à¶¯à·™à¶±à·Šà¶±.",
            'ta':       "à®šà®°à®¿! ðŸ˜Š à®¤à¯Šà®Ÿà®°, à®‡à®ªà¯à®ªà¯‹à®¤à¯ à®•à¯‡à®Ÿà¯à®•à¯à®®à¯ à®•à¯‡à®³à¯à®µà®¿à®•à¯à®•à¯ à®ªà®¤à®¿à®²à¯ à®šà¯Šà®²à¯à®²à¯à®™à¯à®•à®³à¯.",
            'singlish': "Hari da! ðŸ˜Š Continue karanna, dan ahana prashneta answer eka denna.",
            'tanglish': "Seri da! ðŸ˜Š Continue panna, ippo kekkura kelvikku answer sollunga.",
        }

        if not self.async_openai_client:
            return _fallbacks.get(language, _fallbacks['en'])

        try:
            prompt = PromptTemplates.get_agentic_takeover_prompt(
                user_message=user_message,
                current_goal=current_goal,
                language=language,
            )
            response = await self.async_openai_client.chat.completions.create(
                model=self.chat_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
                max_tokens=150,
                timeout=8,
            )
            text = response.choices[0].message.content.strip()
            # Safety: strip stray quote wrappers the model might include
            if text.startswith('"') and text.endswith('"'):
                text = text[1:-1]
            logger.info(
                f"generate_agentic_response: goal='{current_goal[:40]}' "
                f"lang={language} â†’ '{text[:80]}'"
            )
            return text
        except Exception as e:
            logger.error(f"generate_agentic_response error: {e}")
            return _fallbacks.get(language, _fallbacks['en'])

    async def extract_entities_multilingual(
        self,
        text: str,
        language: str,
        active_countries: list = None,
        active_jobs: list = None,
    ) -> dict:
        """
        Specialized multilingual entity extractor for Sri Lankan code-switched input.

        Uses SRI_LANKAN_ENTITY_EXTRACTION_PROMPT with CRM-aware fuzzy matching.
        Results are cached in _CLASSIFY_CACHE for performance.
        Falls back gracefully to {"job_role": None, "country": None} on errors.

        Args:
            text:             The raw user message (any language/script).
            language:         Detected language code.
            active_countries: List of country names currently active in CRM.
            active_jobs:      List of job titles currently active in CRM.

        Returns:
            dict with keys: job_role, country, matched_crm_country, matched_crm_job, confidence
        """
        import json as _json

        _fallback = {
            "job_role": None, "country": None,
            "matched_crm_country": None, "matched_crm_job": None, "confidence": 0.0,
        }

        # Cache key includes CRM lists so different CRM states stay independent
        _countries_str = ",".join(sorted(active_countries or []))[:200]
        _jobs_str = ",".join(sorted(active_jobs or []))[:200]
        _ckey = f"entity_ml|{text[:120]}|{language}|{_countries_str}|{_jobs_str}"
        _cached = _cache_get(_CLASSIFY_CACHE, _ckey, _CLASSIFY_CACHE_TTL)
        if _cached is not None:
            return _cached

        if not self.async_openai_client:
            return _fallback

        try:
            countries_list = "\n".join(f"- {c}" for c in (active_countries or [])) or "(none)"
            jobs_list = "\n".join(f"- {j}" for j in (active_jobs or [])) or "(none)"

            prompt = PromptTemplates.SRI_LANKAN_ENTITY_EXTRACTION_PROMPT.format(
                active_countries_list=countries_list,
                active_jobs_list=jobs_list,
                text=text,
            )

            response = await self.async_openai_client.chat.completions.create(
                model=self.classify_model,
                messages=[{"role": "user", "content": prompt}],
                response_format={"type": "json_object"},
                timeout=8,
            )

            content = response.choices[0].message.content.strip()
            if content.startswith("```json"): content = content[7:]
            elif content.startswith("```"): content = content[3:]
            if content.endswith("```"): content = content[:-3]
            content = content.strip()

            result = _json.loads(content)
            logger.info(
                f"extract_entities_multilingual: '{text[:60]}' â†’ "
                f"job={result.get('job_role')} country={result.get('country')} "
                f"crm_country={result.get('matched_crm_country')} conf={result.get('confidence')}"
            )
            _cache_set(_CLASSIFY_CACHE, _ckey, result)
            return result

        except Exception as e:
            logger.error(f"extract_entities_multilingual error: {e}")
            return _fallback



    async def generate_global_takeover(self, user_message: str, current_state: str) -> str:
        """Universal AI fallback for out-of-bounds messages."""
        
        state_descriptions = {
            "STATE_INITIAL": "Find out if they are looking for a job.",
            "STATE_AWAITING_LANGUAGE": "Ask them to select their preferred language.",
            "STATE_AWAITING_JOB": "Ask them what specific job role or profession they are looking for.",
            "STATE_AWAITING_COUNTRY": "Ask them which destination country they want to work in.",
            "STATE_AWAITING_EXPERIENCE": "Ask them how many years of experience they have.",
            "STATE_AWAITING_CV": "Ask them to upload a document or clear photo of their CV/Resume.",
            "STATE_COLLECTING_INFO": "Ask them for the specific missing detail we need."
        }
        
        current_stage_description = state_descriptions.get(current_state, "Figure out what they need help with regarding recruitment.")

        try:
            from app.llm.prompt_templates import GLOBAL_AI_TAKEOVER_PROMPT
            prompt = GLOBAL_AI_TAKEOVER_PROMPT.format(
                current_stage_description=current_stage_description,
                user_message=user_message
            )
            
            response = await self.async_openai_client.chat.completions.create(
                model=self.complex_chat_model, # Use gpt-4o for high empathy
                messages=[
                    {"role": "system", "content": "You are a helpful, multilingual recruitment AI."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.7,
                max_tokens=150
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            print(f"Takeover Error: {e}")
            return "I'm here to help! Could you provide the details we were just talking about? 😊"

# Singleton instance
rag_engine = RAGEngine()

