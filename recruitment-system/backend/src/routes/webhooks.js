const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { parseResume, generateChatbotResponse, detectLanguage, extractField } = require('../config/openai');
const { sendTextMessage, downloadMedia, markMessageAsRead } = require('../services/whatsapp');
const { sendTextMessage: sendMessengerMessage, sendButtonMessage, sendTypingIndicator } = require('../services/messenger');
const { extractText } = require('../services/ocr');
const { translate } = require('../utils/translations');
const { saveCVFile } = require('../utils/localStorage');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const axios  = require('axios');
const { recruiterAlert } = require('../services/recruiter-alerts');
const { resolveCvAccessUrl } = require('../utils/cv-url');

// NOTE: WhatsApp messages are now proxied to the Python chatbot (CHATBOT_API_URL).
// chatbot-ai.js is kept for reference but is no longer called for WhatsApp.
// All recruitment-system integration routes (chatbot-intake, chatbot-sync, etc.) remain intact.
const { generateResponse, setMissingFields, STATES } = require('../services/chatbot-ai');
const { analyzeMessage, getGreeting } = require('../services/language-processor');

// ===============================================
// WHATSAPP WEBHOOK
// ===============================================

/**
 * WhatsApp webhook verification
 */
router.get('/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WhatsApp webhook verified');
        res.status(200).send(challenge);
    } else {
        res.status(403).send('Verification failed');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook forwarding queue
//
// Meta requires HTTP 200 within 20 seconds.  We must return 200 immediately,
// but we cannot afford to drop messages if the Python bot is temporarily down
// (e.g. during a Cloud Run cold start or a rolling deploy).
//
// Solution: enqueue the payload in memory the moment it arrives, return 200,
// then drain the queue in the background with exponential backoff.  Messages
// are retried up to MAX_RETRIES times before being marked failed.
// ─────────────────────────────────────────────────────────────────────────────
const _webhookQueue = [];
const _MAX_RETRIES  = 10;
let   _draining     = false;

async function _forwardToChatbot(payload, attempt = 1) {
    const chatbotUrl = (process.env.CHATBOT_API_URL || 'http://localhost:8000').replace(/\/$/, '');
    await axios.post(`${chatbotUrl}/webhook/whatsapp`, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 12000,
    });
}

