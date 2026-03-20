# Plan: Optimize Chatbot Speed & Multilingual Understanding

**TL;DR**: Make the chatbot respond faster and understand Sinhala/Tamil/Singlish/Tanglish better by: (1) expanding fast-path classification to skip LLM for ~65% of messages, (2) compressing LLM prompts by ~50% tokens, (3) tuning max_tokens/timeouts for speed, (4) enriching language dictionaries, and (5) improving Singlish/Tanglish templates. No flow/state changes needed.

---

### Phase 1: Fast-Path Expansion (Skip LLM for ~65% of messages)
*Can run in parallel with Phase 2. Biggest speed win.*

**Step 1.1** — Expand `_fast_classify()` in [app/chatbot.py](Chatbot/whatsapp-recruitment-bot/app/chatbot.py#L290)
- Add **greetings** in all 5 registers: `ayubowan`, `kohomada`, `vanakkam`, `hi`, etc. → `greeting` intent
- Add **common job titles** in all forms (en/si/ta/singlish/tanglish): `driver`, `nurse`, `cook`, `security`, `රියදුරු`, `ஓட்டுநர்`, `driver velai`, `driver karanna` → `job_title` intent with entity extracted
- Add **country names**: `dubai`, `qatar`, `saudi`, `kuwait`, `malaysia`, `singapore`, `maldives`, `දුබායි`, `கத்தார்`, `சவுதி`, `dubai yanna`, `dubai poganum` → `country` intent
- Add **experience patterns**: `අවුරුදු 5`, `5 வருடம்`, `varudam 5` → `years_experience` intent
- Add **CV phrases**: `cv yawanawa`, `cv anuppuren` → `cv_upload` intent
- Return correct **language code** per token (currently returns `None` for yes/no — should return `si`/`ta`/`singlish`/`tanglish` based on which token matched)

**Step 1.2** — Expand language detector dictionaries in [app/nlp/language_detector.py](Chatbot/whatsapp-recruitment-bot/app/nlp/language_detector.py#L120)
- Add ~30 missing **Singlish** words: `wadeema` (job), `raakiyawa` (job), `salaris` (salary), `gaathe` (money), `passport`, `visa`, `interview`, `applay` (apply misspelling), `readiy` (ready)
- Add ~30 missing **Tanglish** words: `sambalam` (salary), `panam` (money), `vesa` (visa), `apply pannanum`, `ready-ah`, `ok-ah`, `seri-ah`
- Add common **misspellings/variations** Sri Lankans typically use

---

### Phase 2: Prompt Compression & Quality (~50% fewer tokens)
*Can run in parallel with Phase 1. Reduces latency per LLM call.*

**Step 2.1** — Compress `classify_message_async` prompt (~800→400 tokens)
- Replace verbose prose with compact table format: `intent | description | examples`
- Add 3 **few-shot examples** for Tanglish/Singlish edge cases (more effective than long descriptions)
- Remove redundant "IMPORTANT" and "Respond ONLY" sections — GPT-5-mini follows instructions well

**Step 2.2** — Compress `validate_intake_answer_async` prompt (~300→150 tokens)
- Compact validation rules into tight bullet format

**Step 2.3** — Compress `classify_and_validate_async` combined prompt (~600→350 tokens)
- Most impactful — handles all intake states in single LLM call

**Step 2.4** — Compress RAG system prompt language instruction (~500→250 tokens)
- GPT-5-mini understands multilingual instructions natively — remove verbose code-switch scenarios
- Keep the critical "match their communication style" rule

**Step 2.5** — Add few-shot examples for South Asian edge cases
- `"enna job irriki" → vacancy_query` / `"dubai poganum" → country` / `"aama" → apply_intent`
- Few-shot examples are 5x more effective than prose rules for GPT-5-mini

**Files:** [app/llm/rag_engine.py](Chatbot/whatsapp-recruitment-bot/app/llm/rag_engine.py) — all prompt strings and both sync/async variants

---

### Phase 3: Speed Tuning
*Can implement in parallel with Phases 1-2*

**Step 3.1** — Reduce `max_tokens` across all LLM calls:
| Call | Current | Target | Reason |
|------|---------|--------|--------|
| classify_message_async | 200 | 150 | JSON output <100 tokens |
| validate_intake_answer_async | 120 | 100 | Short JSON |
| classify_and_validate_async | 280 | 200 | Combined JSON |
| generate_response_async | 220 | 180 | WhatsApp = short msgs |
| generate_missing_field_question | 80 | 60 | Single sentence |
| analyze_cv | 300 | 200 | Summary only |

**Step 3.2** — Tighten timeouts: 10s→8s for classify, 15s→10s for generate, 12s→9s for combined

**Step 3.3** — Increase cache TTL & size: 120s→300s, 500→1000 entries — same intent doesn't change in 5 minutes

**File:** [app/llm/rag_engine.py](Chatbot/whatsapp-recruitment-bot/app/llm/rag_engine.py) — constants and all `create()` calls

---

### Phase 4: Template Enrichment
*Independent of all other phases*

**Step 4.1** — Clean up duplicate `job_confirmed` acknowledgment block in [prompt_templates.py](Chatbot/whatsapp-recruitment-bot/app/llm/prompt_templates.py#L400) (currently defined twice with slightly different structure)

**Step 4.2** — Improve Tanglish/Singlish template naturalness
- Current: `"Eppo poiya — which country poiya work pannanumnnu theriyuma?"` (awkward mix)
- Target: `"Enna naadu poiya work pannanum? Dubai, Qatar, Saudi — sollunga da 🌍"` (natural code-switch)

---

### Phase 5: Smarter Language-Aware Routing
*Depends on Phase 1*

**Step 5.1** — When `_fast_classify()` detects a Sinhala/Tamil/Singlish/Tanglish token, return the correct language code so the response uses matching templates without needing a separate LLM language detection call

**Step 5.2** — Ensure fast-path-handled messages get responses in the user's actual register (e.g., Tanglish input → Tanglish template reply, not formal Tamil)

---

### Relevant Files
- [app/llm/rag_engine.py](Chatbot/whatsapp-recruitment-bot/app/llm/rag_engine.py) — Prompt compression, max_tokens, timeouts, cache (main target)
- [app/chatbot.py](Chatbot/whatsapp-recruitment-bot/app/chatbot.py) — `_fast_classify()` expansion, language routing
- [app/nlp/language_detector.py](Chatbot/whatsapp-recruitment-bot/app/nlp/language_detector.py) — Dictionary expansion
- [app/llm/prompt_templates.py](Chatbot/whatsapp-recruitment-bot/app/llm/prompt_templates.py) — Template cleanup & enrichment

### Verification
1. Test `_fast_classify()` with inputs in all 5 languages — verify correct intents for common patterns
2. Measure prompt token count before/after — target 50% reduction
3. Time LLM API calls — target <800ms classify, <1.2s response generation
4. End-to-end flow test in each language: English, Sinhala, Tamil, Singlish, Tanglish
5. Verify cache hit ratio improves (add logging if needed)
6. Regression: English flow must be unaffected

### Decisions
- **No streaming** — WhatsApp API sends complete messages; streaming would create multiple message bubbles
- **Aggressive prompt compression** — GPT-5-mini reasons well with compact instructions
- **Fast-path to ~65%** — Recruitment intents are highly predictable (greetings, job titles, countries, yes/no)
- **Hybrid templates + LLM** — Templates for standard flow, LLM only for questions/unusual input
- **Out of scope**: Conversation flow/states, CV processing pipeline, recruitment sync, database schema
