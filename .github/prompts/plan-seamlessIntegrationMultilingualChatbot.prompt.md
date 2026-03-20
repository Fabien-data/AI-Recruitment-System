# Plan: Seamless Integration & Sri Lankan Multilingual Chatbot

**TL;DR**: Two major concerns addressed — (1) make chatbot ↔ recruitment system integration rock-solid with real-time sync, error recovery, and bidirectional status updates, and (2) overhaul multilingual support so the chatbot responds naturally in Sinhala, Tamil, Singlish, and Tanglish with zero jarring language switches. No separate translation layer — the LLM responds directly in the user's register.

---

## Phase 1: Integration Robustness (Chatbot ↔ Recruitment System)

### Step 1.1 — Fix Job Cache Sync Timing
- Currently jobs sync via 5-minute background poll — new jobs take up to 5 min to appear in chatbot
- Add **immediate push** when a job/project is created/updated in the recruitment system → call `chatbot-sync.js` synchronously before returning success
- Add webhook retry with exponential backoff if chatbot `/api/knowledge/upsert` fails
- **Files**: `recruitment-system/backend/src/routes/jobs.js`, `recruitment-system/backend/src/routes/projects.js`, `recruitment-system/backend/src/routes/chatbot-sync.js`

### Step 1.2 — Harden Candidate Intake Sync
- Add **idempotency key** to `POST /api/chatbot/intake` to prevent duplicate candidates on retry
- Distinguish retryable (5xx/timeout) vs non-retryable (4xx validation) errors in `recruitment_sync.py`
- Add a **persistent `pending_sync` DB table** in chatbot for failed syncs — background worker retries every 60s
- Add structured sync logging (success/failure/retry) with candidate phone hash
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/services/recruitment_sync.py`, `recruitment-system/backend/src/routes/chatbot-intake.js`

### Step 1.3 — Bidirectional Status Updates
- Currently **NO reverse communication** — recruiter updates candidate status but chatbot never knows
- Add `POST /webhook/candidate-status` endpoint to chatbot receiving status updates
- Chatbot proactively messages candidates via WhatsApp: "Your application for [job] has been shortlisted! Interview on [date]"
- Create **status update templates in all 5 languages** for: shortlisted, interview_scheduled, hired, rejected_with_alternatives
- Note: Meta requires pre-approved message templates for business-initiated messages — submit early
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/webhooks.py` (new endpoint), `recruitment-system/backend/src/routes/candidates.js` (trigger on status change)

### Step 1.4 — CV Transfer Reliability
- Current: CV sent as base64 in JSON payload — **fails for files >5MB**
- Add multipart/form-data upload as primary path, base64 as fallback
- Add `cv_sync_status` tracking per candidate (pending/synced/failed)
- Add SHA-256 checksum verification on receipt
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/services/recruitment_sync.py`, `recruitment-system/backend/src/routes/chatbot-intake.js`

### Step 1.5 — Cross-System Health & Resilience
- Chatbot `/health` also pings recruitment API — reports degraded status if API unreachable
- If recruitment API down: chatbot continues collecting data locally, queues sync
- Log CRITICAL when recruitment API unreachable >5 minutes
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/health.py`, `Chatbot/whatsapp-recruitment-bot/app/services/recruitment_sync.py`

### Step 1.6 — API Key Security *(blocks production launch)*
- Current key is `dewan_chatbot_secret_2024_change_in_production` — **must rotate before launch**
- Generate cryptographically random 32-byte key, store in Google Secret Manager
- Add key rotation support: accept both old and new key during rotation window
- **Files**: `.env` files in both systems, key validation in `recruitment-system/backend/src/routes/chatbot-intake.js`

---

## Phase 2: Sri Lankan Multilingual Overhaul (10x Effectiveness)

