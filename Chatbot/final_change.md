🧠 AI RECRUITMENT SYSTEM — FULL TRANSFORMATION PLAN

Here is a proper description of what's lacking 
Alright — now we’re going to formalize your vision into a **technical, production-grade system design** that an elite AI/chatbot engineering team would actually execute.

This is no longer “a chatbot.”
This is a **Multilingual AI Recruitment Gateway Platform for Sri Lanka**.

---

# 🔷 1. System Overview (Professional Definition)

This system is an **AI-driven, multilingual, voice-capable recruitment intake and engagement platform** deployed over WhatsApp, designed specifically for:

* Low-literacy users
* Multilingual communication (Sinhala, Tamil, Singlish, Tanglish, English)
* Voice-first interactions
* Incomplete or missing candidate data (no CV, partial info)

### 🎯 Core Objective

Convert **unstructured, messy human communication** into **structured recruitment data** and successfully onboard candidates into a CRM without friction.

---

# 🔷 2. Architectural Paradigm

## ✅ Hybrid Agentic Architecture (Controlled AI)

We **DO NOT** allow full AI autonomy.
We implement a **Controlled Agentic System**:

### Layer 1 — AI Understanding Layer (Cheap + Fast)

* Language detection
* Intent classification
* Entity extraction
* Voice intent classification
* Noise/gibberish detection

👉 Model: `GPT-5 mini`

---

### Layer 2 — Deterministic Orchestrator (Core Brain)

Controls:

* Conversation state
* Flow transitions
* Priority handling (CV > Jobs > Vacancies > Questions)
* Data completeness tracking
* Language locking

👉 This replaces 70% of your current `chatbot.py`

---

### Layer 3 — AI Response Generator (Human-like Output)

* Converts system decisions → natural conversation
* Handles slang, tone, friendliness
* Maintains cultural context

👉 Model:

* `GPT-5 mini` (default)
* `GPT-5.4` (fallback for complex cases)

---

### Layer 4 — Specialized Pipelines

* CV Processing Engine
* Voice Processing Engine
* Job Matching Engine
* CRM Sync Engine

---

# 🔷 3. Core System Modules (Refactored from chatbot.py)

Your 4700-line file will be split into:

---

## 1. `message_router`

* Entry point for all WhatsApp messages
* Detects:

  * Text / Voice / Image / Document
* Sends to appropriate pipeline

---

## 2. `language_service`

Handles:

* Language detection (Sinhala / Tamil / Mixed)
* Language locking
* Language switching logic

### Rule:

* First message → detect → show selector
* After selection → LOCK
* Only change if user explicitly changes language

---

## 3. `voice_processing_service`

Pipeline:

```
Voice Note → Transcription → Intent + Entity Detection → Pass to Orchestrator
```

### Models:

* `GPT-4o mini Transcribe` (cheap + fast)
* Optional: intent classification via GPT-5 mini

---

## 4. `intake_orchestrator` (🔥 MOST IMPORTANT)

This replaces your messy state machine.

### Responsibilities:

* Decide next step
* Track collected data
* Avoid repetition
* Enforce priorities

---

### 🎯 Priority Engine (Critical Rule)

```
1. CV Upload (highest priority)
2. Job Selection
3. Vacancy Browsing
4. Questions (lowest priority)
```

---

### 🎯 State Model (Simplified)

```json
{
  "language": "si | ta | en | singlish | tanglish",
  "intent": "apply | browse | ask",
  "cv_uploaded": true/false,
  "fields": {
    "job_role": null,
    "country": null,
    "experience": null,
    "education": null
  },
  "confidence_score": 0.0,
  "handoff_flag": false
}
```

---

## 5. `cv_extraction_service`

### Handles:

* PDF CV
* Images (CV photos)
* Passport / ID (future-ready)

### Flow:

```
Upload → Extract → Normalize → Fill Missing → Return Structured Data
```

### Output:

```json
{
  "name": "",
  "age": "",
  "skills": [],
  "experience": "",
  "preferred_country": "",
  "job_role": ""
}
```

