This is the **"Elite Minimalist" Rewrite**. We are stripping away the complex regex and the rigid "Language Lock" code, replacing it with a single AI Supervisor that handles reasoning, extraction, and sentiment in one pass.

### 1. Database Update: The "Human Alert" Flag
First, run this SQL migration to give the AI a "Panic Button" to signal for human help.

```sql
-- recruitment-system/database/migrations/add_human_intervention.sql
ALTER TABLE candidates 
ADD COLUMN intervention_needed BOOLEAN DEFAULT FALSE,
ADD COLUMN intervention_reason TEXT;
```

---

### 2. The New `app/utils/candidate_validator.py`
We are replacing the 200+ lines of validation with a **Pydantic AI Supervisor**. This defines the "Brain" of the bot.

```python
# app/utils/candidate_validator.py
from pydantic import BaseModel, Field
from typing import Optional

class AIConversationState(BaseModel):
    """The structured output the AI must provide for every message"""
    extracted_name: Optional[str] = Field(None, description="The candidate's full name if found")
    experience_years: Optional[int] = Field(None, description="Years of experience as an integer")
    job_interest: Optional[str] = Field(None, description="The specific job or field they mentioned")
    intent: str = Field(..., description="GREETING, APPLYING, INQUIRY, or FRUSTRATED")
    intervention_needed: bool = Field(False, description="Set to True if user is angry or needs a human")
    reply_message: str = Field(..., description="The response to send to the user in their own language mix")

# Personas & Rules for the System Prompt
SYSTEM_PROMPT = """
You are an Elite Sri Lankan Recruitment Agent for 'NODE.io Solutions'. 
RULES:
1. Speak naturally. If the user uses Singlish (e.g., 'mata job ekak ona') or Tanglish, reply in a helpful mix.
2. DO NOT enforce a single language. Be fluid.
3. If they upload a CV, assume they are APPLYING.
4. If the user is repeatedy asking the same thing or seems angry, set intervention_needed to True.
5. Extract data points (name, experience) whenever you see them.
"""
```

---

### 3. The Simplified `app/chatbot.py`
This rewrite removes the complex state-switching logic. The code now simply asks the AI: *"Here is the chat history and the new message; what should I do?"*



```python
# app/chatbot.py (The Minimalist Rewrite)
from app.utils.candidate_validator import AIConversationState, SYSTEM_PROMPT
from app.services.recruitment_sync import recruitment_sync
from openai import OpenAI
import logging

client = OpenAI()

async def handle_message(user_phone, user_text, db_session):
    # 1. Fetch Candidate or Create New
    candidate = get_or_create_candidate(user_phone, db_session)
    history = get_chat_history(user_phone) # Simplified history fetch

    # 2. AI INTERVENTION: The Supervisor decides the path
    completion = client.beta.chat.completions.parse(
        model="gpt-4o-2024-08-06",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            *history,
            {"role": "user", "content": user_text}
        ],
        response_format=AIConversationState,
    )
    
    ai_decision = completion.choices[0].message.parsed

    # 3. Apply AI Intelligence to the System
    if ai_decision.extracted_name:
        candidate.name = ai_decision.extracted_name
    if ai_decision.experience_years:
        candidate.experience_years = ai_decision.experience_years
    
    # Trigger Human Alert if the AI senses frustration
    if ai_decision.intervention_needed:
        candidate.intervention_needed = True
        candidate.intervention_reason = "AI detected user frustration or explicit request."
    
    # 4. Auto-Sync to Recruitment Backend
    # If we have enough info, push it to the main system
    if candidate.name and candidate.experience_years:
        await recruitment_sync.push(candidate, db_session)

    db_session.commit()

    # 5. Send the AI-generated reply
    return ai_decision.reply_message
```

---

This is the **"Elite Minimalist" Rewrite**. We are stripping away the complex regex and the rigid "Language Lock" code, replacing it with a single AI Supervisor that handles reasoning, extraction, and sentiment in one pass.

