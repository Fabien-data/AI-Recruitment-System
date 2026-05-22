-- Migration 012: chatbot_sync_outbox
-- Realtime knowledge sync (jobs / projects / KB FAQs) from CRM to the WhatsApp chatbot.
--
-- Pattern: outbox + worker. Every CRM mutation writes a row here; a Node worker
-- drains pending rows with exponential backoff, posting to the chatbot's
-- /api/knowledge/upsert | /delete endpoints. A periodic reconciler re-enqueues
-- any entity whose updated_at is newer than its latest 'sent' row.
--
-- Applied automatically on backend startup via src/config/migrations.js.
-- This file is kept for documentation and manual replay only.

CREATE TABLE IF NOT EXISTS chatbot_sync_outbox (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_id        VARCHAR(128) NOT NULL,              -- 'job_<uuid>' | 'faq_<uuid>' | 'project_<uuid>'
    doc_type      VARCHAR(32)  NOT NULL,              -- 'job_desc' | 'faq' | 'project_desc'
    operation     VARCHAR(16)  NOT NULL,              -- 'upsert' | 'delete'
    payload       JSONB        NOT NULL,              -- exact body POSTed to the bot
    status        VARCHAR(16)  NOT NULL DEFAULT 'pending',   -- pending | sent | failed
    attempts      INT          NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    synced_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON chatbot_sync_outbox (status, updated_at)
    WHERE status IN ('pending','failed');

-- Collapses a burst of edits to the same doc into a single pending row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_pending_per_doc
    ON chatbot_sync_outbox (doc_id, operation)
    WHERE status = 'pending';

-- Used by the reconciler to find the most recent successful sync per doc.
CREATE INDEX IF NOT EXISTS idx_outbox_doc_synced
    ON chatbot_sync_outbox (doc_id, synced_at DESC)
    WHERE status = 'sent';
