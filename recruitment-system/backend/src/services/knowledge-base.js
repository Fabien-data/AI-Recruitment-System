/**
 * Knowledge Base Service
 * 
 * RAG (Retrieval Augmented Generation) implementation for the chatbot:
 * - Keyword-based FAQ matching
 * - Semantic similarity search (when embeddings available)
 * - Context injection for AI prompts
 * - Usage tracking for analytics
 */

const { pool } = require('../config/database');

/**
 * Search knowledge base for relevant FAQ entries
 * @param {string} query - User's question/message
 * @param {string} language - Language code (en, si, ta)
 * @param {string} tenantId - Optional tenant filter
 * @param {number} limit - Max results to return
 * @returns {Promise<Array<KnowledgeBaseEntry>>}
 */
async function searchKnowledgeBase(query, language = 'en', tenantId = null, limit = 3) {
    try {
        const normalizedQuery = query.toLowerCase().trim();

        // Strategy 1: Full-text search on the appropriate language column
        let results = await fullTextSearch(normalizedQuery, language, tenantId, limit);

        // Strategy 2: If no results, try keyword matching
        if (results.length === 0) {
            results = await keywordSearch(normalizedQuery, tenantId, limit);
        }

        // Strategy 3: Try cross-language search (maybe user asked in different language)
        if (results.length === 0) {
            results = await crossLanguageSearch(normalizedQuery, tenantId, limit);
        }

        return results;
    } catch (error) {
        console.error('Knowledge base search error:', error);
        return [];
    }
}

/**
 * Full-text search on language-specific columns
 */
async function fullTextSearch(query, language, tenantId, limit) {
    const columnMap = {
        en: ['question_en', 'answer_en'],
        si: ['question_si', 'answer_si'],
        ta: ['question_ta', 'answer_ta']
    };

    const columns = columnMap[language] || columnMap.en;

    let sql = `
        SELECT id, category, 
               question_${language} as question, 
               answer_${language} as answer,
               question_en, answer_en,
               keywords, priority, usage_count
        FROM knowledge_base
        WHERE is_active = TRUE
          AND (
              MATCH(${columns[0]}, ${columns[1]}) AGAINST($1 IN NATURAL LANGUAGE MODE)
          )
    `;

    const params = [query];
    let pIdx = 2;

    if (tenantId) {
        sql += ` AND (tenant_id = $${pIdx} OR tenant_id IS NULL)`;
        params.push(tenantId);
        pIdx++;
    } else {
        sql += ' AND tenant_id IS NULL';
    }

    sql += ` ORDER BY priority DESC, usage_count DESC LIMIT $${pIdx}`;
    params.push(limit);

    try {
        const result = await pool.query(sql, params);
        return result.rows.map(row => ({
            ...row,
            matchType: 'fulltext',
            language
        }));
    } catch (error) {
        // Fulltext index might not exist or query too short
        console.warn('Fulltext search fallback:', error.message);
        return [];
    }
}

/**
 * Keyword-based search using JSON keywords field
 */
async function keywordSearch(query, tenantId, limit) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    if (words.length === 0) return [];

    // Build ILIKE conditions for each word on keywords JSON cast to text
    const conditions = words.map((w, i) =>
        `keywords::text ILIKE $${i + 1}`
    ).join(' OR ');

    let sql = `
        SELECT id, category,
               COALESCE(question_en, question_si, question_ta) as question,
               COALESCE(answer_en, answer_si, answer_ta) as answer,
               question_en, answer_en, question_si, answer_si, question_ta, answer_ta,
               keywords, priority, usage_count
        FROM knowledge_base
        WHERE is_active = TRUE
          AND (${conditions})
    `;

    const params = words.map(w => `%${w}%`);
    let pIdx = words.length + 1;

    if (tenantId) {
        sql += ` AND (tenant_id = $${pIdx} OR tenant_id IS NULL)`;
        params.push(tenantId);
        pIdx++;
    } else {
        sql += ' AND tenant_id IS NULL';
    }

    sql += ` ORDER BY priority DESC, usage_count DESC LIMIT $${pIdx}`;
    params.push(limit);

    try {
        const result = await pool.query(sql, params);
        return result.rows.map(row => ({
            ...row,
            matchType: 'keyword'
        }));
    } catch (error) {
        console.error('Keyword search fallback:', error.message);
        return [];
    }
}