### 1. Database Update: The "Human Alert" Flag
First, run this SQL migration to give the AI a "Panic Button" to signal for human help.

```sql
-- migration.sql
ALTER TABLE candidates 
ADD COLUMN intervention_needed BOOLEAN DEFAULT FALSE,
ADD COLUMN intervention_reason TEXT;
```

---

### 2. The New `app/utils/candidate_validator.py`
We are replacing the 200+ lines of manual validation with a **Pydantic AI Supervisor**. This defines the "Brain" of the bot and allows it to return a clean, structured JSON object to your code.

```python
# app/utils/candidate_validator.py
from pydantic import BaseModel, Field
from typing import Optional

class AIConversationState(BaseModel):
    """The structured output the AI MUST provide for every message"""
    extracted_name: Optional[str] = Field(None, description="Candidate's full name if found")
    experience_years: Optional[int] = Field(None, description="Years of experience as an integer")
    job_interest: Optional[str] = Field(None, description="The specific job they are interested in")
    intent: str = Field(..., description="One of: GREETING, APPLYING, INQUIRY, or FRUSTRATED")
    intervention_needed: bool = Field(False, description="True if user is angry or stuck")
    reply_message: str = Field(..., description="The response in the user's mixed language (Singlish/Tanglish)")

SYSTEM_PROMPT = """
You are an Elite Sri Lankan Recruitment Agent for 'NODE.io Solutions'. 
RULES:
1. Speak naturally. If the user uses Singlish (e.g., 'mata job ekak ona') or Tanglish, reply in a helpful mix.
2. DO NOT enforce a single language. Be fluid.
3. If they upload a CV, assume they are APPLYING. Extract name and experience if possible.
4. If the user is repeatedly asking the same thing or seems angry, set intervention_needed to True.
5. Goal: Guide them to provide their Name, Experience, and Job Interest without being annoying.
"""
```

---

### 3. The Simplified `app/chatbot.py`
This rewrite removes the complex state-switching logic. The code now simply asks the AI: *"Here is the chat history and the new message; what should I do?"*.



```python
# app/chatbot.py (The Minimalist Rewrite)
from app.utils.candidate_validator import AIConversationState, SYSTEM_PROMPT
from app.services.recruitment_sync import recruitment_sync
from openai import OpenAI
import logging

client = OpenAI()

async def handle_message(user_phone, user_text, db_session):
    # 1. Fetch/Create Candidate and History
    candidate = get_or_create_candidate(user_phone, db_session)
    history = get_chat_history(user_phone) 

    # 2. AI SUPERVISOR pass
    completion = client.beta.chat.completions.parse(
        model="gpt-4o-2024-08-06",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            *history,
            {"role": "user", "content": user_text}
        ],
        response_format=AIConversationState,
    )
    
    ai_decision = completion.choices[0].message.parsed

    # 3. Apply AI Intelligence to Database
    if ai_decision.extracted_name:
        candidate.name = ai_decision.extracted_name
    if ai_decision.experience_years:
        candidate.experience_years = ai_decision.experience_years
    
    # Trigger Human Alert if the AI senses frustration
    if ai_decision.intervention_needed:
        candidate.intervention_needed = True
        candidate.intervention_reason = "AI detected frustration or explicit help request."
    
    # 4. Auto-Sync to Recruitment Backend
    # If the AI captured all necessary fields, push to the agency dashboard
    if candidate.name and candidate.experience_years:
        await recruitment_sync.push(candidate, db_session)

    db_session.commit()

    # 5. Send the AI-generated reply back to WhatsApp
    return ai_decision.reply_message
```

---

### Why this is "Elite" compared to before:

1.  **No More "Language Lock"**: Since the AI processes the `user_text` directly, it doesn't care if the user says "2", "Two", "අවුරුදු දෙකක්", or "rendu". It correctly extracts `experience_years: 2` every time.
2.  **Instant Recovery**: If a user gets stuck, the `intervention_needed` flag notifies your dashboard immediately so a human can take over.
3.  **Contextual Memory**: By passing the `history` to the AI, it knows if it already has the info and won't ask for it again, solving the "looping" flaw from the screenshots.
4.  **Minimalist Code**: You've replaced dozens of fragile files with one powerful prompt and a 20-line handler.

