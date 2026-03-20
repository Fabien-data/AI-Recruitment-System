/**
 * Email Processor Job
 * Polls Gmail for new CVs and processes them into the recruitment system
 */

const { pool } = require('../config/database');
const gmailService = require('../services/gmail');
const { parseResume } = require('../config/openai');
const { extractText } = require('../services/ocr');
const { saveCVFile } = require('../utils/localStorage');
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');

// Label for processed emails
const PROCESSED_LABEL = 'Recruitment-Processed';

// Temp directory for processing
const TEMP_DIR = path.join(__dirname, '../../temp');

/**
 * Main function to process new emails
 */
async function processNewEmails() {
    const startTime = Date.now();
    let processedCount = 0;
    let errorCount = 0;
    const results = [];
    
    try {
        // Check if Gmail is connected
        const isConnected = await gmailService.isConnected();
        if (!isConnected) {
            logger.warn('Gmail not connected - skipping email processing');
            return { processed: 0, errors: 0, message: 'Gmail not connected' };
        }
        
        logger.info('Starting email processing job...');
        
        // Ensure temp directory exists
        await fs.mkdir(TEMP_DIR, { recursive: true });
        
        // Fetch unread emails with attachments
        const emails = await gmailService.fetchUnreadEmailsWithAttachments(20);
        logger.info(`Found ${emails.length} unread emails with attachments`);
        
        for (const email of emails) {
            try {
                // Skip if no CV-like attachments
                if (email.attachments.length === 0) {
                    await gmailService.markAsRead(email.id);
                    continue;
                }
                
                logger.info(`Processing email from: ${email.from} - Subject: ${email.subject}`);
                
                // Process each CV attachment
                for (const attachment of email.attachments) {
                    try {
                        const result = await processEmailCV(email, attachment);
                        results.push(result);
                        processedCount++;
                    } catch (attachError) {
                        logger.error(`Error processing attachment ${attachment.filename}:`, attachError.message);
                        errorCount++;
                    }
                }
                
                // Mark email as read and add label
                await gmailService.markAsRead(email.id);
                await gmailService.addLabel(email.id, PROCESSED_LABEL);
                
                // Send auto-reply acknowledgement
                try {
                    await gmailService.sendAutoReply(email.from, email.subject, email.senderName);
                } catch (replyError) {
                    logger.error(`Failed to send auto-reply to ${email.from}:`, replyError.message);
                }
                
            } catch (emailError) {
                logger.error(`Error processing email ${email.id}:`, emailError.message);
                errorCount++;
            }
        }
        
        const duration = Date.now() - startTime;
        logger.info(`Email processing completed: ${processedCount} processed, ${errorCount} errors in ${duration}ms`);
        
        return {
            processed: processedCount,
            errors: errorCount,
            duration,
            results
        };
        
    } catch (error) {
        logger.error('Email processing job failed:', error.message);
        throw error;
    }
}

/**
 * Process a single CV from email
 */
async function processEmailCV(email, attachment) {
    const { from, senderName, subject, bodyText } = email;
    const { filename, attachmentId, mimeType } = attachment;
    
    logger.info(`Processing CV: ${filename} from ${from}`);
    
    // Download attachment
    const fileBuffer = await gmailService.downloadAttachment(email.id, attachmentId);
    
    // Check if candidate already exists by email
    let candidate = await findOrCreateCandidateByEmail(from, senderName, subject);
    
    // Save CV file to local storage
    const fileUrl = await saveCVFile(fileBuffer, candidate.id, filename, mimeType);
    
    // Get file extension for OCR
    const ext = path.extname(filename).toLowerCase().replace('.', '');
    
    // Save to temp file for OCR processing
    const tempFilePath = path.join(TEMP_DIR, `${candidate.id}_${Date.now()}.${ext}`);
    await fs.writeFile(tempFilePath, fileBuffer);
    
    // Create CV file record
    const cvFileResult = await pool.query(
        `INSERT INTO cv_files (candidate_id, file_url, file_name, file_type, ocr_status)
         VALUES ($1, $2, $3, $4, 'processing')
         RETURNING id`,
        [candidate.id, fileUrl, filename, ext]
    );
    const cvFileId = cvFileResult.rows[0].id;
    
    try {
        // Extract text using OCR
        const extractedText = await extractText(tempFilePath, ext);
        
        // Parse resume using AI
        const parsedData = await parseResume(extractedText);
        
        // Update CV file with OCR results
        await pool.query(
            `UPDATE cv_files 
             SET ocr_text = $1, parsed_data = $2, ocr_status = 'completed', processed_at = NOW()
             WHERE id = $3`,
            [extractedText, JSON.stringify(parsedData), cvFileId]
        );
        
        // Update candidate with parsed data
        await updateCandidateFromParsedData(candidate.id, parsedData, from);
        
        // Log communication
        await logCommunication(candidate.id, email, 'CV received and processed');
        
        // Clean up temp file
        await fs.unlink(tempFilePath).catch(() => {});
        
        logger.info(`CV processed successfully for candidate ${candidate.id}`);
        
        return {
            candidateId: candidate.id,
            email: from,
            filename,
            status: 'success',
            parsedFields: Object.keys(parsedData).filter(k => parsedData[k] !== null)
        };
        
    } catch (processError) {
        // Update CV status to failed
        await pool.query(
            `UPDATE cv_files SET ocr_status = 'failed', processed_at = NOW() WHERE id = $1`,
            [cvFileId]
        );
        
        // Clean up temp file
        await fs.unlink(tempFilePath).catch(() => {});
        
        throw processError;
    }
}

/**
 * Find existing candidate by email or create new one
 */
