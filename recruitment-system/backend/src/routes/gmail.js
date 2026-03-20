const express = require('express');
const router = express.Router();
const gmailService = require('../services/gmail');
const { authenticate, authorize } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * GET /api/gmail/status
 * Check Gmail connection status
 */
router.get('/status', authenticate, async (req, res, next) => {
    try {
        const status = await gmailService.getConnectionStatus();
        res.json(status);
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/gmail/auth
 * Start OAuth2 flow - returns auth URL
 */
router.get('/auth', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const authUrl = gmailService.getAuthUrl();
        res.json({ 
            authUrl,
            message: 'Please visit this URL to authorize Gmail access'
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/gmail/oauth/callback
 * OAuth2 callback handler
 */
router.get('/oauth/callback', async (req, res, next) => {
    try {
        const { code, error } = req.query;
        
        if (error) {
            logger.error('Gmail OAuth error:', error);
            // Redirect to frontend with error
            return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?gmail_error=${encodeURIComponent(error)}`);
        }
        
        if (!code) {
            return res.status(400).json({ error: 'Authorization code missing' });
        }
        
        await gmailService.handleOAuthCallback(code);
        
        // Get the connected email for confirmation
        const status = await gmailService.getConnectionStatus();
        
        logger.info(`Gmail connected: ${status.email}`);
        
        // Redirect to frontend with success
        res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?gmail_connected=${encodeURIComponent(status.email)}`);
        
    } catch (error) {
        logger.error('Gmail OAuth callback error:', error);
        res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/settings?gmail_error=${encodeURIComponent(error.message)}`);
    }
});

/**
 * POST /api/gmail/disconnect
 * Disconnect Gmail account
 */
router.post('/disconnect', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        await gmailService.disconnect();
        res.json({ success: true, message: 'Gmail disconnected successfully' });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/gmail/emails
 * Fetch recent unread emails with attachments (for manual inspection)
 */
router.get('/emails', authenticate, async (req, res, next) => {
    try {
        const { limit = 10 } = req.query;
        const emails = await gmailService.fetchUnreadEmailsWithAttachments(parseInt(limit));
        res.json({
            count: emails.length,
            emails: emails.map(e => ({
                id: e.id,
                from: e.from,
                senderName: e.senderName,
                subject: e.subject,
                date: e.date,
                snippet: e.snippet,
                attachments: e.attachments.map(a => ({
                    filename: a.filename,
                    mimeType: a.mimeType,
                    size: a.size
                }))
            }))
        });
    } catch (error) {
        if (error.message.includes('not authenticated')) {
            return res.status(401).json({ 
                error: 'Gmail not connected', 
                message: 'Please connect Gmail first via /api/gmail/auth' 
            });
        }
        next(error);
    }
});

/**
 * POST /api/gmail/process
 * Manually trigger email processing
 */
router.post('/process', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        // Import the email processor
        const { processNewEmails } = require('../jobs/emailProcessor');
        
        const result = await processNewEmails();
        res.json({
            success: true,
            message: 'Email processing completed',
            ...result
        });
    } catch (error) {
        if (error.message.includes('not authenticated')) {
            return res.status(401).json({ 
                error: 'Gmail not connected', 
                message: 'Please connect Gmail first via /api/gmail/auth' 
            });
        }
        next(error);
    }
});

/**
 * POST /api/gmail/test-reply
 * Send a test auto-reply (for testing)
 */
router.post('/test-reply', authenticate, authorize('admin'), async (req, res, next) => {
    try {
        const { email, name } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email address required' });
        }
        
        await gmailService.sendAutoReply(email, 'Test Application', name || 'Test User');
        res.json({ success: true, message: `Test reply sent to ${email}` });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