This is the final piece of the "AI Intervention" puzzle. Since your frontend is built with **React** and **Tailwind CSS** (based on your `vite.config.js` and `tailwind.config.js` files), we can build a sleek, real-time widget for your dashboard.

When the AI Supervisor sets `intervention_needed = True` in the backend, this React component will instantly flag it for your human agents.

### 1. The React Component: `InterventionAlerts.jsx`
You can drop this component directly into your `Dashboard.jsx` or `Candidates.jsx` page. It fetches the flagged candidates and provides a visually urgent UI using Tailwind.

```jsx
// recruitment-system/frontend/src/components/InterventionAlerts.jsx
import React, { useState, useEffect } from 'react';

const InterventionAlerts = () => {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fetch candidates requiring human intervention
  const fetchAlerts = async () => {
    try {
        // Assuming your backend has an endpoint to filter flagged candidates
        const response = await fetch('/api/candidates?intervention_needed=true');
        const data = await response.json();
        setAlerts(data.candidates || []);
    } catch (error) {
        console.error("Failed to fetch alerts:", error);
    } finally {
        setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
    // Optional: Set an interval to poll every 30 seconds for live updates
    const interval = setInterval(fetchAlerts, 30000);
    return () => clearInterval(interval);
  }, []);

  const resolveAlert = async (candidateId) => {
    // API call to reset the flag once the human agent has taken over
    await fetch(`/api/candidates/${candidateId}/resolve-intervention`, {
        method: 'POST',
    });
    // Remove from the local state
    setAlerts(alerts.filter(c => c.id !== candidateId));
  };

  if (loading) return <div className="animate-pulse h-12 bg-gray-200 rounded-md m-4"></div>;
  if (alerts.length === 0) return null; // Hide the widget if everything is fine

  return (
    <div className="mb-8 border-l-4 border-red-500 bg-red-50 p-4 rounded-r-md shadow-sm">
      <div className="flex items-center mb-3">
        <svg className="h-6 w-6 text-red-500 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <h3 className="text-lg font-bold text-red-800">Action Required: AI Handoff</h3>
        <span className="ml-3 px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
          {alerts.length} Pending
        </span>
      </div>
      
      <div className="space-y-3">
        {alerts.map((candidate) => (
          <div key={candidate.id} className="flex items-center justify-between bg-white p-3 rounded border border-red-100">
            <div>
              <p className="text-sm font-semibold text-gray-900">
                {candidate.name || candidate.phone}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                <span className="font-medium text-gray-700">Reason:</span> {candidate.intervention_reason}
              </p>
            </div>
            <div className="flex space-x-2">
              <button 
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors"
                onClick={() => window.location.href = `/communications?phone=${candidate.phone}`}
              >
                Take Over Chat
              </button>
              <button 
                className="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium rounded transition-colors"
                onClick={() => resolveAlert(candidate.id)}
              >
                Mark Resolved
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default InterventionAlerts;
```

### 2. Required Backend Route (Node.js)
To make the "Mark Resolved" button work, you just need a tiny endpoint in your Express backend (e.g., in `backend/src/routes/candidates.js`) to flip the database flag back to false.

```javascript
// backend/src/routes/candidates.js (Add this route)

router.post('/:id/resolve-intervention', async (req, res) => {
    try {
        const candidate = await Candidate.findByPk(req.params.id);
        if (!candidate) return res.status(404).json({ error: 'Candidate not found' });

        await candidate.update({ 
            intervention_needed: false,
            intervention_reason: null 
        });

        res.json({ success: true, message: 'Intervention resolved.' });
    } catch (error) {
        console.error("Resolve error:", error);
        res.status(500).json({ error: 'Server error' });
    }
});
```