async function _drainWebhookQueue() {
    if (_draining) return;
    _draining = true;
    while (_webhookQueue.length > 0) {
        const item = _webhookQueue[0];
        try {
            await _forwardToChatbot(item.payload, item.attempts);
            _webhookQueue.shift();
            logger.info(`[WhatsApp] Webhook forwarded (attempt ${item.attempts})`);
        } catch (err) {
            item.attempts += 1;
            if (item.attempts > _MAX_RETRIES) {
                logger.error(`[WhatsApp] Dropping webhook after ${_MAX_RETRIES} failed attempts: ${err.message}`);
                _webhookQueue.shift();
            } else {
                // Exponential backoff: 1 s, 2 s, 4 s … capped at 30 s
                const delay = Math.min(1000 * Math.pow(2, item.attempts - 1), 30000);
                logger.warn(`[WhatsApp] Forward failed (attempt ${item.attempts}), retrying in ${delay}ms: ${err.message}`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    _draining = false;
}

/**
 * WhatsApp webhook handler
 */
router.post('/whatsapp', (req, res) => {
    // Return 200 to Meta immediately — required within 20 seconds.
    res.sendStatus(200);

    // Enqueue and drain asynchronously so messages are never silently dropped
    // when the Python chatbot is temporarily unavailable.
    _webhookQueue.push({ payload: req.body, attempts: 1 });
    _drainWebhookQueue().catch(err =>
        logger.error(`[WhatsApp] Queue drain error: ${err.message}`)
    );
});

/**
 * Handle WhatsApp text messages - ENHANCED VERSION
 * Uses advanced chatbot AI with:
 * - Trilingual support (EN/SI/TA)
 * - Sentiment analysis
 * - Knowledge base integration
 * - Slang detection
 */
async function handleWhatsAppTextMessage(message, candidate) {
    const text = message.text.body;
    const from = message.from;

    try {
        // Check if candidate has a CV
        const cvResult = await pool.query(
            'SELECT id FROM cv_files WHERE candidate_id = $1 LIMIT 1',
            [candidate.id]
        );
        const hasCV = cvResult.rows.length > 0;

        // Generate response using enhanced chatbot AI
        const response = await generateResponse({
            message: text,
            candidateId: candidate.id,
            tenantId: candidate.tenant_id || null,
            channel: 'whatsapp',
            hasCV,
            sessionData: null // Will be fetched/created by the service
        });

        // Update candidate's preferred language based on detection
        await pool.query(
            'UPDATE candidates SET preferred_language = $1, last_contact_at = NOW() WHERE id = $2',
            [response.language, candidate.id]
        );

        // Send response
        await sendTextMessage(from, response.text);

        // Log bot response
        await logCommunication({
            candidate_id: candidate.id,
            channel: 'whatsapp',
            direction: 'outbound',
            message_type: 'text',
            content: response.text,
            metadata: {
                intent: response.intent,
                sentiment: response.sentiment,
                language: response.language,
                session_state: response.sessionState,
                kb_articles_used: response.metadata?.kbArticlesUsed || []
            }
        });

        // Log any frustration/handoff requests for recruiter attention
        if (response.sessionState === STATES.HUMAN_HANDOFF) {
            logger.warn(`⚠️ Human handoff requested for candidate ${candidate.phone}`);
            setImmediate(() =>
                recruiterAlert('human_handoff', {
                    candidatePhone: candidate.phone,
                    lastMessage: text
                }).catch(err => logger.warn(`Human handoff alert failed: ${err.message}`))
            );
        }

    } catch (error) {
        logger.error('Enhanced chatbot error: ' + error.message + '\n' + error.stack);

        // Fallback to basic response
        const fallbackResponse = await getGreeting('frustrated', candidate.preferred_language || 'en');
        await sendTextMessage(from, fallbackResponse);

        await logCommunication({
            candidate_id: candidate.id,
            channel: 'whatsapp',
            direction: 'outbound',
            message_type: 'text',
            content: fallbackResponse,
            metadata: { error: true, fallback: true }
        });
    }
}

/**
 * Handle WhatsApp document (CV) uploads
 */
async function handleWhatsAppDocument(message, candidate) {
    const from = message.from;
    const document = message.document;

    try {
        // Download the document
        const { data, mimeType, filename } = await downloadMedia(document.id);

        // Get file extension
        const fileExt = path.extname(filename).toLowerCase().replace('.', '') || 'pdf';

        // Save to local storage
        const fileUrl = await saveCVFile(data, candidate.id, filename, mimeType);

        // Save CV file record
        const cvFileResult = await pool.query(
            `INSERT INTO cv_files (candidate_id, file_url, file_name, file_type, ocr_status)
             VALUES ($1, $2, $3, $4, 'pending')
             RETURNING id`,
            [candidate.id, fileUrl, filename, fileExt]
        );

        const cvFileId = cvFileResult.rows[0].id;

        // Send acknowledgment
        const language = candidate.preferred_language || 'en';
        const ackMessage = translate('cv_received', language);
        await sendTextMessage(from, ackMessage);

        // Process CV asynchronously (don't wait)
        processCVFile(cvFileId, candidate.id, from).catch(err =>
            console.error('CV processing error:', err)
        );

    } catch (error) {
        console.error('Document handling error:', error);
        const language = candidate.preferred_language || 'en';
        await sendTextMessage(from, translate('error_generic', language));
    }
}

/**
 * Handle WhatsApp image uploads (also treat as potential CV)
 */
async function handleWhatsAppImage(message, candidate) {
    // Similar to document handling
    await handleWhatsAppDocument(message, candidate);
}

// ===============================================
// MESSENGER WEBHOOK
// ===============================================

/**
 * Messenger webhook verification
 */
router.get('/messenger', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Messenger webhook verified');
        res.status(200).send(challenge);
    } else {
        res.status(403).send('Verification failed');
    }
});

/**
 * Messenger webhook handler
 */
router.post('/messenger', async (req, res) => {
    // Respond immediately
    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object !== 'page') {
            return;
        }

        const entry = body.entry[0];
        const messaging = entry.messaging[0];

        if (!messaging.message) {
            return;
        }

        const senderId = messaging.sender.id;
        const messageText = messaging.message.text;

        // Show typing indicator
        await sendTypingIndicator(senderId, true);

        // Get or create candidate (use Messenger ID as phone for now)
        let candidate = await getOrCreateCandidate(`messenger_${senderId}`, 'messenger');

        // Handle the message
        await handleMessengerTextMessage(messageText, senderId, candidate);

        // Turn off typing indicator
        await sendTypingIndicator(senderId, false);

        // Log communication
        await logCommunication({
            candidate_id: candidate.id,
            channel: 'messenger',
            direction: 'inbound',
            message_type: 'text',
            content: messageText,
            metadata: { sender_id: senderId }
        });

    } catch (error) {
        console.error('Messenger webhook error:', error);
    }
});

