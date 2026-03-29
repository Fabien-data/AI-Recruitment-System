"""
Elite AI Router — Dewan Consultants LLM Brain
==============================================
Uses OpenAI GPT-4o-mini with Function Calling to route conversation.

The AI has 4 buttons (tools) it can press:
  1. show_language_selector → Display language buttons
  2. show_main_menu → Display main menu list
  3. show_vacancies_list → Fetch &display job listings
  4. submit_candidate_profile → Save Name, Job Role, Country to CRM

No regex. No state machines. Just pure LLM reasoning.
"""

import os
import json
import logging
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

# Lazy-init: OpenAI client will be initialized in route_user_message()
_client = None

def _get_client():
    """Get or create the AsyncOpenAI client (lazy initialization)."""
    global _client
    if _client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError(
                "OPENAI_API_KEY environment variable is not set. "
                "Please set it before calling route_user_message()"
            )
        _client = AsyncOpenAI(api_key=api_key)
    return _client

# ─── TOOL DEFINITIONS (The "Buttons" the AI can press) ────────────────────────

DEWAN_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "show_language_selector",
            "description": "Show the WhatsApp language selection buttons to a new user.",
            "parameters": {
                "type": "object",
                "properties": {
                    "greeting": {
                        "type": "string",
                        "description": "A warm greeting in the user's natively detected language (e.g., 'ආයුබෝවන්', 'வணக்கம்', 'Hello')."
                    }
                },
                "required": ["greeting"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "show_main_menu",
            "description": "Show the main WhatsApp list menu: Apply for a Job, View Vacancies, Ask a Question.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "show_vacancies_list",
            "description": "Show a list of current job vacancies to the user.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "submit_candidate_profile",
            "description": "Call this ONLY when you have successfully gathered the user's Name, Desired Job Role, and Preferred Country. This saves them to the CRM.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "job_role": {"type": "string"},
                    "preferred_country": {"type": "string"}
                },
                "required": ["name", "job_role", "preferred_country"]
            }
        }
    }
]


async def route_user_message(user_message: str, session_state: dict, chat_history: list = None) -> dict:
    """
    Acts as the master router with memory injection. Decides if the AI should reply with a text message,
    or execute a WhatsApp UI tool based on the conversation context.
    
    UPGRADED: Now accepts chat_history to prevent Amnesia Loops and enable natural context-aware responses.
    
    Args:
        user_message: The raw text from the user
        session_state: Dict containing at minimum {"language": "en"/"si"/"ta" or None, 
                       candidate_name, candidate_job, candidate_country (known values)}
        chat_history: List of last 4 message dicts: [{"role": "user"|"assistant", "content": "..."}, ...]
    
    Returns:
        Either:
        {
            "action": "chat",
            "message": "Text to send to user"
        }
        OR
        {
            "action": "tool_call",
            "tool_name": "show_language_selector"|"show_main_menu"|"show_vacancies_list"|"submit_candidate_profile",
            "arguments": {...}
        }
    """
    
    if chat_history is None:
        chat_history = []
    
    # Extract current state
    current_lang = session_state.get("language", "Unknown")
    is_new_user = not bool(current_lang) or current_lang == "Unknown"
    
    # ── EXTRACT KNOWN PROFILE DATA ──────────────────────────────────────────────
    known_name = session_state.get("candidate_name", "MISSING")
    known_job = session_state.get("candidate_job", "MISSING")
    known_country = session_state.get("candidate_country", "MISSING")
    
    # ── ELITE PROMPT v2 (MEMORY-INJECTED, NO AMNESIA LOOPS) ─────────────────────
    system_prompt = f"""
You are the Elite AI Recruiter for Dewan Consultants in Sri Lanka.
The user's preferred language is: {current_lang}. 

CRITICAL LANGUAGE RULES:
1. NEVER use formal/written dictionary Sinhala or Tamil. 
2. ALWAYS use casual, spoken, street-level dialect (e.g., use 'ඔයා' instead of 'ඔබ', use 'රස්සාව/වැඩ' instead of 'රැකියාව'). 
3. Keep responses extremely short (1-2 sentences maximum).

YOUR OBJECTIVE: Gather the missing profile data to call `submit_candidate_profile`.

CURRENT PROFILE STATUS (DO NOT ask for information that is already Known):
- Name: {known_name}
- Job Role: {known_job}
- Preferred Country: {known_country}

BEHAVIORAL GUARDRAILS:
1. ONLY ask for ONE 'MISSING' item at a time. Never ask two questions in one message.
2. If the user says "Ow", "Hari", "OK", or sends an emoji, acknowledge it warmly and immediately ask for the next 'MISSING' item.
3. If ALL items are filled, DO NOT chat. Call the `submit_candidate_profile` tool immediately.
4. If the user is speaking Tanglish/Singlish, match their tone but map the data to English internally.
"""

    try:
        client = _get_client()
        
        # ── BUILD COMPLETE MESSAGE HISTORY ──────────────────────────────────────
        # Format: [system, ...chat_history, current_user_message]
        messages = [
            {"role": "system", "content": system_prompt}
        ]
        
        # Add unpacked chat history
        if chat_history:
            messages.extend(chat_history)
        
        # Add current user message
        messages.append({"role": "user", "content": user_message})
        
        logger.debug(f"📜 Message history: {len(messages)} messages (system + {len(chat_history)} history + current)")
        
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            tools=DEWAN_TOOLS,
            tool_choice="auto",
            temperature=0.2
        )
        
        message = response.choices[0].message
        
        # Check if the AI decided to call a tool
        if message.tool_calls:
            tool_call = message.tool_calls[0]
            return {
                "action": "tool_call",
                "tool_name": tool_call.function.name,
                "arguments": json.loads(tool_call.function.arguments)
            }
        else:
            # The AI just wants to send a standard text chat
            return {
                "action": "chat",
                "message": message.content.strip()
            }

    except Exception as e:
        logger.error(f"Routing error: {e}")
        # Failsafe: Graceful fallback
        return {
            "action": "chat",
            "message": "I'm experiencing a brief delay. Could you tell me what job role you are looking for?"
        }