/**
 * Cross-language search - searches all language columns
 */
async function crossLanguageSearch(query, tenantId, limit) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    if (words.length === 0) return [];

    // Search in all language columns using ILIKE
    const likeConditions = words.map((w, i) => {
        const idx = i + 1;
        return `(question_en ILIKE $${idx} OR question_si ILIKE $${idx} OR question_ta ILIKE $${idx} OR 
                 answer_en ILIKE $${idx} OR answer_si ILIKE $${idx} OR answer_ta ILIKE $${idx})`;
    }).join(' OR ');

    let sql = `
        SELECT id, category,
               COALESCE(question_en, question_si, question_ta) as question,
               COALESCE(answer_en, answer_si, answer_ta) as answer,
               question_en, answer_en, question_si, answer_si, question_ta, answer_ta,
               keywords, priority, usage_count
        FROM knowledge_base
        WHERE is_active = TRUE
          AND (${likeConditions})
    `;

    const params = words.map(w => `%${w}%`);
    let pIdx = words.length + 1;

    if (tenantId) {
        sql += ` AND (tenant_id = $${pIdx} OR tenant_id IS NULL)`;
        params.push(tenantId);
        pIdx++;
    } else {
        sql += ' AND tenant_id IS NULL';
    }

    sql += ` ORDER BY priority DESC, usage_count DESC LIMIT $${pIdx}`;
    params.push(limit);

    const result = await pool.query(sql, params);
    return result.rows.map(row => ({
        ...row,
        matchType: 'cross_language'
    }));
}

/**
 * Build context string from knowledge base results for AI prompt
 * @param {Array} kbResults - Results from searchKnowledgeBase
 * @param {string} language - Target language
 * @returns {string}
 */
function buildKnowledgeContext(kbResults, language = 'en') {
    if (!kbResults || kbResults.length === 0) {
        return '';
    }

    const languageKey = {
        en: { q: 'question_en', a: 'answer_en' },
        si: { q: 'question_si', a: 'answer_si' },
        ta: { q: 'question_ta', a: 'answer_ta' }
    };

    const keys = languageKey[language] || languageKey.en;

    let context = '\n\n--- KNOWLEDGE BASE (Use this information to answer) ---\n';

    for (let i = 0; i < kbResults.length; i++) {
        const entry = kbResults[i];
        const question = entry[keys.q] || entry.question_en || entry.question;
        const answer = entry[keys.a] || entry.answer_en || entry.answer;

        if (question && answer) {
            context += `\nQ${i + 1}: ${question}\nA${i + 1}: ${answer}\n`;
        }
    }

    context += '\n--- END KNOWLEDGE BASE ---\n';
    context += 'If the user\'s question matches the above, use the provided answer. Otherwise, use your general knowledge.\n';

    return context;
}

/**
 * Track usage of a knowledge base entry
 * @param {string} kbId - Knowledge base entry ID
 */
async function trackUsage(kbId) {
    try {
        await pool.query(
            'UPDATE knowledge_base SET usage_count = usage_count + 1 WHERE id = $1',
            [kbId]
        );
    } catch (error) {
        console.error('Track usage error:', error);
    }
}

/**
 * Get all knowledge base entries for admin panel
 * @param {string} tenantId - Tenant filter
 * @param {object} options - Pagination and filter options
 */