### The Elite SaaS Workflow is now Complete:
1. **The Applicant** types Singlish and gets frustrated ("Mata human kenek one!").
2. **The AI Supervisor** safely catches this, extracts their phone number, and sets `intervention_needed = True`.
3. **The React Dashboard** instantly flashes a red alert to your recruitment agents.
4. **The Agent** clicks "Take Over Chat," dropping them straight into the candidate's active WhatsApp thread to save the conversion.

This is the final piece of the architecture. By bringing the WhatsApp interface directly into the React dashboard, you solve one of the biggest bottlenecks in recruitment SaaS: **Agent Device Sharing**. 

Instead of multiple agents fighting over a single physical phone or WhatsApp Web tab, your entire team can now chat with candidates simultaneously, directly from the web platform, while the AI Supervisor handles the heavy lifting in the background.

Here is the implementation plan for the **Live Communications Hub**.

### 1. The Real-Time Architecture

To make this feel like a native chat app, we need a tri-directional flow:
1. **Incoming:** WhatsApp Webhook -> Node.js Backend -> **WebSocket** -> React Frontend.
2. **Outgoing:** React Frontend -> Node.js Backend -> **Meta Graph API** -> Candidate's Phone.

---

### 2. Frontend: `Communications.jsx` (React + Tailwind)
This component creates a split-pane view: Candidates on the left, active chat on the right. 

```jsx
// recruitment-system/frontend/src/pages/Communications.jsx
import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';

const Communications = () => {
  const [activeCandidate, setActiveCandidate] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef(null);
  const [socket, setSocket] = useState(null);

  // Initialize WebSocket & Fetch Candidates
  useEffect(() => {
    const newSocket = io(import.meta.env.VITE_API_URL || 'http://localhost:3000');
    setSocket(newSocket);

    fetch('/api/candidates')
      .then(res => res.json())
      .then(data => setCandidates(data.candidates || []));

    // Listen for incoming WhatsApp messages in real-time
    newSocket.on('receive_message', (newMessage) => {
      setMessages(prev => [...prev, newMessage]);
    });

    return () => newSocket.close();
  }, []);

  // Fetch chat history when a candidate is clicked
  const loadChat = async (candidate) => {
    setActiveCandidate(candidate);
    const res = await fetch(`/api/communications/history/${candidate.phone}`);
    const data = await res.json();
    setMessages(data.messages);
    scrollToBottom();
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // Trigger scroll when messages change
  useEffect(scrollToBottom, [messages]);

  // Send message to WhatsApp via Backend
  const sendMessage = async (e) => {
    e.preventDefault();
    if (!inputText.trim() || !activeCandidate) return;

    const msgPayload = {
      phone: activeCandidate.phone,
      text: inputText,
      sender: 'agent' // Flags that a human sent this, not the AI
    };

    // Optimistic UI update
    setMessages(prev => [...prev, { ...msgPayload, timestamp: new Date() }]);
    setInputText('');

    await fetch('/api/communications/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msgPayload)
    });
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-white border rounded-lg shadow-sm">
      {/* Left Pane: Candidate List */}
      <div className="w-1/3 border-r flex flex-col">
        <div className="p-4 bg-gray-50 border-b font-semibold text-gray-700">
          Active Conversations
        </div>
        <div className="flex-1 overflow-y-auto">
          {candidates.map(c => (
             <div 
               key={c.id} 
               onClick={() => loadChat(c)}
               className={`p-4 border-b cursor-pointer hover:bg-blue-50 transition-colors ${
                 activeCandidate?.id === c.id ? 'bg-blue-100 border-l-4 border-blue-600' : ''
               } ${c.intervention_needed ? 'bg-red-50' : ''}`}
             >
               <div className="font-medium text-gray-900 flex justify-between">
                 {c.name || c.phone}
                 {c.intervention_needed && <span className="text-red-500 text-xs font-bold">⚠️ Action</span>}
               </div>
               <div className="text-xs text-gray-500 mt-1 truncate">
                 {c.experience_years ? `${c.experience_years} Yrs Exp` : 'Screening...'}
               </div>
             </div>
          ))}
        </div>
      </div>

      {/* Right Pane: Chat Window */}
      <div className="w-2/3 flex flex-col bg-gray-50">
        {activeCandidate ? (
          <>
            {/* Chat Header */}
            <div className="p-4 bg-white border-b flex justify-between items-center shadow-sm z-10">
              <div>
                <h2 className="font-bold text-gray-800">{activeCandidate.name || activeCandidate.phone}</h2>
                {activeCandidate.intervention_needed && (
                  <p className="text-xs text-red-600 font-medium">{activeCandidate.intervention_reason}</p>
                )}
              </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.sender === 'agent' || msg.sender === 'bot' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[70%] rounded-lg p-3 ${
                    msg.sender === 'agent' ? 'bg-blue-600 text-white' : 
                    msg.sender === 'bot' ? 'bg-gray-200 text-gray-800' : 
                    'bg-white border text-gray-800 shadow-sm'
                  }`}>
                    <p className="text-sm">{msg.text}</p>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <form onSubmit={sendMessage} className="p-4 bg-white border-t flex gap-2">
              <input 
                type="text" 
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Type your message..." 
                className="flex-1 border border-gray-300 rounded-full px-4 py-2 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              <button 
                type="submit" 
                className="bg-blue-600 text-white px-6 py-2 rounded-full font-medium hover:bg-blue-700 transition-colors"
              >
                Send
              </button>
            </form>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 flex-col">
            <svg className="w-16 h-16 mb-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p>Select a candidate to start chatting</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Communications;
