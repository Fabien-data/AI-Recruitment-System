/**
 * MySQL Database Configuration
 * 
 * This module provides MySQL connection pool for Serverbyt hosting.
 * Replaces the PostgreSQL (pg) driver for MySQL compatibility.
 */

const mysql = require('mysql2/promise');

// Determine environment
const isProduction = process.env.NODE_ENV === 'production';

// Build connection config
const getPoolConfig = () => {
    const config = {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT, 10) || 3306,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        waitForConnections: true,
        connectionLimit: 20,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        // MySQL specific options
        timezone: '+00:00',
        dateStrings: true,
        multipleStatements: false, // Security: prevent SQL injection
    };

    // Add SSL for production
    if (isProduction && process.env.DB_SSL === 'true') {
        config.ssl = {
            rejectUnauthorized: false
        };
    }

    return config;
};

// Create connection pool
const pool = mysql.createPool(getPoolConfig());

/**
 * Normalize PostgreSQL-style SQL to MySQL.
 * Converts $1/$2/... to ?, ILIKE to LIKE, removes RETURNING.
 */
function normalizeSql(sql) {
    return String(sql)
        .replace(/\$\d+/g, '?')
        .replace(/\bILIKE\b/gi, 'LIKE')
        .replace(/\s+RETURNING\s+\*/gi, '')
        .replace(/\s+RETURNING\s+\w+/gi, '');
}

/**
 * Wrap the pool so that pool.query() and pool.execute() auto-normalize SQL.
 * This allows every existing route that uses pool.query('...$1...', [])
 * to work on MySQL without any code changes.
 */
const originalQuery = pool.query.bind(pool);
const originalExecute = pool.execute.bind(pool);
pool.query = (sql, params, callback) => {
    const normalized = normalizeSql(sql);
    if (typeof params === 'function') return originalQuery(normalized, params);
    if (typeof callback === 'function') return originalQuery(normalized, params, callback);
    return originalQuery(normalized, params);
};
pool.execute = (sql, params) => originalExecute(normalizeSql(sql), params);

// Test connection on startup
const testConnection = async () => {
    try {
        const conn = await pool.getConnection();
        console.log('✅ Connected to MySQL database');
        conn.release();
        return true;
    } catch (err) {
        console.error('❌ MySQL connection error:', err.message);
        return false;
    }
};

// Initialize connection test
testConnection();

/**
 * Query wrapper that maintains PostgreSQL-like interface
 * AND auto-converts PostgreSQL $n params to MySQL ? style.
 * This makes ALL existing routes work on MySQL without any changes.
 *
 * @param {string} sql - SQL query (supports both ? and $1/$2/$3 style params)
 * @param {array} params - Query parameters
 * @returns {object} - { rows: [...], rowCount: n }
 */
const query = async (sql, params = []) => {
    try {
        // Auto-convert PostgreSQL-style params ($1, $2, ...) to MySQL (?)
        // (pool.execute also normalizes, but this is a safety net)
        let normalizedSql = normalizeSql(sql);

        const [rows] = await pool.execute(normalizedSql, params);

        // Handle different query types
        if (Array.isArray(rows)) {
            // SELECT queries return array
            return {
                rows,
                rowCount: rows.length
            };
        } else {
            // INSERT/UPDATE/DELETE return ResultSetHeader
            return {
                rows: [],
                rowCount: rows.affectedRows,
                insertId: rows.insertId
            };
        }
    } catch (error) {
        console.error('Database query error:', error);
        throw error;
    }
};

/**
 * Helper function for transactions
 * 
 * @param {function} callback - Async function receiving connection
 * @returns {any} - Result from callback
 */
const withTransaction = async (callback) => {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await callback(conn);
        await conn.commit();
        return result;
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
};

/**
 * Get a raw connection for complex operations
 */
const getConnection = () => pool.getConnection();

/**
 * Execute query with connection (for use within transactions)
 * Also normalizes PostgreSQL SQL to MySQL automatically.
 */
const queryWithConnection = async (conn, sql, params = []) => {
    const [rows] = await conn.execute(normalizeSql(sql), params);
    if (Array.isArray(rows)) {
        return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: rows.affectedRows, insertId: rows.insertId };
};

/**
 * Generate UUID for MySQL (if not using MySQL 8.0+ UUID())
 */
const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

module.exports = {
    pool,
    query,
    withTransaction,
    getConnection,
    queryWithConnection,
    generateUUID,
    testConnection
};
