const { google } = require('googleapis');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

// Token storage path
const TOKEN_PATH = path.join(__dirname, '../../.gmail_tokens.json');

// Gmail API scopes
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify'
];

/**
 * Create OAuth2 client
 */
function createOAuth2Client() {
    return new google.auth.OAuth2(
        process.env.GMAIL_CLIENT_ID,
        process.env.GMAIL_CLIENT_SECRET,
        process.env.GMAIL_REDIRECT_URI
    );
}

/**
 * Get the authorization URL for OAuth2
 */
function getAuthUrl() {
    const oAuth2Client = createOAuth2Client();
    return oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent' // Force consent to get refresh token
    });
}

/**
 * Exchange authorization code for tokens
 */
async function handleOAuthCallback(code) {
    const oAuth2Client = createOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    
    // Save tokens to file
    await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    logger.info('Gmail tokens saved successfully');
    
    return tokens;
}

/**
 * Load saved tokens
 */
async function loadTokens() {
    try {
        const tokenData = await fs.readFile(TOKEN_PATH, 'utf-8');
        return JSON.parse(tokenData);
    } catch (error) {
        return null;
    }
}

/**
 * Get authenticated Gmail client
 */
async function getGmailClient() {
    const tokens = await loadTokens();
    if (!tokens) {
        throw new Error('Gmail not authenticated. Please complete OAuth flow first.');
    }
    
    const oAuth2Client = createOAuth2Client();
    oAuth2Client.setCredentials(tokens);
    
    // Handle token refresh
    oAuth2Client.on('tokens', async (newTokens) => {
        const existingTokens = await loadTokens();
        const updatedTokens = { ...existingTokens, ...newTokens };
        await fs.writeFile(TOKEN_PATH, JSON.stringify(updatedTokens, null, 2));
        logger.info('Gmail tokens refreshed');
    });
    
    return google.gmail({ version: 'v1', auth: oAuth2Client });
}

/**
 * Check if Gmail is connected
 */
async function isConnected() {
    try {
        const tokens = await loadTokens();
        if (!tokens) return false;
        
        const gmail = await getGmailClient();
        await gmail.users.getProfile({ userId: 'me' });
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Get connection status and email address
 */
async function getConnectionStatus() {
    try {
        const tokens = await loadTokens();
        if (!tokens) {
            return { connected: false, email: null };
        }
        
        const gmail = await getGmailClient();
        const profile = await gmail.users.getProfile({ userId: 'me' });
        
        return {
            connected: true,
            email: profile.data.emailAddress,
            messagesTotal: profile.data.messagesTotal,
            threadsTotal: profile.data.threadsTotal
        };
    } catch (error) {
        logger.error('Gmail connection check failed:', error.message);
        return { connected: false, email: null, error: error.message };
    }
}

/**
 * Fetch unread emails with attachments (potential CVs)
 * @param {number} maxResults - Maximum emails to fetch
 */
async function fetchUnreadEmailsWithAttachments(maxResults = 10) {
    const gmail = await getGmailClient();
    
    // Search for unread emails with attachments
    const response = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread has:attachment',
        maxResults
    });
    
    const messages = response.data.messages || [];
    const emails = [];
    
    for (const message of messages) {
        try {
            const fullMessage = await gmail.users.messages.get({
                userId: 'me',
                id: message.id,
                format: 'full'
            });
            
            const headers = fullMessage.data.payload.headers;
            const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'No Subject';
            const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
            const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
            
            // Extract sender email and name
            const emailMatch = from.match(/<([^>]+)>/) || [null, from.trim()];
            const senderEmail = emailMatch[1] || from.replace(/[<>]/g, '').trim();
            const senderName = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || senderEmail.split('@')[0];
            
            // Get attachments (filter for CV-like files)
            const attachments = await getMessageAttachments(gmail, message.id, fullMessage.data.payload);
            
            // Get email body text
            const bodyText = extractEmailBody(fullMessage.data.payload);
            
            emails.push({
                id: message.id,
                threadId: fullMessage.data.threadId,
                subject,
                from: senderEmail,
                senderName,
                date,
                bodyText,
                attachments,
                snippet: fullMessage.data.snippet
            });
        } catch (error) {
            logger.error(`Error fetching email ${message.id}:`, error.message);
        }
    }
    
    return emails;
}

/**
 * Get attachments from email message
 */