---

## 6. `job_matching_service`

### Input:

* Extracted CV data
* User preferences

### Output:

* Ranked job list

### Rule:

👉 ONLY show **relevant jobs** (your requirement #6)

---

## 7. `vacancy_service`

* Pulls structured job data
* Filters:

  * Country
  * Role
  * Experience
* Sends clean UI payload (WhatsApp interactive list)

---

## 8. `crm_sync_service`

Creates:

* Lead ✅
* Candidate ✅
* Application ✅

---

## 9. `handoff_service`

### Trigger Conditions:

* Repeated confusion
* Low confidence score
* User frustration
* Complex question

### Action:

* Notify CRM WebSocket
* Switch conversation control

---

# 🔷 4. Conversation Flow (Production Standard)

---

## 🟢 Step 1: Entry

User message →

### AI:

* Detect language
* Detect intent

---

## 🟢 Step 2: Language Selector

Respond in detected language:

```
Select Language:
[සිංහල] [தமிழ்] [English]
```

👉 Lock after selection

---

## 🟢 Step 3: Main Menu

```
1. Apply for Job
2. View Vacancies
3. Ask Question
```

---

## 🟢 Step 4A: Apply Flow

AI takes control:

1. Ask job role
2. Ask country
3. Ask experience

👉 BUT:

### 🚨 If CV arrives at ANY time:

→ INTERRUPT FLOW
→ Extract data
→ Continue from missing fields

---

## 🟢 Step 4B: View Vacancies

* Show filtered jobs
* Allow selection
* Immediately transition to apply flow

---

## 🟢 Step 4C: Ask Question

* Use RAG / knowledge base
* Always return:

  * Answer
  * Next action (Apply / View Jobs)

---

# 🔷 5. AI Behavior Rules (Critical)

---

## ❌ NEVER SAY:

* “I don’t understand”
* “Error occurred”
* “Try again”

---

## ✅ ALWAYS:

* Recover intelligently
* Ask clarifying question
* Continue onboarding

---

## 🧠 Example Recovery

User says:

> “mokakda meka???”

AI:

> “Hari 😊 oyata job ekak apply karanna ona da? nathnam vacancies balanna da?”

---

# 🔷 6. Multilingual Strategy (Sri Lanka Specific)

---

## Supported:

* Sinhala
* Tamil
* English
* Singlish
* Tanglish

---

## Approach:

DO NOT translate word-for-word.

Instead:

* Use **natural conversational patterns**
* Keep key English words:

  * Job
  * CV
  * Agency
  * Apply

---

## Example (Sinhala Natural):

❌ Bad:
“ඔබගේ ජීව දත්ත පත්‍රය ලබා දෙන්න”

✅ Good:
“oyage CV eka thiyenawada? thiyenawanam upload karanna 😊”

---

# 🔷 7. Voice-First Design

---

## Pipeline:

```
Voice → Transcribe → Understand → Respond
```

---

## Key Rule:

Treat voice SAME as text.

---

## Enhancement:

* Detect emotional tone (optional)
* Detect urgency

---

# 🔷 8. Recruitment Taxonomy (Simplified)

---

## Job Roles (Example Categories)

* Construction
* Hospitality
* Domestic Work
* Driving
* Security
* Factory Work

---

## Countries

* UAE
* Qatar
* Saudi Arabia
* Kuwait
* Malaysia
* South Korea

---

## Required Fields

Minimal (low friction):

* Name
* Job Role
* Country
* Experience (optional)
* CV (recommended)

---

# 🔷 9. Model Usage Strategy (Cost Optimized)

---

## GPT-5 mini (Primary)

* Language detection
* Intent classification
* Entity extraction
* Response generation (80%)

---

## GPT-5.4 (Fallback)

* Complex conversations
* Recovery scenarios
* Smart reasoning

---

## GPT-4o Mini Transcribe

* Voice notes

---

# 🔷 10. What You MUST Do Next (Execution Plan)

---

## Phase 1 — Refactor (CRITICAL)

* Break `chatbot.py` into modules
* Build orchestrator

---

## Phase 2 — AI Layer

* Implement classifier prompt
* Implement response generator prompt

---

## Phase 3 — CV Pipeline

* Improve extraction accuracy
* Add image parsing

---

## Phase 4 — Vacancy Engine

* Clean job database
* Build filtering logic

---

## Phase 5 — CRM Sync

* Ensure structured data consistency

---

## Phase 6 — Human Handoff

* Improve trigger intelligence
* Sync with dashboard

---

# 🔷 Final Insight (Most Important)

Your problem is NOT AI capability.
Your problem is **architecture + orchestration complexity**.

👉 You already built 70% of a powerful system
👉 Now you must **simplify, modularize, and control AI**


(Sri Lanka Multilingual, Voice-First, Low-Literacy Optimized)
1. 🎯 CORE OBJECTIVE (WHAT YOU ARE BUILDING)

You are NOT building a chatbot.

You are building:

A multilingual AI recruitment gateway that replaces front-desk agents, call center staff, and initial recruiters for Sri Lankan foreign employment agencies.

👥 Target Users (CRITICAL DESIGN DRIVER)

Your users are:

Native Sinhala / Tamil speakers
Use Singlish / Tanglish / slang
Low literacy
Not tech-savvy
Prefer voice notes over typing
May NOT have:
CV
proper English
structured answers

👉 This means:

❌ Traditional chatbot logic WILL FAIL
✅ You MUST build AI-assisted structured onboarding

2. 🚨 CURRENT SYSTEM PROBLEMS (FROM YOUR CODEBASE)
❌ 1. Monolithic Chatbot (chatbot.py ~4700 lines)
Too many responsibilities
Hard to debug
Unpredictable conversation behavior
❌ 2. State Machine Chaos
Mixed:
regex logic
AI logic
manual flows
Causes:
repeated questions
broken conversations
❌ 3. Weak Language Handling
No consistent:
language lock
slang normalization
mixed-language understanding
❌ 4. CV Handling Not Dominant
CV is not treated as priority interrupt
Causes friction
❌ 5. No True AI Orchestration
AI is used as helper, not controller
Missing:
intent classification layer
recovery intelligence
3. 🧠 NEW SYSTEM DESIGN PRINCIPLE
🔥 “AI-AssISTED CONTROLLED SYSTEM”

NOT:

“AI does everything”

BUT:

“AI understands → System decides → AI communicates”

4. 🏗️ NEW SYSTEM ARCHITECTURE
🔷 Layered Design
User (WhatsApp)
      ↓
Webhook (FastAPI)
      ↓
INPUT INTELLIGENCE LAYER
      ↓
ORCHESTRATOR (RULE ENGINE)
      ↓
SERVICE LAYER
      ↓
AI RESPONSE GENERATOR
      ↓
WhatsApp Response
      ↓
CRM SYNC
5. 🧠 INPUT INTELLIGENCE LAYER (MOST IMPORTANT FIX)
Purpose:

Handle messy human input BEFORE system logic.

It must detect:
✅ Language
Sinhala
Tamil
Singlish
Tanglish
English
✅ Intent
apply_job
view_jobs
ask_question
upload_cv
greeting
gibberish
✅ Entities
job role
country
experience
✅ Special Flags
voice input
meaningless message
abusive language
🔧 Implementation

Use GPT-5 mini

Why:
cheap
fast
good multilingual understanding
🔥 Impact

Fixes:

bot misunderstanding users
slang confusion
random replies
6. 🧠 ORCHESTRATOR (SYSTEM BRAIN)
This replaces your current chaotic logic.
Responsibilities:
1. Language Control
Detect first message language
Show selector
Lock language
Allow change if user switches
2. CV PRIORITY ENGINE (MOST IMPORTANT RULE)
IF CV uploaded → STOP everything → process CV
3. Conversation State Control

Tracks:

{
  "language": "sinhala",
  "step": "collecting_job_role",
  "data": {
    "job_role": null,
    "country": null,
    "experience": null
  },
  "cv_uploaded": false
}
4. Intent Routing

Routes to:

Intake Agent
Job Service
Q&A Agent
Recovery Agent
5. Confusion Handling

If:

gibberish
unclear input

→ route to Recovery AI

7. 🎤 VOICE-FIRST SYSTEM
REQUIRED CHANGE

Voice is NOT optional.

Flow:
Voice → Transcribe → Classify → Process
Requirements:
Accept all voice formats
Transcribe using AI
Run classification on transcript
Edge Case Handling:

If unclear:

Friendly clarification (NOT error)

8. 🌍 LANGUAGE SYSTEM (CRITICAL)
Problem:

Users mix languages heavily.

Solution:
1. Language Detection (AI)
2. Language Lock
Once selected → enforce
3. Smart Adaptation

If user switches:

update language dynamically
4. Response Style Rules

AI must:

use simple words
mix English naturally
avoid formal grammar
Example:

✔ Good:

“job ekak apply karanna oni da?”

❌ Bad:

“ඔබට රැකියාවක් සඳහා අයදුම් කිරීමට අවශ්‍යද?”

9. 📄 CV SYSTEM (PRIMARY FEATURE)
🔥 RULE: CV IS KING
Required Behavior:
✅ Accept CV ANYTIME
during any step
interrupt flow
✅ Extract Data
name
job role
experience
skills
✅ Fill Missing Fields

Ask ONLY what’s missing

✅ Accept:
PDF
Images
Photos of documents
✅ Continue Flow Automatically
10. 🧠 JOB MATCHING SYSTEM
Requirement:

Only show relevant jobs

Implementation:

Score:

skill * 0.5
+ experience * 0.2
+ country * 0.3
Output:
Top 3 jobs
Simple display
11. 🧾 VACANCY SYSTEM
MUST CHANGE:

❌ Current:

text-based / static

✅ New:

structured DB-driven
Features:
filter by:
job role
country
clickable options
instant apply
12. 🧠 CONVERSATION FLOW (FINAL DESIGN)
🔷 ENTRY FLOW
Detect language
Show language selector
Show menu:
Apply Job
View Jobs
Ask Question
🔷 APPLY FLOW
Ask job role
Ask country
Ask experience
Accept CV anytime
Extract + fill gaps
Match jobs
Create:
Candidate
Application
🔷 VIEW JOBS FLOW
Show filtered jobs
User selects
Continue onboarding
🔷 ASK QUESTION FLOW
Use knowledge base
fallback to AI
13. 🚨 ERROR HANDLING (INVISIBLE AI RECOVERY)
RULE:

User should NEVER see:

“error”
“I don’t understand”
Instead:

AI must:

rephrase
guide
suggest options
14. 👨‍💼 HUMAN HANDOFF
Trigger:
confusion > 3 turns
frustration detected
Flow:
notify CRM
transfer conversation
agent takes over
15. 🧱 SYSTEM REFACTOR PLAN
From:
chatbot.py (4700 lines)
To:
/core
/services
/agents
/api
Benefits:
scalable
maintainable
debuggable
16. 💰 AI COST STRATEGY
Task	Model
classification	GPT-5 mini
normal responses	GPT-5 mini
hard cases	GPT-5.4
CV parsing	GPT-5 mini
17. 📊 CRM INTEGRATION
MUST CREATE:
Candidate
Job Match
Application
Real-time sync required
18. 🧪 TESTING STRATEGY

Test with:

slang Sinhala
Tamil mix
voice noise
no CV users
random messages
19. 🔥 FINAL OUTCOME

If implemented correctly:

You will have:

AI that understands real Sri Lankan users
voice-first recruitment system
zero-error experience
scalable SaaS product

Remove any code part that's gonna harm the plan and make sure you always test , debug and make sure zero errors are there before you push it to the live