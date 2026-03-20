I have everything I need. Here is the comprehensive plan.

---

## Plan: S-Tier AI Recruitment Chatbot — Full Overhaul

**What & Why:** Your system already has GPT-4o, a CV parser, a state machine, and a recruitment API — but they are not wired together correctly. The chatbot falls back to templates because the vacancy intent pipeline bypasses the LLM, the `job_cache` has a startup race condition, and Tanglish/Singlish break all regex-based detection. This plan fixes every layer: language understanding → DB lookup → LLM refinement → human-like response, wrapped in a proper onboarding flow with WhatsApp interactive buttons.

---

### Architecture: The Full Pipeline

```
User Input (any: English / Tamil / Sinhala / Tanglish / Singlish)
     │
     ▼
[1] LANGUAGE DETECTION
     Unicode ranges (native script) → instant
     Short/mixed text → GPT-4o micro-call (classify lang + intent together)
     │
     ▼
[2] LLM INTENT CLASSIFICATION  (single GPT-4o call)
     Input: raw message + conversation history + candidate state
     Output: { intent, language, confidence, extracted_entities }
     Entities: job_role, country, skills[], experience, question_type
     │
     ├── intent=vacancy_query / skill_match / country_search
     │        ↓
     │   [3A] DB LOOKUP (PostgreSQL via recruitment API or direct psycopg2)
     │        Parameterised queries: jobs, projects, requirements
     │        ↓
     │   [3B] LLM REFINEMENT  (GPT-4o)
     │        Prompt: raw DB rows + user's original question + language lock
     │        Output: conversational, accurate, language-matched response
     │        ↓
     │   WhatsApp response (text + optional job list menu)
     │
     ├── intent=apply
     │        ↓
     │   [4] PRE-SCREENING FLOW (state machine)
     │        Job interest → Country → Experience → Special reqs → CV upload
     │        ↓
     │   CV PARSER (PyMuPDF → OCR → GPT-4o extraction)
     │        ↓
     │   RECRUITMENT SYNC → POST /api/chatbot/intake
     │
     └── intent=general_support
              ↓
         RAG knowledge base lookup → GPT-4o → response
```

---

### Steps

**1. Fix the Critical `job_cache` Race Condition**
- In app/chatbot.py, replace the current at-startup single-fetch with a **resilient background polling loop** (every 5 min via `asyncio.create_task`).
- On each vacancy query, if `job_cache` is older than 5 min → trigger a refresh in background, serve stale cache instantly; this means the bot never answers "I don't know" due to cold-start.
- Add a **direct PostgreSQL fallback**: if the REST API (`GET /api/chatbot/jobs`) fails, connect directly to the recruitment system's PostgreSQL via `psycopg2` using a dedicated read-only connection string in `.env`.

**2. Replace the Regex Intent Gate with an LLM-First Intent Pipeline**
- In app/llm/rag_engine.py, extend `classify_intent()` into a `classify_message()` method that:
  - Takes: `raw_message`, `conversation_state`, `language_preference`
  - Returns a structured JSON: `{ "intent": "vacancy_query|skill_match|country_search|apply_intent|language_switch|general|greeting", "language": "en|ta|si|tanglish|singlish", "confidence": 0.0-1.0, "entities": { "job_roles": [], "countries": [], "skills": [], "experience_years": null } }`
- This **single GPT-4o call** handles Tanglish, Singlish, partial sentences, typos, and mixed scripts — no keyword lists needed.
- System prompt for this call is crafted specifically for Sri Lankan/Tamil recruiter context — it knows what "aney I'm good in driving lah", "salary kohomada", "job ekak thiyanawada" mean.
- In app/chatbot.py, replace all `_is_vacancy_question()`, `_detect_language_switch()`, and `_handle_greeting()` regex checks with a single call to `classify_message()` before any state routing.

**3. Build the DB Lookup + LLM Refinement Layer**
- Create `app/services/vacancy_service.py`:
  - `search_vacancies(entities: dict, lang: str) -> dict` — queries the REST API (`GET /api/chatbot/jobs`) with filters (job title keywords, country, skill match), falls back to direct PostgreSQL if API is down.
  - Returns raw rows: `[{ title, country, requirements, salary_info, deadline, project_name }]`
- Create `app/llm/response_refiner.py`:
  - `refine_vacancy_response(raw_db_rows: list, user_message: str, entities: dict, language: str) -> str`
  - GPT-4o prompt: *"You are Dilan, a friendly recruiter at [Company]. The user asked in [language]: '[original message]'. Here are the matching jobs from our database: [JSON]. Respond naturally in [language], be concise, mention key details (role, country, requirements, how to apply). If no jobs match, say so kindly and offer to help."*
  - The language is passed as a hard instruction — GPT-4o handles English, fluent Sinhala, fluent Tamil, Tanglish, and Singlish natively without a separate translation API.

**4. WhatsApp Interactive Messages**
- In app/utils/meta_client.py (or equivalent), add:
  - `send_language_selector()` — WhatsApp list message with 3 rows: 🇬🇧 English / සිංහල Sinhala / தமிழ் Tamil
  - `send_job_list(jobs: list)` — WhatsApp list message showing up to 10 jobs with title + country as subtitle; user taps to apply
  - `send_quick_reply(text: str, options: list)` — 3-button quick reply (e.g., "Apply Now / Tell me more / See other jobs")
  - `send_yes_no(question: str)` — 2-button reply for yes/no gates