### Step 2.1 — Complete Error & System Message Templates *(quick win, do first)*
- **Critical gap**: ALL error messages, validation failures, timeout messages are English-only
- Create templates in all 5 registers for: `error_generic`, `error_validation`, `error_timeout`, `error_cv_processing`, `clarification_needed`, `try_again`, `session_expired`
- Add **Singlish/Tanglish de-escalation messages** (currently missing — frustrated Tanglish user gets formal Tamil response)
- Add urgency tags: "🔥 හදිසි!" (Sinhala), "🔥 அவசரம்!" (Tamil), "🔥 Urgent da!" (Singlish), "🔥 Urgent-ah!" (Tanglish)
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/llm/prompt_templates.py`, `_error_response()` in `Chatbot/whatsapp-recruitment-bot/app/chatbot.py`

### Step 2.2 — Fix Language Detection Accuracy *(critical, do early)*
- **Bug 1**: Register threshold (0.18) too aggressive — "driver" alone triggers Singlish mode → raise to 0.30, require minimum 2 dictionary matches
- **Bug 2**: Confidence threshold (0.65) too strict — real Singlish/Tanglish scoring 0.55-0.64 get demoted → lower to 0.50 with 2-message confirmation
- **Bug 3**: Mixed-script weak — Sinhala Unicode mixed with English misclassified → add weighted scoring (>30% Sinhala Unicode = Sinhala regardless)
- Add **language persistence**: once confirmed (2+ messages), store in DB as default
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/nlp/language_detector.py`

### Step 2.3 — Expand Singlish & Tanglish Dictionaries *(parallel with 2.2)*
- Current: ~180 Singlish, ~150 Tanglish words — missing modern vocabulary
- Add 100+ words per language:
  - **Job terms**: vedakin, samasthanaya, mushthiya (Sinhala); sambalam, anubavam, velai (Tamil)
  - **Common verbs**: kiyanawa, balanna, hadanna (Sinhala); panna, sollu, paru (Tamil)
  - **Modern terms**: WhatsApp-eken, online-ta, apply-karanawa (Sinhala); apply-pannu, online-la (Tamil)
  - **Confirmations**: hari, ow, nehe, epa (Sinhala); seri, aam, illa, venaam (Tamil)
- Add **transliteration variants**: kohomada=kohomede=kohomda, enna=yenna=ennada
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/nlp/language_detector.py`

### Step 2.4 — Natural Code-Switching in LLM Prompts *(depends on 2.1)*
- Current issue: system prompt says "pure Sinhala, no English" — but real speakers naturally code-switch 5-15%
- Update prompts:
  - **Sinhala/Tamil script**: Allow English for technical terms (job titles, countries, salary amounts). Never translate "driver", "Dubai", "salary"
  - **Singlish**: Natural Sinhala grammar + English nouns. E.g., "Dubai la driver job ekak tiyenawa. Apply karanna ready da?"
  - **Tanglish**: Natural Tamil grammar + English nouns. E.g., "Dubai la driver job irriki! 45,000 salary. Apply panna ready-ah?"
- Add **3-5 few-shot examples per register** in the system prompt showing ideal bot responses
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/llm/prompt_templates.py`, `Chatbot/whatsapp-recruitment-bot/app/llm/rag_engine.py`

### Step 2.5 — Vacancy Fallback Templates *(parallel with 2.4)*
- When LLM times out, Singlish/Tanglish users currently get pure Tamil/Sinhala (wrong register)
- Create vacancy presentation templates for Singlish and Tanglish with natural code-switching
- Add no-vacancy-found templates in all 5 registers
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/services/vacancy_service.py`, `Chatbot/whatsapp-recruitment-bot/app/llm/prompt_templates.py`

### Step 2.6 — Unicode Normalization & Misspelling Tolerance *(parallel with 2.3)*
- Add NFC Unicode normalization for Sinhala/Tamil input (diacritics handling)
- Add fuzzy matching for common misspellings in transliterated text
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/nlp/language_detector.py`