/**
 * Handle Messenger text messages
 */
async function handleMessengerTextMessage(text, senderId, candidate) {
    // Detect language
    const language = await detectLanguage(text);

    // Update candidate's preferred language
    await pool.query(
        'UPDATE candidates SET preferred_language = $1 WHERE id = $2',
        [language, candidate.id]
    );

    // Get conversation history
    const conversationHistory = await getConversationHistory(candidate.id, 'messenger');

    // Generate system prompt
    const systemPrompt = `You are a friendly recruitment assistant for a Sri Lankan recruitment agency.
You are conversing in ${language === 'en' ? 'English' : language === 'si' ? 'Sinhala' : 'Tamil'}.

IMPORTANT: Messenger does not support file uploads directly. 
After collecting basic info, provide a link for CV upload: "Please upload your CV here: ${process.env.FRONTEND_URL}/upload?ref=${candidate.id}"

Your tasks:
1. Greet the candidate warmly
2. Ask for their name, phone number, and email
3. Ask which position they're interested in
4. Provide the upload link for their CV

Keep responses concise. Be friendly and professional.`;

    // Add user message to history
    conversationHistory.push({ role: 'user', content: text });

    // Generate response
    const response = await generateChatbotResponse(conversationHistory, systemPrompt);

    // Check if we should provide upload link
    if (response.includes('upload') || response.includes('CV') || response.includes('resume')) {
        const uploadUrl = `${process.env.FRONTEND_URL || 'https://apply.company.lk'}/upload?ref=${candidate.id}`;
        await sendButtonMessage(senderId, response, [
            { title: 'Upload CV', url: uploadUrl }
        ]);
    } else {
        await sendMessengerMessage(senderId, response);
    }

    // Log bot response
    await logCommunication({
        candidate_id: candidate.id,
        channel: 'messenger',
        direction: 'outbound',
        message_type: 'text',
        content: response
    });
}

// ===============================================
// HELPER FUNCTIONS
// ===============================================

function isPlaceholderCandidateName(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    return ['unknown', 'unknown candidate', 'candidate', 'pending ai extraction', 'n/a', 'na'].includes(normalized)
        || normalized.startsWith('whatsapp ');
}

function resolveCandidateInsertName(identifier, source, name) {
    const explicitName = String(name || '').trim();
    if (explicitName && !isPlaceholderCandidateName(explicitName)) {
        return explicitName;
    }
    if (source === 'whatsapp' || /^\+?\d+$/.test(String(identifier || '').trim())) {
        return String(identifier || '').trim();
    }
    return explicitName || `New ${source || 'candidate'}`;
}

/**
 * Get or create candidate by phone/identifier
 */