**5. Overhaul the Onboarding Flow in `chatbot.py`**

The revised `STATE_INITIAL` → `STATE_AWAITING_LANGUAGE_SELECTION` block:

- First message from any new user → immediately send the **WhatsApp interactive language selector** (list message, no text prompt needed — the button labels are self-explanatory in their own script).
- On language selection → set `candidate.language_preference` in DB → send: *"Welcome! How can I help you today?"* + quick reply buttons: **"Apply for a job" / "View vacancies" / "Ask a question"** — all in the chosen language, sourced from the `translations` table.
- All subsequent messages in the conversation run through the `classify_message()` LLM call first, respecting the stored `language_preference`.

**6. Pre-Screening Flow Hardening**
- In app/chatbot.py, each `STATE_AWAITING_*` step must use `validate_intake_answer()` already in app/llm/rag_engine.py — currently it exists but is not consistently called.
- Steps: Job interest (with job list tap-to-select) → Country preference → Experience years → Special requirements (if job has them) → CV upload prompt.
- On each step, if the user's answer is ambiguous (e.g., "maybe driver or something"), run `classify_message()` to extract the entity before validating — never reject and ask again for the same reason.
- Job matching: after `STATE_AWAITING_JOB_INTEREST`, run the extracted `job_roles[]` and `skills[]` against `vacancy_service.search_vacancies()` → present matched jobs as a WhatsApp list → user taps the one they want → auto-fills `application.job_id`.

**7. CV Collection & Recruitment Sync**
- `STATE_AWAITING_CV`: send a human-like prompt in the chosen language (already has trilingual templates — verify they are used). Accept PDF, Word, image.
- After CV received: run the existing 4-layer pipeline (app/cv_parser/document_processor.py) — this already works well.
- Gap-fill: if CV extraction confidence < 0.7 for a required field (name/email/phone), ask specifically for that field only — not a generic "please provide details" dump.
- `STATE_APPLICATION_COMPLETE`: call `recruitment_sync.push()` → `POST /api/chatbot/intake` on the recruitment system. If this fails → retry 3× with exponential backoff (add a simple retry wrapper around the `httpx` call). On permanent failure → save to a `pending_sync` DB table and process on next startup.
- Send final confirmation message with application reference number in chosen language.

**8. Language-Specific Response Quality**
- No separate translation layer needed — GPT-4o handles all five input forms natively.
- The **language lock** instruction in the system prompt (already in app/llm/prompt_templates.py) is extended to explicitly cover Tanglish/Singlish: *"If the user writes in Tanglish (Tamil + English mixed) or Singlish (Sinhala + English mixed), reply in the same natural mixed style — do not force pure Tamil or pure Sinhala."*
- All hardcoded template strings (greetings, errors, prompts) that currently live in `prompt_templates.py` should be migrated to the `translations` DB table so they can be updated without a code deploy.

**9. PostgreSQL Direct Fallback Connection**
- Add `RECRUITMENT_DB_URL` to `.env` (read-only PostgreSQL connection string to the recruitment system's DB).
- In `vacancy_service.py`, if REST API returns non-200 → try `psycopg2` direct query against the `jobs` + `projects` tables.
- This removes the dependency on the Node.js recruitment API being up.

---

### Verification

```bash
# 1. Test language + intent classification (all 5 input types)
python scripts/test_chatbot.py --msg "what jobs available" --lang en
python scripts/test_chatbot.py --msg "mokakda job thiyanne" --lang singlish
python scripts/test_chatbot.py --msg "job enna irriki" --lang tanglish
python scripts/test_chatbot.py --msg "රැකියා පුරප්පාඩු?" --lang si
python scripts/test_chatbot.py --msg "என்ன வேலை காலியிடங்கள்?" --lang ta

# 2. Test vacancy DB pipeline
python scripts/test_full_flow.py --scenario vacancy_query

# 3. Test full application flow
python scripts/test_full_flow.py --scenario full_application

# 4. Test CV upload + sync
python scripts/test_cv_extraction.py --file sample_cv.pdf

# 5. Run the chatbot + hit the webhook manually
python -m uvicorn app.main:app --reload
curl -X POST localhost:8000/webhook/whatsapp -d @test_payload.json
```

**Manual WhatsApp test scenarios:**
- New number → language selector appears → select Tamil → Tanglish vacancy question → job list appears → tap job → pre-screening → CV upload → confirmation message in Tamil.
- Returning user → greets in previously saved language → mid-conversation language switch → rest of conversation in new language.

---

### Decisions Made

- **No separate translation library** (e.g., `deep-translator`) — GPT-4o handles all five language forms natively and with far better nuance for mixed-script colloquial text.
- **REST API first, direct PostgreSQL as fallback** — removes single point of failure; `psycopg2` replaces the `pymysql` reference in config for the recruitment DB.
- **Interactive buttons for UX** — language selection and job browsing as WhatsApp list messages, not free-text prompts; dramatically reduces misunderstanding.
- **LLM-first intent detection** — replace all regex intent gates; the `classify_message()` GPT-4o call costs < $0.001 per message and eliminates every Tanglish/Singlish edge case.
- **Retry queue for recruitment sync** — a simple `pending_sync` table rather than adding Celery dependency, keeping the footprint lean.