```

---

### 3. Backend: Node.js API & WebSockets
You need to update your backend to push outbound messages to Meta and broadcast inbound messages to your React app.

**1. The Send Endpoint (`backend/src/routes/communications.js`)**
```javascript
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { Message, Candidate } = require('../models');

router.post('/send', async (req, res) => {
    const { phone, text, sender } = req.body;

    try {
        // 1. Send to WhatsApp Cloud API
        await axios.post(`https://graph.facebook.com/v17.0/${process.env.META_PHONE_ID}/messages`, {
            messaging_product: "whatsapp",
            to: phone,
            type: "text",
            text: { body: text }
        }, {
            headers: { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` }
        });

        // 2. Save to Database for chat history
        await Message.create({
            candidate_phone: phone,
            text: text,
            sender: sender, // 'agent'
            timestamp: new Date()
        });

        // 3. Mark intervention as resolved (if an agent replied, they took over)
        await Candidate.update(
            { intervention_needed: false, intervention_reason: null },
            { where: { phone: phone } }
        );

        res.json({ success: true });
    } catch (error) {
        console.error("Failed to send WA message:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to send message" });
    }
});

module.exports = router;
```

**2. The Webhook Update (`backend/src/routes/webhooks.js`)**
Inside your existing Meta Webhook receiver, after you save an incoming message to the DB, emit it to the frontend:

```javascript
// Inside your webhook payload processing logic...
const incomingText = message.text.body;

// 1. Save to DB
const savedMsg = await Message.create({
    candidate_phone: fromPhone,
    text: incomingText,
    sender: 'candidate'
});

// 2. Broadcast to React Frontend instantly
// Note: You'll need to pass the 'io' socket instance to your router
req.app.get('io').emit('receive_message', savedMsg);
```

---

### The Elite Result
By deploying this complete ecosystem, you have achieved the following:

1. **The AI handles the top of the funnel (80% of the work):** Extracting CVs, parsing Tanglish/Singlish, and getting years of experience.
2. **The "Human Alert" catches the edge cases (20% of the work):** The AI flags angry or confused candidates instantly on the dashboard.
3. **The `Communications.jsx` interface saves the conversion:** Your agents step in seamlessly, read the context, and close the deal without ever leaving the web app.

This elevates your project from a "Chatbot script" to an **Enterprise-Grade SaaS Recruitment Engine**.

