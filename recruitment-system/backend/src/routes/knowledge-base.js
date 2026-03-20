/**
 * Knowledge Base API Routes
 * 
 * Admin API for managing the chatbot knowledge base:
 * - CRUD operations for FAQ entries
 * - Bulk import functionality
 * - Search and analytics
 */

const express = require('express');
const router = express.Router();
const {
    getAllEntries,
    createEntry,
    updateEntry,
    deleteEntry,
    bulkImport,
    getCategories,
    searchKnowledgeBase
} = require('../services/knowledge-base');

/**
 * GET /api/knowledge-base
 * List all knowledge base entries with pagination
 */
router.get('/', async (req, res) => {
    try {
        const { page = 1, limit = 20, category, search, tenant_id } = req.query;

        const result = await getAllEntries(tenant_id || null, {
            page: parseInt(page),
            limit: parseInt(limit),
            category,
            search
        });

        res.json(result);
    } catch (error) {
        console.error('Get knowledge base error:', error);
        res.status(500).json({ error: 'Failed to fetch knowledge base entries' });
    }
});

/**
 * GET /api/knowledge-base/categories
 * Get all categories with counts
 */
router.get('/categories', async (req, res) => {
    try {
        const { tenant_id } = req.query;
        const categories = await getCategories(tenant_id || null);
        res.json(categories);
    } catch (error) {
        console.error('Get categories error:', error);
        res.status(500).json({ error: 'Failed to fetch categories' });
    }
});

/**
 * GET /api/knowledge-base/search
 * Search knowledge base (for testing)
 */
router.get('/search', async (req, res) => {
    try {
        const { q, language = 'en', tenant_id, limit = 5 } = req.query;

        if (!q) {
            return res.status(400).json({ error: 'Query parameter "q" is required' });
        }

        const results = await searchKnowledgeBase(q, language, tenant_id || null, parseInt(limit));
        res.json(results);
    } catch (error) {
        console.error('Search knowledge base error:', error);
        res.status(500).json({ error: 'Search failed' });
    }
});

/**
 * GET /api/knowledge-base/:id
 * Get a single entry by ID
 */
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await getAllEntries(null, { id });

        const entry = result.entries.find(e => e.id === id);
        if (!entry) {
            return res.status(404).json({ error: 'Entry not found' });
        }

        res.json(entry);
    } catch (error) {
        console.error('Get entry error:', error);
        res.status(500).json({ error: 'Failed to fetch entry' });
    }
});

/**
 * POST /api/knowledge-base
 * Create a new knowledge base entry
 */
router.post('/', async (req, res) => {
    try {
        const {
            tenant_id,
            category,
            question_en,
            question_si,
            question_ta,
            answer_en,
            answer_si,
            answer_ta,
            keywords = [],
            priority = 0
        } = req.body;

        // Validation
        if (!category || !question_en || !answer_en) {
            return res.status(400).json({
                error: 'category, question_en, and answer_en are required'
            });
        }

        const entry = await createEntry({
            tenant_id: tenant_id || null,
            category,
            question_en,
            question_si,
            question_ta,
            answer_en,
            answer_si,
            answer_ta,
            keywords,
            priority,
            created_by: req.user?.id || null
        });

        res.status(201).json(entry);
    } catch (error) {
        console.error('Create entry error:', error);
        res.status(500).json({ error: 'Failed to create entry' });
    }
});

/**
 * PUT /api/knowledge-base/:id
 * Update an existing entry
 */
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const entry = await updateEntry(id, updates);
        res.json(entry);
    } catch (error) {
        console.error('Update entry error:', error);
        res.status(500).json({ error: 'Failed to update entry' });
    }
});

/**
 * DELETE /api/knowledge-base/:id
 * Delete an entry
 */
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await deleteEntry(id);
        res.json({ success: true, message: 'Entry deleted' });
    } catch (error) {
        console.error('Delete entry error:', error);
        res.status(500).json({ error: 'Failed to delete entry' });
    }
});

/**
 * POST /api/knowledge-base/import
 * Bulk import FAQ entries
 * 
 * Expected body:
 * {
 *   "tenant_id": "optional-tenant-id",
 *   "entries": [
 *     {
 *       "category": "salary",
 *       "question_en": "What is the salary?",
 *       "answer_en": "Salary depends on role...",
 *       "keywords": ["salary", "pay"]
 *     }
 *   ]
 * }
 */
router.post('/import', async (req, res) => {
    try {
        const { tenant_id, entries } = req.body;

        if (!entries || !Array.isArray(entries)) {
            return res.status(400).json({ error: 'entries array is required' });
        }

        const result = await bulkImport(entries, tenant_id || null);
        res.json(result);
    } catch (error) {
        console.error('Bulk import error:', error);
        res.status(500).json({ error: 'Bulk import failed' });
    }
});

/**
 * POST /api/knowledge-base/test-response
 * Test chatbot response for a given query (for debugging)
 */
router.post('/test-response', async (req, res) => {
    try {
        const { message, language = 'en', tenant_id } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'message is required' });
        }

        // Import chatbot AI
        const { generateResponse } = require('../services/chatbot-ai');
        const { analyzeMessage } = require('../services/language-processor');

        // Analyze message
        const analysis = await analyzeMessage(message);

        // Search knowledge base
        const kbResults = await searchKnowledgeBase(message, language, tenant_id, 3);

        res.json({
            analysis,
            knowledgeBaseResults: kbResults,
            testMode: true
        });
    } catch (error) {
        console.error('Test response error:', error);
        res.status(500).json({ error: 'Test failed' });
    }
});

module.exports = router;