async function getOrCreateCandidate(identifier, source, name = '') {
    try {
        // Try to find existing candidate
        const queriedCandidate = await pool.query(
            'SELECT * FROM candidates WHERE phone = $1',
            [identifier]
        );

        if (queriedCandidate.rows.length > 0) {
            return queriedCandidate.rows[0];
        }

        const resolvedName = resolveCandidateInsertName(identifier, source, name);

        // Create new candidate
        const insertResult = await pool.query(
            `INSERT INTO candidates (phone, source, status, name)
             VALUES ($1, $2, 'new', $3) RETURNING id`,
            [identifier, source, resolvedName]
        );

        // Fetch the newly created candidate
        const newCandidateRes = await pool.query('SELECT * FROM candidates WHERE id = $1', [insertResult.rows[0].id]);
        return newCandidateRes.rows[0];
    } catch (error) {
        console.error('Get or create candidate error:', error);
        throw error;
    }
}

/**
 * Get conversation history for chatbot context
 */
async function getConversationHistory(candidateId, channel, limit = 10) {
    try {
        const commsResult = await pool.query(
            `SELECT content, direction 
             FROM communications 
             WHERE candidate_id = $1 AND channel = $2 AND message_type = 'text'
             ORDER BY sent_at DESC
             LIMIT $3`,
            [candidateId, channel, limit]
        );

        // Convert to OpenAI message format
        const history = commsResult.rows.reverse().map(row => ({
            role: row.direction === 'inbound' ? 'user' : 'assistant',
            content: row.content
        }));

        return history;
    } catch (error) {
        console.error('Get conversation history error:', error);
        return [];
    }
}

/**
 * Log communication to database
 */
