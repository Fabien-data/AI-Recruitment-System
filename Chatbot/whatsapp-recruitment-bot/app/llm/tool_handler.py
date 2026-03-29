"""
Agent Tool Handler — Executes Tool Calls from the LLM
====================================================
When the LLM decides to call a tool (show_language_selector, show_main_menu, etc.),
this handler executes those tools and interacts with the database and Meta WhatsApp API.
"""

import logging
import json
from typing import Dict, Any, Optional, List

from sqlalchemy.orm import Session
from app import crud
from app.models import Candidate, MessageType
from app.schemas import ConversationCreate, CandidateUpdate
from app.database import SessionLocal
from app.utils.meta_client import meta_client
from app.services.vacancy_service import vacancy_service
from app.llm.agent_router import RouterAction

logger = logging.getLogger(__name__)


class ToolHandler:
    """
    Handles execution of LLM tool calls.
    Each tool method interacts with databases and external APIs.
    """
    
    def __init__(self, db: Session):
        self.db = db
    
    async def execute_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        phone_number: str,
        candidate_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Execute a tool call from the LLM.
        
        Args:
            tool_name: Name of the tool (show_language_selector, etc.)
            arguments: Tool arguments from the LLM
            phone_number: WhatsApp phone number of the user
            candidate_id: Optional candidate ID for database lookups
        
        Returns:
            {
                'success': bool,
                'message': str,
                'whatsapp_payload': dict (optional — ready to send to Meta),
                'db_updates': dict (optional — updates to persist)
            }
        """
        
        logger.info(f"Executing tool: {tool_name} for {phone_number}")
        
        try:
            if tool_name == "show_language_selector":
                return await self._show_language_selector(
                    arguments,
                    phone_number,
                    candidate_id
                )
            
            elif tool_name == "show_main_menu":
                return await self._show_main_menu(phone_number, candidate_id)
            
            elif tool_name == "show_vacancies_list":
                return await self._show_vacancies_list(phone_number, candidate_id)
            
            elif tool_name == "submit_candidate_profile":
                return await self._submit_candidate_profile(
                    arguments,
                    phone_number,
                    candidate_id
                )
            
            else:
                return {
                    'success': False,
                    'message': f"Unknown tool: {tool_name}"
                }
        
        except Exception as e:
            logger.error(f"Error executing tool {tool_name}: {str(e)}", exc_info=True)
            return {
                'success': False,
                'message': f"Tool execution failed: {str(e)}"
            }
    
    async def _show_language_selector(
        self,
        arguments: Dict[str, Any],
        phone_number: str,
        candidate_id: Optional[int]
    ) -> Dict[str, Any]:
        """
        Trigger the WhatsApp interactive buttons for language selection.
        """
        
        greeting_text = arguments.get(
            "detected_language_greeting",
            "Please select your language"
        )
        
        # Build WhatsApp interactive message with 3 buttons
        whatsapp_payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": phone_number,
            "type": "interactive",
            "interactive": {
                "type": "button",
                "body": {
                    "text": greeting_text
                },
                "action": {
                    "buttons": [
                        {"type": "reply", "reply": {"id": "lang_en", "title": "English"}},
                        {"type": "reply", "reply": {"id": "lang_si", "title": "සිංහල"}},
                        {"type": "reply", "reply": {"id": "lang_ta", "title": "தமிழ்"}}
                    ]
                }
            }
        }
        
        # Send via Meta API
        meta_response = await meta_client.send_message(whatsapp_payload)
        
        logger.info(f"Language selector sent to {phone_number}")
        
        return {
            'success': True,
            'message': "Language selector displayed",
            'whatsapp_payload': whatsapp_payload,
            'db_updates': {
                'conversation_state': 'language_selection'
            }
        }
    
    async def _show_main_menu(
        self,
        phone_number: str,
        candidate_id: Optional[int]
    ) -> Dict[str, Any]:
        """
        Trigger the WhatsApp interactive list showing main menu.
        """
        
        whatsapp_payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": phone_number,
            "type": "interactive",
            "interactive": {
                "type": "list",
                "body": {
                    "text": "What would you like to do today?"
                },
                "action": {
                    "button": "Choose",
                    "sections": [
                        {
                            "title": "Main Menu",
                            "rows": [
                                {
                                    "id": "apply_job",
                                    "title": "Apply for a Job",
                                    "description": "Submit your application"
                                },
                                {
                                    "id": "view_vacancies",
                                    "title": "View Job Vacancies",
                                    "description": "Browse available positions"
                                },
                                {
                                    "id": "ask_question",
                                    "title": "Ask a Question",
                                    "description": "Get help or inquiries"
                                }
                            ]
                        }
                    ]
                }
            }
        }
        
        meta_response = await meta_client.send_message(whatsapp_payload)
        
        logger.info(f"Main menu sent to {phone_number}")
        
        return {
            'success': True,
            'message': "Main menu displayed",
            'whatsapp_payload': whatsapp_payload,
            'db_updates': {
                'conversation_state': 'main_menu'
            }
        }
    
    async def _show_vacancies_list(
        self,
        phone_number: str,
        candidate_id: Optional[int]
    ) -> Dict[str, Any]:
        """
        Fetch top 5 jobs from the database and display as WhatsApp list.
        """
        
        try:
            # Fetch top 5 vacancies from the vacancy service
            vacancies = await vacancy_service.get_top_vacancies(limit=5)
            
            if not vacancies:
                return {
                    'success': True,
                    'message': "No vacancies available at the moment",
                    'whatsapp_send': True,
                    'notification': "No jobs available"
                }
            
            # Build WhatsApp list payload
            rows = []
            for i, job in enumerate(vacancies, 1):
                rows.append({
                    "id": f"job_{job.id}",
                    "title": job.title[:24],  # WhatsApp title limit
                    "description": f"{job.country} - {job.seniority_level}"[:72]  # Description limit
                })
            
            whatsapp_payload = {
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": phone_number,
                "type": "interactive",
                "interactive": {
                    "type": "list",
                    "body": {
                        "text": "Available job positions:"
                    },
                    "action": {
                        "button": "View",
                        "sections": [
                            {
                                "title": "Open Positions",
                                "rows": rows
                            }
                        ]
                    }
                }
            }
            
            meta_response = await meta_client.send_message(whatsapp_payload)
            
            logger.info(f"Vacancies list sent to {phone_number} ({len(vacancies)} jobs)")
            
            return {
                'success': True,
                'message': f"Vacancies list displayed ({len(vacancies)} jobs)",
                'whatsapp_payload': whatsapp_payload,
                'db_updates': {
                    'conversation_state': 'viewing_vacancies'
                }
            }
        
        except Exception as e:
            logger.error(f"Error fetching vacancies: {str(e)}", exc_info=True)
            return {
                'success': False,
                'message': f"Failed to fetch vacancies: {str(e)}"
            }
    
    async def _submit_candidate_profile(
        self,
        arguments: Dict[str, Any],
        phone_number: str,
        candidate_id: Optional[int]
    ) -> Dict[str, Any]:
        """
        Submit the candidate's profile to the CRM/Database.
        This is called SILENTLY by the LLM once it has gathered Name, Job Role, Country.
        """
        
        name = arguments.get("name")
        job_role = arguments.get("job_role")
        preferred_country = arguments.get("preferred_country")
        experience_years = arguments.get("experience_years")
        cv_text = arguments.get("cv_text")
        
        # Validate required fields
        if not all([name, job_role, preferred_country]):
            return {
                'success': False,
                'message': "Missing required fields for profile submission"
            }
        
        try:
            # Get or create candidate in database
            if candidate_id:
                candidate = self.db.query(Candidate).filter(
                    Candidate.id == candidate_id
                ).first()
            else:
                candidate = self.db.query(Candidate).filter(
                    Candidate.phone_number == phone_number
                ).first()
            
            if not candidate:
                # Create new candidate
                candidate = Candidate(
                    phone_number=phone_number,
                    name=name,
                    conversation_state='application_submitted'
                )
                self.db.add(candidate)
            else:
                # Update existing candidate
                candidate.name = name
                candidate.conversation_state = 'application_submitted'
            
            # Store extracted data
            candidate.extracted_profile = {
                "job_role": job_role,
                "target_countries": [preferred_country],
                "experience_years": experience_years,
                "cv_text": cv_text if cv_text else None
            }
            
            # Save to database
            self.db.commit()
            candidate_id = candidate.id
            
            logger.info(
                f"Candidate {candidate_id} ({name}) submitted: {job_role} in {preferred_country}"
            )
            
            # Send confirmation message to WhatsApp
            confirmation_text = (
                f"✅ Thank you, {name.split()[0]}! Your application for **{job_role}** in "
                f"**{preferred_country}** has been successfully submitted.\n\n"
                f"Our team will review your profile and get back to you soon. 🎉"
            )
            
            # Log the application in conversation history
            conversation = ConversationCreate(
                candidate_id=candidate_id,
                user_message=f"[AUTO] Submitted profile: {job_role} in {preferred_country}",
                bot_message=confirmation_text,
                message_type=MessageType.BOT
            )
            crud.create_conversation(self.db, conversation)
            
            return {
                'success': True,
                'message': f"Profile submitted: {name} ({job_role})",
                'whatsapp_send': True,
                'notification': confirmation_text,
                'db_updates': {
                    'conversation_state': 'application_submitted',
                    'extracted_profile': candidate.extracted_profile
                }
            }
        
        except Exception as e:
            logger.error(f"Error submitting candidate profile: {str(e)}", exc_info=True)
            self.db.rollback()
            return {
                'success': False,
                'message': f"Failed to submit profile: {str(e)}"
            }


# ─── Integration Helper ──────────────────────────────────────────────────────

async def handle_router_result(
    result: Dict[str, Any],
    phone_number: str,
    candidate_id: Optional[int] = None,
    db: Optional[Session] = None
) -> Dict[str, Any]:
    """
    High-level handler that processes the router result and executes tools if needed.
    
    Args:
        result: Output from agent_router.route_user_message()
        phone_number: WhatsApp phone number
        candidate_id: Optional candidate ID
        db: SQLAlchemy database session
    
    Returns:
        {
            'action': 'chat' | 'tool_executed' | 'error',
            'message': str,
            'whatsapp_payload': dict (optional)
        }
    """
    
    if not db:
        db = SessionLocal()
    
    handler = ToolHandler(db)
    
    action = result.get('action')
    
    if action == RouterAction.CHAT:
        # Just return the chat message
        message = result.get('message', '')
        
        # Send to WhatsApp
        await meta_client.send_text_message(phone_number, message)
        
        # Log conversation
        if candidate_id:
            conversation = ConversationCreate(
                candidate_id=candidate_id,
                bot_message=message,
                message_type=MessageType.BOT
            )
            crud.create_conversation(db, conversation)
        
        return {
            'action': 'chat',
            'message': message
        }
    
    elif action == RouterAction.TOOL_CALL:
        # Execute the tool
        tool_name = result.get('tool_name')
        arguments = result.get('arguments', {})
        
        tool_result = await handler.execute_tool(
            tool_name=tool_name,
            arguments=arguments,
            phone_number=phone_number,
            candidate_id=candidate_id
        )
        
        # If tool resulted in a notification, send it
        if tool_result.get('whatsapp_send') or tool_result.get('notification'):
            notification = tool_result.get('notification', '')
            if notification:
                await meta_client.send_text_message(phone_number, notification)
        
        # If tool resulted in a WhatsApp payload, send it
        if tool_result.get('whatsapp_payload'):
            await meta_client.send_message(tool_result['whatsapp_payload'])
        
        logger.info(f"Tool executed: {tool_name} -> {tool_result.get('message')}")
        
        return {
            'action': 'tool_executed',
            'tool': tool_name,
            'message': tool_result.get('message')
        }
    
    elif action == RouterAction.ERROR:
        # Handle error gracefully
        error_msg = result.get('error', 'An error occurred')
        logger.error(f"Router error: {error_msg}")
        
        # Send a warm fallback message
        fallback = "I'm having a bit of trouble understanding that. Could you please rephrase? 😊"
        await meta_client.send_text_message(phone_number, fallback)
        
        return {
            'action': 'error',
            'message': error_msg
        }
    
    else:
        # Unknown action
        return {
            'action': 'error',
            'message': f"Unknown router action: {action}"
        }