async function findOrCreateCandidateByEmail(email, name, subject) {
    // Try to find by email first
    let result = await pool.query(
        'SELECT * FROM candidates WHERE email = $1',
        [email]
    );
    
    if (result.rows.length > 0) {
        logger.info(`Found existing candidate by email: ${email}`);
        return result.rows[0];
    }
    
    // Try to extract position from subject line
    let positionApplied = null;
    const positionKeywords = ['driver', 'security', 'helper', 'cleaner', 'cook', 'waiter', 'housekeeping'];
    const subjectLower = subject.toLowerCase();
    for (const keyword of positionKeywords) {
        if (subjectLower.includes(keyword)) {
            positionApplied = keyword.charAt(0).toUpperCase() + keyword.slice(1);
            break;
        }
    }
    
    // Create new candidate
    // Use email as phone temporarily (will be updated when CV is parsed)
    const tempPhone = `email_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    result = await pool.query(
        `INSERT INTO candidates (name, phone, email, source, status, metadata)
         VALUES ($1, $2, $3, 'email', 'new', $4)
         RETURNING *`,
        [
            name || email.split('@')[0],
            tempPhone,
            email,
            JSON.stringify({
                application_form: {
                    position_applied_for: positionApplied
                },
                email_subject: subject
            })
        ]
    );
    
    logger.info(`Created new candidate from email: ${email}`);
    return result.rows[0];
}

/**
 * Update candidate record with parsed CV data
 */
async function updateCandidateFromParsedData(candidateId, parsedData, email) {
    // Get current candidate
    const candidateResult = await pool.query(
        'SELECT * FROM candidates WHERE id = $1',
        [candidateId]
    );
    const candidate = candidateResult.rows[0];
    
    // Merge parsed data into metadata
    let metadata = candidate.metadata || {};
    if (!metadata.application_form) {
        metadata.application_form = {};
    }
    
    // Only update fields that have values
    Object.keys(parsedData).forEach(key => {
        if (parsedData[key] !== null && parsedData[key] !== undefined) {
            metadata.application_form[key] = parsedData[key];
        }
    });
    
    // Update candidate record
    const updateFields = [];
    const updateValues = [];
    let paramCount = 1;
    
    // Update name if we have a better one
    if (parsedData.full_name && parsedData.full_name !== candidate.name) {
        updateFields.push(`name = $${paramCount++}`);
        updateValues.push(parsedData.full_name);
    }
    
    // Update phone if we have one (and current is temporary)
    if (parsedData.contact_numbers && parsedData.contact_numbers.length > 0) {
        const phone = parsedData.contact_numbers[0];
        if (candidate.phone.startsWith('email_')) {
            updateFields.push(`phone = $${paramCount++}`);
            updateValues.push(phone);
        }
    }
    
    // Always update metadata and timestamp
    updateFields.push(`metadata = $${paramCount++}`);
    updateValues.push(JSON.stringify(metadata));
    
    updateFields.push(`updated_at = NOW()`);
    updateFields.push(`last_contact_at = NOW()`);
    
    // Add candidate ID for WHERE clause
    updateValues.push(candidateId);
    
    await pool.query(
        `UPDATE candidates SET ${updateFields.join(', ')} WHERE id = $${paramCount}`,
        updateValues
    );
    
    // Identify missing required fields for future follow-up
    const requiredFields = ['full_name', 'contact_numbers', 'nic_no', 'dob', 'gender'];
    const missingFields = requiredFields.filter(f => {
        if (f === 'contact_numbers') {
            return !parsedData[f] || parsedData[f].length === 0;
        }
        return !parsedData[f];
    });
    
    if (missingFields.length > 0) {
        logger.info(`Candidate ${candidateId} missing fields: ${missingFields.join(', ')}`);
        // Store missing fields for AI receptionist follow-up (when 3CX is implemented)
        metadata.missing_fields = missingFields;
        metadata.needs_followup = true;
        await pool.query(
            'UPDATE candidates SET metadata = $1 WHERE id = $2',
            [JSON.stringify(metadata), candidateId]
        );
    }
    
    return metadata;
}

/**
 * Log email communication to database
 */
async function logCommunication(candidateId, email, note) {
    try {
        await pool.query(
            `INSERT INTO communications (candidate_id, channel, direction, message_type, content, metadata)
             VALUES ($1, 'email', 'inbound', 'document', $2, $3)`,
            [
                candidateId,
                `Subject: ${email.subject}\n\n${note}`,
                JSON.stringify({
                    email_id: email.id,
                    from: email.from,
                    subject: email.subject,
                    date: email.date,
                    attachments: email.attachments.map(a => a.filename)
                })
            ]
        );
    } catch (error) {
        logger.error('Error logging communication:', error.message);
    }
}

/**
 * Start the email polling scheduler
 */
let pollingInterval = null;

function startEmailPolling(intervalMinutes = 2) {
    if (pollingInterval) {
        logger.warn('Email polling already running');
        return;
    }
    
    const intervalMs = intervalMinutes * 60 * 1000;
    
    logger.info(`Starting email polling every ${intervalMinutes} minutes`);
    
    // Run immediately on start
    processNewEmails().catch(err => logger.error('Initial email processing failed:', err.message));
    
    // Then schedule recurring runs
    pollingInterval = setInterval(async () => {
        try {
            await processNewEmails();
        } catch (error) {
            logger.error('Scheduled email processing failed:', error.message);
        }
    }, intervalMs);
}

function stopEmailPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        logger.info('Email polling stopped');
    }
}

function isPollingActive() {
    return pollingInterval !== null;
}

module.exports = {
    processNewEmails,
    startEmailPolling,
    stopEmailPolling,
    isPollingActive
};