async function getMessageAttachments(gmail, messageId, payload) {
    const attachments = [];
    
    // CV file extensions
    const cvExtensions = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
    
    async function processPayloadParts(parts) {
        if (!parts) return;
        
        for (const part of parts) {
            if (part.filename && part.body.attachmentId) {
                const ext = path.extname(part.filename).toLowerCase();
                
                // Check if it's a potential CV file
                if (cvExtensions.includes(ext)) {
                    attachments.push({
                        filename: part.filename,
                        mimeType: part.mimeType,
                        attachmentId: part.body.attachmentId,
                        size: part.body.size
                    });
                }
            }
            
            // Recurse into nested parts
            if (part.parts) {
                await processPayloadParts(part.parts);
            }
        }
    }
    
    await processPayloadParts(payload.parts || [payload]);
    
    return attachments;
}

/**
 * Download attachment content
 */
async function downloadAttachment(messageId, attachmentId) {
    const gmail = await getGmailClient();
    
    const response = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId
    });
    
    // Gmail returns base64url encoded data
    const data = response.data.data;
    const buffer = Buffer.from(data, 'base64');
    
    return buffer;
}

/**
 * Extract plain text body from email
 */
function extractEmailBody(payload) {
    let body = '';
    
    function processPayload(part) {
        if (part.mimeType === 'text/plain' && part.body.data) {
            body += Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        
        if (part.parts) {
            part.parts.forEach(processPayload);
        }
    }
    
    processPayload(payload);
    return body;
}

/**
 * Send auto-reply acknowledgement email
 */
async function sendAutoReply(to, originalSubject, candidateName) {
    const gmail = await getGmailClient();
    
    const subject = `Re: ${originalSubject}`;
    const body = `Dear ${candidateName || 'Applicant'},

Thank you for submitting your CV/Resume to our Recruitment Agency.

We have received your application and it is currently being processed. Our recruitment team will review your qualifications and experience, and will contact you if your profile matches any of our current openings.

In the meantime, if you have any questions, please feel free to reply to this email or contact us via WhatsApp at +94 777301478.

Best regards,
Recruitment Team

---
This is an automated acknowledgement. Please do not reply to this email with additional documents.`;

    // Create email in RFC 2822 format
    const email = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body
    ].join('\r\n');
    
    const encodedEmail = Buffer.from(email).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    
    await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
            raw: encodedEmail
        }
    });
    
    logger.info(`Auto-reply sent to ${to}`);
    return true;
}

/**
 * Mark email as read
 */
async function markAsRead(messageId) {
    const gmail = await getGmailClient();
    
    await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
            removeLabelIds: ['UNREAD']
        }
    });
    
    logger.info(`Email ${messageId} marked as read`);
}

/**
 * Add label to email (for tracking processed emails)
 */
async function addLabel(messageId, labelName) {
    const gmail = await getGmailClient();
    
    // First, get or create the label
    let labelId;
    try {
        const labels = await gmail.users.labels.list({ userId: 'me' });
        const existingLabel = labels.data.labels.find(l => l.name === labelName);
        
        if (existingLabel) {
            labelId = existingLabel.id;
        } else {
            const newLabel = await gmail.users.labels.create({
                userId: 'me',
                requestBody: {
                    name: labelName,
                    labelListVisibility: 'labelShow',
                    messageListVisibility: 'show'
                }
            });
            labelId = newLabel.data.id;
        }
        
        await gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: {
                addLabelIds: [labelId]
            }
        });
    } catch (error) {
        logger.error('Error adding label:', error.message);
    }
}

/**
 * Disconnect Gmail (revoke tokens)
 */
async function disconnect() {
    try {
        const tokens = await loadTokens();
        if (tokens && tokens.access_token) {
            const oAuth2Client = createOAuth2Client();
            oAuth2Client.setCredentials(tokens);
            await oAuth2Client.revokeCredentials();
        }
        
        // Delete token file
        await fs.unlink(TOKEN_PATH).catch(() => {});
        logger.info('Gmail disconnected');
        return true;
    } catch (error) {
        logger.error('Gmail disconnect error:', error.message);
        // Still delete the token file
        await fs.unlink(TOKEN_PATH).catch(() => {});
        return true;
    }
}

module.exports = {
    getAuthUrl,
    handleOAuthCallback,
    isConnected,
    getConnectionStatus,
    fetchUnreadEmailsWithAttachments,
    downloadAttachment,
    sendAutoReply,
    markAsRead,
    addLabel,
    disconnect,
    getGmailClient
};
