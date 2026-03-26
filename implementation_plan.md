# Agentic Handoff Architecture — Implementation Plan

Replace static fallback messages with LLM-powered contextual steering when users give out-of-bounds answers during the recruitment onboarding flow. The LLM acknowledges what the user said naturally, then gently guides them back to the current onboarding goal — no more robotic repeated questions.

## Proposed Changes

### Prompt Template

#### [MODIFY] [prompt_templates.py](file:///c:/Users/Tiran's%20PC/Documents/GitHub/AI-Recruitment-System/Chatbot/whatsapp-recruitment-bot/app/llm/prompt_templates.py)

Add a new `AGENTIC_TAKEOVER_PROMPT` class constant after `GIBBERISH_FALLBACK` (around line 732). This prompt instructs the LLM to:
- Acknowledge the user's unexpected message naturally
- Steer the conversation back to the current recruitment goal
- Use the candidate's language register (Singlish/Tanglish/script)
- Keep it short (max 2 sentences + emojis)

Also add a `CURRENT_GOAL_MAP` dict mapping chatbot states → human-readable goal descriptions, so we don't hardcode goal strings throughout [chatbot.py](file:///c:/Users/Tiran%27s%20PC/Documents/GitHub/AI-Recruitment-System/Chatbot/whatsapp-recruitment-bot/app/chatbot.py).

---

### RAG Engine

#### [MODIFY] [rag_engine.py](file:///c:/Users/Tiran's%20PC/Documents/GitHub/AI-Recruitment-System/Chatbot/whatsapp-recruitment-bot/app/llm/rag_engine.py)

Add a new async method `generate_agentic_response()` to the [RAGEngine](file:///c:/Users/Tiran%27s%20PC/Documents/GitHub/AI-Recruitment-System/Chatbot/whatsapp-recruitment-bot/app/llm/rag_engine.py#66-1119) class:
- Takes `user_message`, `current_goal`, and [language](file:///c:/Users/Tiran%27s%20PC/Documents/GitHub/AI-Recruitment-System/Chatbot/whatsapp-recruitment-bot/app/chatbot.py#3510-3515) parameters
- Formats the `AGENTIC_TAKEOVER_PROMPT` with context
- Calls `gpt-5.4-mini` (the existing `self.chat_model`) with `temperature=0.7`, `max_tokens=150`
- Returns a natural, contextual steering response
- Falls back to a multilingual fallback message on API error

---

### Chatbot State Machine

#### [MODIFY] [chatbot.py](file:///c:/Users/Tiran's%20PC/Documents/GitHub/AI-Recruitment-System/Chatbot/whatsapp-recruitment-bot/app/chatbot.py)

**Key change:** Replace the central gibberish/low-confidence handler (lines 1334-1363) with agentic handoff. Instead of:
1. Strike 1 → static gibberish fallback + interactive widget
2. Strike 2 → auto-advance with "Unknown"

New flow:
1. **First failed attempt** → `generate_agentic_response()` with the current goal. The LLM acknowledges the user's weird answer and rephrases the question naturally. State does NOT advance.
2. **Second failed attempt** → `generate_agentic_response()` again (different empathetic response). State still doesn't advance.
3. **Third failed attempt** → Auto-advance (existing two-strike logic, bumped to 3 strikes) with interactive widget fallback for accessibility.

Also update the **invalid-input handlers** in each intake state so they call the agentic response instead of static error messages:

| State | Current behavior | New behavior |
|---|---|---|
| `STATE_AWAITING_JOB` (line ~1697) | Static "We don't have that role" + suggestions | Agentic response with goal "Find out their job role" |
| `STATE_AWAITING_COUNTRY` (line ~1840) | Static "I didn't catch that country" + list | Agentic response with goal "Find out their destination country" |
| `STATE_AWAITING_EXPERIENCE` (line ~2175) | Static clarification/buttons | Agentic response with goal "Find out years of experience" |

> [!IMPORTANT]
> The interactive buttons/list fallbacks are kept as **visual aids** sent alongside the agentic response on the second attempt, giving low-literacy users a tap-to-select option. This is not removed — it's enhanced.

---

### Test Script

#### [NEW] [test_agentic_handoff.py](file:///c:/Users/Tiran's%20PC/Documents/GitHub/AI-Recruitment-System/Chatbot/whatsapp-recruitment-bot/scripts/test_agentic_handoff.py)

A standalone test script following the same structure as [test_entity_extraction.py](file:///c:/Users/Tiran's%20PC/Documents/GitHub/AI-Recruitment-System/Chatbot/whatsapp-recruitment-bot/scripts/test_entity_extraction.py). Tests 15+ out-of-bounds conversational scenarios:

| Test scenario | User says | Expected Bot behavior |
|---|---|---|
| Random answer to job question | "I like to go someplace amazing" | Acknowledges + asks about job role conversationally |
| Emotional response to country question | "I lost my passport yesterday" | Empathizes + asks for country/alternative |
| Off-topic to experience question | "My wife is angry at me" | Acknowledges warmly + steers back to experience |
| Singlish gibberish | "aney mokada karanne mama" | Responds in Singlish + rephrases the question |
| Tanglish off-topic | "enna pandrathu theriyala da" | Responds in Tanglish + rephrases the question |

The test verifies:
- Response is NOT identical to any static template
- Response contains no "Invalid" or "error" language
- Response is under 200 characters (WhatsApp brevity)
- Response doesn't repeat the exact same robotic question

## Verification Plan

### Automated Tests
```bash
cd "c:\Users\Tiran's PC\Documents\GitHub\AI-Recruitment-System\Chatbot\whatsapp-recruitment-bot"
python scripts/test_agentic_handoff.py
```

This test calls `rag_engine.generate_agentic_response()` directly with 15+ out-of-bounds scenarios and validates the response quality (not empty, not a robotic repeat, under length limit, matches the conversation context).

### Manual Verification
Since this involves live LLM integration, **please test by sending these messages to the chatbot on WhatsApp** after deploying:
1. When asked "What job are you looking for?" → Send "I like to go someplace amazing"  
2. When asked "Which country?" → Send "I lost my passport yesterday"  
3. When asked "How many years experience?" → Send "My wife is angry at me"  

**Expected:** The bot should NOT repeat the same question robotically. It should respond warmly, acknowledge the message, and naturally steer back to the goal.
