/**
 * Supabase Candidates API Routes
 * 
 * These routes read candidate data from Supabase (Place A) where n8n stores
 * all WhatsApp and Gmail candidate data.
 * 
 * Use these routes when USE_SUPABASE_DB=true
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
    isSupabaseConfigured,
    getCandidates,
    getCandidateById,
    getCVFiles,
    getConversations,
    getDashboardStats,
    searchCandidates,
    getWorkflowLogs
} = require('../config/supabase');

// Middleware to check Supabase configuration
const requireSupabase = (req, res, next) => {
    if (!isSupabaseConfigured()) {
        return res.status(503).json({
            error: 'Supabase not configured',
            message: 'Please configure SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables'
        });
    }
    next();
};

/**
 * GET /api/supabase/candidates
 * Get all candidates from Place A (Supabase)
 */
router.get('/candidates', authenticateToken, requireSupabase, async (req, res) => {
    try {
        const { status, source, limit = 50, offset = 0 } = req.query;
        
        const { data, count } = await getCandidates({
            status,
            source,
            limit: parseInt(limit),
            offset: parseInt(offset)
        });

        res.json({
            success: true,
            data,
            pagination: {
                total: count,
                limit: parseInt(limit),
                offset: parseInt(offset)
            }
        });
    } catch (error) {
        console.error('Error fetching Supabase candidates:', error);
        res.status(500).json({
            error: 'Failed to fetch candidates',
            message: error.message
        });
    }
});

/**
 * GET /api/supabase/candidates/:id
 * Get a single candidate with CV files and conversations
 */
router.get('/candidates/:id', authenticateToken, requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const candidate = await getCandidateById(id);

        if (!candidate) {
            return res.status(404).json({
                error: 'Candidate not found'
            });
        }

        res.json({
            success: true,
            data: candidate
        });
    } catch (error) {
        console.error('Error fetching candidate:', error);
        res.status(500).json({
            error: 'Failed to fetch candidate',
            message: error.message
        });
    }
});

/**
 * GET /api/supabase/candidates/:id/cv-files
 * Get all CV files for a candidate
 */
router.get('/candidates/:id/cv-files', authenticateToken, requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const cvFiles = await getCVFiles(id);

        res.json({
            success: true,
            data: cvFiles
        });
    } catch (error) {
        console.error('Error fetching CV files:', error);
        res.status(500).json({
            error: 'Failed to fetch CV files',
            message: error.message
        });
    }
});

/**
 * GET /api/supabase/candidates/:id/conversations
 * Get conversation history for a candidate
 */
router.get('/candidates/:id/conversations', authenticateToken, requireSupabase, async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 50 } = req.query;
        
        const conversations = await getConversations(id, parseInt(limit));

        res.json({
            success: true,
            data: conversations
        });
    } catch (error) {
        console.error('Error fetching conversations:', error);
        res.status(500).json({
            error: 'Failed to fetch conversations',
            message: error.message
        });
    }
});

/**
 * GET /api/supabase/search
 * Search candidates by name, phone, or email
 */
router.get('/search', authenticateToken, requireSupabase, async (req, res) => {
    try {
        const { q } = req.query;
        
        if (!q || q.length < 2) {
            return res.status(400).json({
                error: 'Search query must be at least 2 characters'
            });
        }

        const results = await searchCandidates(q);

        res.json({
            success: true,
            data: results,
            count: results.length
        });
    } catch (error) {
        console.error('Error searching candidates:', error);
        res.status(500).json({
            error: 'Failed to search candidates',
            message: error.message
        });
    }
});

/**
 * GET /api/supabase/dashboard
 * Get dashboard statistics
 */
router.get('/dashboard', authenticateToken, requireSupabase, async (req, res) => {
    try {
        const stats = await getDashboardStats();

        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({
            error: 'Failed to fetch dashboard statistics',
            message: error.message
        });
    }
});

/**
 * GET /api/supabase/workflow-logs
 * Get n8n workflow execution logs (for monitoring)
 */
router.get('/workflow-logs', authenticateToken, requireSupabase, async (req, res) => {
    try {
        const { workflow_name, status, limit = 100 } = req.query;
        
        const logs = await getWorkflowLogs({
            workflow_name,
            status,
            limit: parseInt(limit)
        });

        res.json({
            success: true,
            data: logs
        });
    } catch (error) {
        console.error('Error fetching workflow logs:', error);
        res.status(500).json({
            error: 'Failed to fetch workflow logs',
            message: error.message
        });
    }
});

/**
 * GET /api/supabase/status
 * Check Supabase connection status
 */
router.get('/status', async (req, res) => {
    const configured = isSupabaseConfigured();
    
    res.json({
        supabase_configured: configured,
        supabase_url: process.env.SUPABASE_URL ? '✓ Set' : '✗ Not set',
        service_key: process.env.SUPABASE_SERVICE_KEY ? '✓ Set' : '✗ Not set',
        mode: configured ? 'n8n integration active' : 'legacy mode'
    });
});

module.exports = router;