### Step 2.7 — Voice Message Support *(independent, parallel with 2.1-2.6)*
- Many Sri Lankans prefer voice over typing Sinhala/Tamil script (hard on phone keyboards)
- Add WhatsApp voice message handling: receive audio → transcribe via **OpenAI Whisper API** (supports Sinhala `si` + Tamil `ta`) → process as text
- This alone could increase usability dramatically for native speakers
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/webhooks.py` (audio handling), new `app/services/voice_service.py`

### Step 2.8 — Proactive Language Adaptation *(depends on 2.2, 2.3)*
- If user starts in English but gradually shifts to Singlish/Tanglish (very common pattern), bot should silently adapt
- Implement **sliding-window detection** over last 3 messages — if majority shift to new register, adapt without asking
- Skip language selection menu for returning users — detect from first message
- Keep language menu only for ambiguous first-time interactions
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/chatbot.py`, `Chatbot/whatsapp-recruitment-bot/app/nlp/language_detector.py`

---

## Phase 3: Performance & Response Quality

### Step 3.1 — Reduce Response Latency *(parallel with Phase 2)*
- Combine intent classification + entity extraction + validation into a **single LLM call**
- Use GPT-4o-mini for classification, GPT-4o only for complex RAG
- Pre-warm job cache before accepting webhooks on startup
- Target: <2s simple responses, <4s RAG responses
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/llm/rag_engine.py`, `Chatbot/whatsapp-recruitment-bot/app/chatbot.py`

### Step 3.2 — Accept CV at Any State *(parallel with 3.1)*
- Currently CV only accepted at `STATE_AWAITING_CV` — early CV uploads get confusing response
- Accept CV at **any state**: parse and store immediately, skip CV-request step later
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/chatbot.py`

### Step 3.3 — Smart Post-Application Handling *(depends on 3.2)*
- After application complete, allow: status queries, interview date queries, document questions
- Block repeated vacancy queries post-application — suggest structured flow for additional jobs
- **Files**: `Chatbot/whatsapp-recruitment-bot/app/chatbot.py`

---

## Verification

1. **Language detection test**: 50-message suite (10 per register) with edge cases — verify >90% correct classification
2. **Integration sync test**: Create job in recruitment frontend → verify in chatbot cache within 10 seconds → query chatbot → verify correct response
3. **CV pipeline test**: Upload PDF/Word/Image CV → verify parsed data → verify data in recruitment system with all fields
4. **Multilingual response test**: Same vacancy query in all 5 registers → verify natural, correct-register responses with correct job data
5. **Error recovery test**: Kill recruitment API → submit application → verify local queue → restart API → verify auto-sync
6. **Latency test**: 20 messages across all registers → verify <2s simple, <4s RAG
7. **Voice message test**: Send Sinhala/Tamil voice notes → verify transcription and correct response
8. **Full E2E test**: Complete intake in Singlish → verify candidate + application in recruitment DB with correct language, all fields populated

---

## Decisions

- **No separate translation layer** — LLM responds directly in target language (more natural than translate-from-English)
- **Whisper API over Google STT** — better Sinhala/Tamil accuracy, already using OpenAI ecosystem
- **GPT-4o-mini for classification, GPT-4o for RAG** — balances cost and quality
- **Hybrid language detection stays** (Unicode + dictionary + LLM fallback) — no heavy ML models
- **API key must be rotated** before production — current key is a known placeholder
- **Meta template approval needed** for business-initiated messages (status updates) — start early

---

## Further Considerations

1. **Regional dialect coverage**: Colombo Sinhala vs. rural differs ("mokakda" vs "mokda"), Jaffna Tamil vs. Colombo Tamil also varies. Include all variants in dictionaries, don't force one standard.

2. **WhatsApp Business template approval**: Status update messages (Step 1.3) need Meta pre-approval in all 5 languages. Draft and submit templates in parallel with development — approval takes 1-3 business days.

3. **Voice message cost**: Whisper API costs ~$0.006/min. At scale (1000+ voice messages/day), consider self-hosted Whisper model on Cloud Run. Start with API, migrate if costs exceed threshold.