async function logCommunication(data) {
    try {
        await pool.query(
            `INSERT INTO communications (candidate_id, channel, direction, message_type, content, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                data.candidate_id,
                data.channel,
                data.direction,
                data.message_type,
                data.content,
                JSON.stringify(data.metadata || {})
            ]
        );
    } catch (error) {
        console.error('Log communication error:', error);
    }
}

/**
 * Continue Application Flow (Stage 2)
 * Identifies missing fields and asks the user
 */
async function continueApplicationFlow(candidateId, language, from) {
    // Reload candidate to get latest metadata
    const candidateResult = await pool.query('SELECT * FROM candidates WHERE id = $1', [candidateId]);
    const candidate = candidateResult.rows[0];
    let metadata = candidate.metadata || {};
    if (!metadata.application_form) metadata.application_form = {};

    // Identify missing fields
    const requiredFields = [
        { key: 'full_name', label: 'Full Name' },
        { key: 'address', label: 'Address' },
        { key: 'passport_no', label: 'Passport Number' },
        { key: 'nic_no', label: 'NIC Number' },
        { key: 'email', label: 'Email Address' },
        { key: 'dob', label: 'Date of Birth (YYYY-MM-DD)' },
        { key: 'age', label: 'Age' },
        { key: 'gender', label: 'Gender' },
        { key: 'marital_status', label: 'Marital Status' },
        { key: 'position_applied_for', label: 'Position Applied For' }
    ];

    let nextMissingField = null;
    let nextMissingFieldLabel = null;

    for (const field of requiredFields) {
        if (!metadata.application_form[field.key]) {
            nextMissingField = field.key;
            nextMissingFieldLabel = field.label;
            break;
        }
    }

    // Check contact numbers
    if (!nextMissingField && (!metadata.application_form.contact_numbers || metadata.application_form.contact_numbers.length === 0)) {
        nextMissingField = 'contact_numbers';
        nextMissingFieldLabel = 'Contact Number';
    }

    // Generate system prompt
    const systemPrompt = `You are a friendly recruitment assistant for a Sri Lankan recruitment agency.
You are conversing in ${language === 'en' ? 'English' : language === 'si' ? 'Sinhala' : 'Tamil'}.

Current Status: The candidate has uploaded their CV.
We have extracted some data, but need to fill the rest of the application form.

Current known info: ${JSON.stringify(metadata.application_form, null, 2)}
Missing info: ${nextMissingField ? nextMissingFieldLabel : "None - Application Complete"}

Instruction:
${nextMissingField
            ? `Ask the candidate politely for their ${nextMissingFieldLabel}. Do not ask for multiple things at once. If the user just answered a question, acknowledge it briefly and ask the next one.`
            : `Thank the candidate and confirm their application is complete. Tell them a recruiter will be in touch.`}

Be friendly, empathetic, and professional. Keep responses concise.`;

    // Get conversation history
    const conversationHistory = await getConversationHistory(candidate.id, 'whatsapp');

    // Generate response
    const response = await generateChatbotResponse(conversationHistory, systemPrompt);

    // Update metadata with the field we are likely asking for
    if (nextMissingField) {
        metadata.last_asked_field = nextMissingField;
        await pool.query('UPDATE candidates SET metadata = $1 WHERE id = $2', [metadata, candidate.id]);
    }

    // Send response
    await sendTextMessage(from, response);

    // Log bot response
    await logCommunication({
        candidate_id: candidate.id,
        channel: 'whatsapp',
        direction: 'outbound',
        message_type: 'text',
        content: response
    });
}

/**
 * Process CV file asynchronously
 */
async function processCVFile(cvFileId, candidateId, from) {
    try {
        // Update status to processing
        await pool.query(
            'UPDATE cv_files SET ocr_status = $1 WHERE id = $2',
            ['processing', cvFileId]
        );

        // Get CV file info
        const cvResult = await pool.query(
            'SELECT * FROM cv_files WHERE id = $1',
            [cvFileId]
        );
        const cvFile = cvResult.rows[0];

        const resolvedCv = resolveCvAccessUrl(cvFile);
        if (!resolvedCv.url) {
            throw new Error(`CV URL cannot be resolved for file ${cvFileId}`);
        }

        const tempFilePath = path.join('/tmp', `${cvFileId}.${cvFile.file_type}`);
        if (resolvedCv.url.startsWith('/')) {
            const localFilePath = path.join(__dirname, '../../', resolvedCv.url.replace(/^\//, ''));
            const localBuffer = await fs.readFile(localFilePath);
            await fs.writeFile(tempFilePath, localBuffer);
        } else {
            const response = await fetch(resolvedCv.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch CV file (${response.status})`);
            }
            const buffer = await response.arrayBuffer();
            await fs.writeFile(tempFilePath, Buffer.from(buffer));
        }

        // Extract text using OCR
        const extractedText = await extractText(tempFilePath, cvFile.file_type);

        // Parse resume using LLM
        const parsedData = await parseResume(extractedText);

        // Get current candidate metadata
        const candidateResult = await pool.query('SELECT * FROM candidates WHERE id = $1', [candidateId]);
        const candidate = candidateResult.rows[0];
        const currentMetadata = candidate.metadata || {};

        // Initialize application_form if not present
        if (!currentMetadata.application_form) {
            currentMetadata.application_form = {};
        }

        // Merge parsed data into application_form
        currentMetadata.application_form = { ...currentMetadata.application_form, ...parsedData };

        // Update CV file with OCR text and parsed data
        await pool.query(
            'UPDATE cv_files SET ocr_text = $1, parsed_data = $2, ocr_status = $3, processed_at = NOW() WHERE id = $4',
            [extractedText, JSON.stringify(parsedData), 'completed', cvFileId]
        );

        // Update candidate with parsed data and metadata
        await pool.query(
            'UPDATE candidates SET name = COALESCE($1, name), email = COALESCE($2, email), metadata = $3, updated_at = NOW() WHERE id = $4',
            [parsedData.full_name, parsedData.email, currentMetadata, candidateId]
        );

        // Clean up temp file
        await fs.unlink(tempFilePath);

        console.log(`CV ${cvFileId} processed successfully`);

        // TRIGGER NEXT STEP: Continue flow
        const language = candidate.preferred_language || 'en';
        // We pass 'from' (phone number) if available, otherwise candidate.phone
        const phone = from || candidate.phone;
        await continueApplicationFlow(candidateId, language, phone);

    } catch (error) {
        console.error('CV processing error:', error);
        await pool.query(
            'UPDATE cv_files SET ocr_status = $1 WHERE id = $2',
            ['failed', cvFileId]
        );
    }
}

module.exports = router;