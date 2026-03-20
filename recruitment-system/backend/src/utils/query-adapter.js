/**
 * SQL Query Adapter
 * 
 * Converts PostgreSQL-style queries to MySQL format.
 * This utility helps migrate from PostgreSQL to MySQL without
 * rewriting every single query in the codebase.
 * 
 * Usage:
 *   const { adaptQuery } = require('../utils/query-adapter');
 *   const sql = adaptQuery('SELECT * FROM users WHERE id = $1', isMySQL);
 *   // MySQL: 'SELECT * FROM users WHERE id = ?'
 *   // PostgreSQL: 'SELECT * FROM users WHERE id = $1'
 */

const isMySQL = process.env.USE_MYSQL === 'true';

/**
 * Convert PostgreSQL parameter placeholders ($1, $2, etc.) to MySQL (?)
 * @param {string} sql - SQL query with PostgreSQL placeholders
 * @returns {string} - SQL query with MySQL placeholders if in MySQL mode
 */
const adaptQuery = (sql) => {
    if (!isMySQL) {
        return sql;
    }

    // Convert $1, $2, $3... to ?
    let converted = sql.replace(/\$\d+/g, '?');

    // Convert ILIKE to LIKE (MySQL is case-insensitive by default)
    converted = converted.replace(/\bILIKE\b/gi, 'LIKE');

    // Convert PostgreSQL RETURNING * (MySQL doesn't support this)
    // This just removes it - you'll need to select separately
    converted = converted.replace(/\s+RETURNING\s+\*/gi, '');
    converted = converted.replace(/\s+RETURNING\s+\w+/gi, '');

    // Convert PostgreSQL array syntax to JSON
    // e.g., tags = ARRAY['tag1', 'tag2'] -> tags = JSON_ARRAY('tag1', 'tag2')
    converted = converted.replace(/ARRAY\[([^\]]+)\]/gi, 'JSON_ARRAY($1)');

    // Convert PostgreSQL NOW() - already compatible
    // Convert PostgreSQL CURRENT_TIMESTAMP - already compatible

    return converted;
};

/**
 * Helper to handle RETURNING * in MySQL
 * Returns the last inserted ID for INSERT operations
 * @param {object} result - Query result from MySQL
 * @returns {string|null} - Inserted ID or null
 */
const getInsertedId = (result) => {
    if (result.insertId) {
        return result.insertId;
    }
    return null;
};

/**
 * Generate a UUID for MySQL
 * MySQL 8.0+ supports UUID() function, but for compatibility
 * we generate it in JavaScript
 */
const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

/**
 * Convert PostgreSQL JSON/JSONB operations to MySQL JSON
 * @param {string} sql - SQL with PostgreSQL JSON syntax
 * @returns {string} - SQL with MySQL JSON syntax
 */
const adaptJsonQuery = (sql) => {
    if (!isMySQL) {
        return sql;
    }

    let converted = sql;

    // Convert PostgreSQL jsonb operators
    // -> becomes JSON_EXTRACT with ->>
    // PostgreSQL: data->>'key' 
    // MySQL: JSON_UNQUOTE(JSON_EXTRACT(data, '$.key'))
    converted = converted.replace(
        /(\w+)->>'(\w+)'/g,
        "JSON_UNQUOTE(JSON_EXTRACT($1, '$.$2'))"
    );

    // PostgreSQL: data->'key'
    // MySQL: JSON_EXTRACT(data, '$.key')
    converted = converted.replace(
        /(\w+)->'(\w+)'/g,
        "JSON_EXTRACT($1, '$.$2')"
    );

    // Convert ::jsonb casts
    converted = converted.replace(/::jsonb/gi, '');
    converted = converted.replace(/::json/gi, '');

    return converted;
};

/**
 * Full query adaptation (combines all conversions)
 */
const fullAdaptQuery = (sql) => {
    let adapted = adaptQuery(sql);
    adapted = adaptJsonQuery(adapted);
    return adapted;
};

module.exports = {
    adaptQuery,
    fullAdaptQuery,
    getInsertedId,
    generateUUID,
    isMySQL
};
