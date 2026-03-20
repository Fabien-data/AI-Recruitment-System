-- Migration: Add chatbot_intake_log table for idempotency key tracking
-- This prevents duplicate candidate creation when the chatbot retries a failed sync

CREATE TABLE IF NOT EXISTS chatbot_intake_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key VARCHAR(64) NOT NULL,
    candidate_id VARCHAR(255),
    application_id VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'created',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_idempotency_key UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_intake_log_key ON chatbot_intake_log (idempotency_key);

-- Auto-cleanup: entries older than 30 days can be safely purged
-- (idempotency only matters during retry windows)