async function getAllEntries(tenantId = null, options = {}) {
    const { page = 1, limit = 20, category = null, search = null } = options;
    const offset = (page - 1) * limit;

    let sql = 'SELECT * FROM knowledge_base WHERE 1=1';
    const params = [];
    let pIdx = 1;

    if (tenantId) {
        sql += ` AND (tenant_id = $${pIdx} OR tenant_id IS NULL)`;
        params.push(tenantId);
        pIdx++;
    }

    if (category) {
        sql += ` AND category = $${pIdx}`;
        params.push(category);
        pIdx++;
    }

    if (search) {
        sql += ` AND (question_en LIKE $${pIdx} OR answer_en LIKE $${pIdx} OR question_si LIKE $${pIdx} OR question_ta LIKE $${pIdx})`;
        const searchPattern = `%${search}%`;
        params.push(searchPattern);
        pIdx++;
    }

    sql += ` ORDER BY priority DESC, created_at DESC LIMIT $${pIdx} OFFSET $${pIdx + 1}`;
    params.push(limit, offset);

    const result = await pool.query(sql, params);

    // Get total count
    let countSql = 'SELECT COUNT(*) as total FROM knowledge_base WHERE 1=1';
    const countParams = [];
    let countIdx = 1;

    if (tenantId) {
        countSql += ` AND (tenant_id = $${countIdx} OR tenant_id IS NULL)`;
        countParams.push(tenantId);
        countIdx++;
    }
    if (category) {
        countSql += ` AND category = $${countIdx}`;
        countParams.push(category);
        countIdx++;
    }

    const countResult = await pool.query(countSql, countParams);
    const total = countResult.rows[0].total;

    return {
        entries: result.rows,
        pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
        }
    };
}

/**
 * Create a new knowledge base entry
 * @param {object} data - Entry data
 */
async function createEntry(data) {
    const {
        tenant_id = null,
        category,
        question_en,
        question_si = null,
        question_ta = null,
        answer_en,
        answer_si = null,
        answer_ta = null,
        keywords = [],
        priority = 0,
        created_by = null
    } = data;

    const result = await pool.query(`
        INSERT INTO knowledge_base 
        (tenant_id, category, question_en, question_si, question_ta, 
         answer_en, answer_si, answer_ta, keywords, priority, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id
    `, [
        tenant_id, category, question_en, question_si, question_ta,
        answer_en, answer_si, answer_ta, JSON.stringify(keywords), priority, created_by
    ]);

    return { id: result.rows[0].id, ...data };
}

/**
 * Update a knowledge base entry
 * @param {string} id - Entry ID
 * @param {object} data - Updated data
 */
async function updateEntry(id, data) {
    const updates = [];
    const params = [];
    let pIdx = 1;

    const allowedFields = [
        'category', 'question_en', 'question_si', 'question_ta',
        'answer_en', 'answer_si', 'answer_ta', 'keywords', 'priority', 'is_active'
    ];

    for (const field of allowedFields) {
        if (data[field] !== undefined) {
            updates.push(`${field} = $${pIdx}`);
            params.push(field === 'keywords' ? JSON.stringify(data[field]) : data[field]);
            pIdx++;
        }
    }

    if (updates.length === 0) {
        throw new Error('No valid fields to update');
    }

    params.push(id);

    await pool.query(
        `UPDATE knowledge_base SET ${updates.join(', ')} WHERE id = $${pIdx}`,
        params
    );

    return { id, ...data };
}

/**
 * Delete a knowledge base entry
 * @param {string} id - Entry ID
 */
async function deleteEntry(id) {
    await pool.query('DELETE FROM knowledge_base WHERE id = $1', [id]);
    return { deleted: true, id };
}

/**
 * Bulk import knowledge base entries
 * @param {Array} entries - Array of entry objects
 * @param {string} tenantId - Tenant ID
 */
async function bulkImport(entries, tenantId = null) {
    const results = { imported: 0, errors: [] };

    for (const entry of entries) {
        try {
            await createEntry({ ...entry, tenant_id: tenantId });
            results.imported++;
        } catch (error) {
            results.errors.push({
                entry: entry.question_en?.substring(0, 50),
                error: error.message
            });
        }
    }

    return results;
}

/**
 * Get knowledge base categories
 * @param {string} tenantId - Tenant filter
 */
async function getCategories(tenantId = null) {
    let sql = 'SELECT DISTINCT category, COUNT(*) as count FROM knowledge_base WHERE is_active = TRUE';
    const params = [];

    if (tenantId) {
        sql += ' AND (tenant_id = $1 OR tenant_id IS NULL)';
        params.push(tenantId);
    }

    sql += ' GROUP BY category ORDER BY count DESC';

    const result = await pool.query(sql, params);
    return result.rows;
}

module.exports = {
    searchKnowledgeBase,
    buildKnowledgeContext,
    trackUsage,
    getAllEntries,
    createEntry,
    updateEntry,
    deleteEntry,
    bulkImport,
    getCategories
};
