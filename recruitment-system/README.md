# Recruitment System - Dewan Consultants

Full-stack recruitment management platform built with Node.js / Express (backend) and React (frontend). Manages candidates, jobs, projects, and applications through a dashboard UI. Integrates directly with the WhatsApp chatbot to receive completed applications automatically.

---

## What it does

- **Candidate management** - create, search, filter, and status-track candidates through a Kanban-style pipeline
- **Job and project management** - create job listings grouped under client projects with requirements (age, height, experience, languages, benefits)
- **Application pipeline** - link candidates to jobs, track status (pending / reviewed / shortlisted / rejected), record interview notes
- **WhatsApp chatbot integration** - receives fully processed candidate profiles from the Python chatbot via a secure API; pushes new job/project content to the chatbot knowledge base automatically
- **Meta ad link management** - generate Click-to-WhatsApp ad links per job; when a candidate clicks the ad, the chatbot pre-fills job context and skips to CV upload
- **Gmail integration** - monitor a recruitment inbox, parse inbound CVs, and create candidate records automatically
- **Communications log** - full audit trail of every WhatsApp, email, and inbound communication per candidate
- **Auto-assign** - automatically match candidates to open jobs based on skills and experience

---

## Tech stack

| Layer | Technology |
|---|---|
| API server | Node.js 18+, Express 4 |
| Database | PostgreSQL (default) or MySQL (set USE_MYSQL=true) |
| AI | OpenAI GPT-4o-mini |
| OCR | Tesseract.js and optional Google Vision |
| Frontend | React 18, Vite, TailwindCSS, shadcn/ui |
| Auth | JWT (HS256) |

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ (or MySQL 8+)
- OpenAI API key
- Meta WhatsApp Business API credentials (same phone number as the Python chatbot)

---

## Setup

### 1. Install dependencies

\\ash
cd recruitment-system/backend
npm install

cd ../frontend
npm install
\
### 2. Configure environment

\\ash
cd backend
cp .env.serverbyt.example .env   # for production (MySQL)
# or
cp .env.example .env              # for local dev (PostgreSQL)
\
Key variables:

| Variable | Description |
|---|---|
| PORT | API server port (default: 3000) |
| DB_HOST / DB_NAME / DB_USER / DB_PASSWORD | Database connection |
| USE_MYSQL | Set true to use MySQL instead of PostgreSQL |
| JWT_SECRET | Secret for JWT signing - use a 64-char random string |
| OPENAI_API_KEY | OpenAI API key |
| WHATSAPP_PHONE_NUMBER_ID | Meta phone number ID |
| WHATSAPP_ACCESS_TOKEN | Meta WhatsApp access token |
| WHATSAPP_WEBHOOK_VERIFY_TOKEN | Webhook verify token (must be dewan_recruitment_webhook_2024) |
| CHATBOT_API_KEY | Shared secret - must match CHATBOT_API_KEY in the Python chatbot .env |
| CHATBOT_API_URL | URL of the Python chatbot (e.g. http://localhost:8000) |
| GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET | Gmail OAuth credentials (optional) |

### 3. Run database migrations

\\ash
cd backend
node migrate.js
\
### 4. Create the first admin user

\\ash
node create-admin.js
\
### 5. Start the servers

\\ash
# Backend API (port 3000)
cd backend
npm start
# or for development with auto-reload:
npm run dev

# Frontend (port 5173)
cd frontend
npm run dev
\
Open http://localhost:5173 to access the dashboard.

---

## WhatsApp webhook

The Node.js backend receives WhatsApp webhooks at POST /webhooks/whatsapp and proxies them directly to the Python chatbot. The Python bot handles all conversation logic and replies to the user independently.

Meta webhook settings:
- **Callback URL:** https://api.yourdomain.com/webhooks/whatsapp
- **Verify Token:** dewan_recruitment_webhook_2024
- **Subscribe to:** messages

Alternatively, point Meta directly at the Python chatbot URL (https://chatbot.yourdomain.com/webhook/whatsapp) and skip the proxy entirely.

---

## Chatbot integration API

These endpoints are called by the Python chatbot - do not call them directly from the frontend.

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/chatbot/intake | x-chatbot-api-key header | Receives a completed candidate from the chatbot |
| GET | /api/public/job-context/:ref | x-chatbot-api-key header | Returns job/project data for a Meta ad reference |
| POST | /api/chatbot-sync/job | JWT (admin) | Push a job content to the chatbot knowledge base |
| POST | /api/chatbot-sync/sync-all | JWT (admin) | Re-sync all jobs/projects to the chatbot KB |

---

## Key API endpoints

| Method | Path | Description |
|---|---|---|
| POST | /api/auth/login | Login, returns JWT |
| GET | /api/candidates | List all candidates |
| POST | /api/candidates | Create candidate |
| GET | /api/jobs | List all jobs |
| POST | /api/jobs | Create job |
| GET | /api/projects | List all projects |
| GET | /api/applications | List all applications |
| POST | /api/ad-links | Create a Click-to-WhatsApp ad link |
| GET | /api/communications | Communication log |
| GET | /api/gmail/status | Gmail integration status |
| GET | /webhooks/whatsapp | Meta webhook verification |
| POST | /webhooks/whatsapp | Incoming WhatsApp messages (proxied to Python chatbot) |

---

## Project structure

\recruitment-system/
|-- backend/
|   |-- src/
|   |   |-- server.js              # Express app + route mounting
|   |   |-- config/
|   |   |   |-- database.js        # DB connection (PostgreSQL / MySQL)
|   |   |   \-- openai.js          # OpenAI client
|   |   |-- routes/
|   |   |   |-- auth.js
|   |   |   |-- candidates.js
|   |   |   |-- jobs.js
|   |   |   |-- projects.js
|   |   |   |-- applications.js
|   |   |   |-- communications.js
|   |   |   |-- webhooks.js        # WhatsApp webhook proxy to Python bot
|   |   |   |-- chatbot-intake.js  # Receives candidates from Python bot
|   |   |   |-- chatbot-sync.js    # Pushes jobs to Python bot KB
|   |   |   |-- chatbot-context.js # Serves job context for ad clicks
|   |   |   |-- ad-links.js        # Meta ad link management
|   |   |   \-- gmail.js
|   |   |-- services/
|   |   |   |-- whatsapp.js        # Meta WhatsApp API calls
|   |   |   \-- messenger.js
|   |   \-- middleware/
|   |       \-- auth.js            # JWT middleware
|   |-- database/
|   |   |-- schema.sql             # PostgreSQL schema
|   |   \-- schema-mysql.sql       # MySQL schema
|   |-- migrate.js                 # Run migrations
|   |-- create-admin.js            # Create first admin user
|   |-- package.json
|   \-- .env.serverbyt.example
\-- frontend/
    |-- src/
    |   |-- pages/                 # Dashboard pages
    |   \-- components/            # UI components
    |-- vite.config.js
    \-- package.json
\