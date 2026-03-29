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


async def route_user_message(user_message: str, session_state: dict) -> dict:
    """
    Acts as the master router. Decides if the AI should reply with a text message,
    or execute a WhatsApp UI tool based on the conversation context.
    
    Args:
        user_message: The raw text from the user
        session_state: Dict containing at minimum {"language": "en"/"si"/"ta" or None}
    
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
    
    # Extract current state
    current_lang = session_state.get("language", "Unknown")
    is_new_user = not bool(current_lang) or current_lang == "Unknown"
    
    system_prompt = f"""
You are the Elite AI Recruiter for Dewan Consultants in Sri Lanka.
The user's preferred language is locked to: {current_lang}. 
ALWAYS reply in {current_lang} using culturally appropriate, warm phrasing.

YOUR OBJECTIVE: Onboard the candidate by getting their Name, Job Role, and Preferred Country.

RULES:
1. If the user is new/language is Unknown, IMMEDIATELY call the `show_language_selector` tool.
2. If the user asks to see jobs, call the `show_vacancies_list` tool.
3. If the user wants to apply, chat with them naturally to gather their Name, Job Role, and Country. Ask ONE question at a time.
4. If the user sends a vague message or gibberish, DO NOT SAY "I don't understand". Gently pivot back: "To help you best, what kind of work are you looking for?"
5. CRITICAL: Once you have extracted the Name, Job Role, and Country, DO NOT ask any more questions. IMMEDIATELY call the `submit_candidate_profile` tool.
"""

    try:
        client = _get_client()
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message}
            ],
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
