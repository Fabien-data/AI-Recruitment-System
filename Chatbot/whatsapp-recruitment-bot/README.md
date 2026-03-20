# WhatsApp Recruitment Chatbot - Dewan Consultants

AI-powered WhatsApp chatbot built with Python / FastAPI. Guides candidates through a structured intake flow, parses CVs intelligently, and pushes completed applications straight into the recruitment system. Supports English, Sinhala, and Tamil.

---

## What it does

- **Structured intake flow** - greets the candidate, asks for job interest, destination country, and years of experience, then requests a CV
- **Trilingual NLP** - detects and responds in English, Sinhala (including Singlish), and Tamil; handles mid-conversation language switches
- **Intelligent CV parsing** - GPT-4o extracts 25+ fields (name, DOB, experience, skills, qualifications, work history) with confidence scores; OCR fallback for scanned PDFs and images
- **RAG knowledge base** - answers questions about job requirements, salaries, and company policies using Pinecone vector search (falls back to MySQL FULLTEXT if Pinecone is not configured)
- **Sentiment analysis** - detects frustration or profanity and responds with de-escalation
- **Meta ad click detection** - recognises `START:ad_ref` messages from Click-to-WhatsApp ads, pre-fills job/country from the ad, and skips straight to CV upload
- **Recruitment sync** - on completion, pushes the full candidate profile to `POST /api/chatbot/intake` on the Node.js recruitment system

---

## Prerequisites

- Python 3.10+
- MySQL 8.0+ (or SQLite for local dev - already configured in `.env`)
- OpenAI API key
- Meta WhatsApp Business API credentials (Access Token + Phone Number ID)
- (Optional) Pinecone account for vector search

---

## Setup

### 1. Install dependencies

```bash
cd Chatbot/whatsapp-recruitment-bot
pip install -r requirements.txt
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Key variables:

| Variable | Description |
|---|---|
| `META_ACCESS_TOKEN` | WhatsApp Business API access token |
| `META_PHONE_NUMBER_ID` | Your WhatsApp phone number ID |
| `META_VERIFY_TOKEN` | Token used to verify the webhook (default: `dewan_recruitment_webhook_2024`) |
| `META_APP_SECRET` | Meta app secret (leave blank to skip signature verification) |
| `OPENAI_API_KEY` | OpenAI API key (GPT-4o + embeddings) |
| `DATABASE_URL` | SQLAlchemy DB URL, e.g. `sqlite:///./recruitment_chatbot.db` or `mysql+pymysql://user:pass@host/db` |
| `RECRUITMENT_API_URL` | Base URL of the Node.js recruitment backend (e.g. `http://localhost:3000`) |
| `CHATBOT_API_KEY` | Shared secret - must match `CHATBOT_API_KEY` in the Node.js `.env` |
| `RECRUITMENT_DB_URL` | (Optional) Direct PostgreSQL URL for job-search fallback, e.g. `postgresql://user:pass@localhost:5432/recruitment_db` |
| `PINECONE_API_KEY` | (Optional) Pinecone key - leave blank to use MySQL FULLTEXT fallback |

### 3. Initialise the database

```bash
python scripts/init_db.py
```

This creates the `candidates`, `conversations`, `applications`, and `knowledge_base_metadata` tables. Safe to run multiple times.

### 4. Start the server

```bash
# Development
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Production (2 workers)
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2
```

Server starts at `http://localhost:8000`. Health check: `GET /health`.

---

## Meta WhatsApp webhook setup

1. Go to [Meta Developer Console](https://developers.facebook.com/) -> your App -> WhatsApp -> Configuration
2. Set **Callback URL** to `https://chatbot.yourdomain.com/webhook/whatsapp`
3. Set **Verify Token** to `dewan_recruitment_webhook_2024` (or whatever you set in `.env`)
4. Subscribe to: **messages**

> If the Node.js recruitment backend is already running and its `CHATBOT_API_URL` points to this server, Meta only needs to know about one URL - the Node.js server will proxy WhatsApp messages to this bot automatically.

## Production go-live (real number + permanent token)

For a full click-by-click production setup (System User permanent token, app Live mode, webhook verification, smoke test), use:

- `META_PRODUCTION_GO_LIVE.md`

Quick preflight command:

```bash
python scripts/meta_preflight.py
```

---

## API endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check - returns status, DB connection, memory |
| `GET` | `/webhook/whatsapp` | Meta webhook verification |
| `POST` | `/webhook/whatsapp` | Incoming WhatsApp messages |
| `POST` | `/api/knowledge/upsert` | Add/update a document in the KB (called by recruitment system) |
| `DELETE` | `/api/knowledge/delete` | Remove a document from the KB |

The `/api/knowledge/*` endpoints require the `x-chatbot-api-key` header matching `CHATBOT_API_KEY`.

---

## Docker (optional)

```bash
# Build and start (also starts Redis)
docker-compose up -d

# Logs
docker-compose logs -f chatbot

# Stop
docker-compose down
```

---

## Project structure

```
whatsapp-recruitment-bot/
 app/
    main.py              # FastAPI app + startup
    config.py            # All settings (pydantic-settings)
    database.py          # SQLAlchemy engine + session
    models.py            # DB models
    schemas.py           # Pydantic schemas
    crud.py              # DB operations
    chatbot.py           # State-machine conversation engine (1200 lines)
    webhooks.py          # WhatsApp webhook handlers
    health.py            # /health endpoint
    knowledge.py         # /api/knowledge endpoints
    cv_parser/           # PDF, DOCX, OCR, GPT-4o extraction
    llm/                 # RAG engine + prompt templates
    nlp/                 # Language detector + sentiment analyser
    services/
       recruitment_sync.py    # Pushes candidates to Node.js API
       ad_context_service.py  # Meta ad click detection
    utils/
        meta_client.py   # Meta WhatsApp API calls
        file_handler.py  # CV file storage
        candidate_validator.py
 scripts/
    init_db.py           # Create / verify DB tables
    load_knowledge_base.py
    test_chatbot.py
 requirements.txt
 .env.example
 Dockerfile
 docker-compose.yml
```
