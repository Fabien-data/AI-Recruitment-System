/**
 * Database Configuration - Unified Driver
 *
 * Supports four modes:
 * 1. MySQL (for Serverbyt)          - USE_MYSQL=true
 * 2. Supabase PostgreSQL             - USE_SUPABASE_DB=true
 * 3. Google Cloud SQL (PostgreSQL)   - USE_CLOUD_SQL=true
 * 4. Local PostgreSQL (dev/legacy)   - (default)
 *
 * Cloud SQL connection:
 *   - On Cloud Run: uses Unix socket via CLOUD_SQL_INSTANCE_CONNECTION_NAME
 *   - Locally:      uses Cloud SQL Auth Proxy on 127.0.0.1:5432
 */

const useMySQL = process.env.USE_MYSQL === 'true';
const useSupabase = process.env.USE_SUPABASE_DB === 'true';
const useCloudSQL = process.env.USE_CLOUD_SQL === 'true';

let db;

if (useMySQL) {
    // MySQL mode for Serverbyt
    console.log('🔧 Database mode: MySQL (Serverbyt)');
    db = require('./database-mysql');
} else {
    // PostgreSQL mode (Cloud SQL, Supabase, or local)
    const { Pool } = require('pg');

    const getPoolConfig = () => {
        if (useSupabase && process.env.SUPABASE_DB_URL) {
            console.log('📦 Using Supabase PostgreSQL database');
            return {
                connectionString: process.env.SUPABASE_DB_URL,
                ssl: { rejectUnauthorized: false },
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 10000,
            };
        }

        if (useCloudSQL) {
            const instanceConnectionName = process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME;
            if (instanceConnectionName) {
                // Cloud Run: connect via Unix socket (no public IP needed)
                const socketPath = `/cloudsql/${instanceConnectionName}`;
                console.log(`☁️  Using Google Cloud SQL via Unix socket: ${socketPath}`);
                return {
                    user: process.env.CLOUD_SQL_USER || process.env.DB_USER,
                    password: process.env.CLOUD_SQL_PASSWORD || process.env.DB_PASSWORD,
                    database: process.env.CLOUD_SQL_DATABASE || process.env.DB_NAME,
                    host: socketPath,
                    ssl: false, // Unix socket — SSL not needed
                    max: 20,
                    idleTimeoutMillis: 30000,
                    connectionTimeoutMillis: 10000,
                };
            }
            // Local dev: requires Cloud SQL Auth Proxy running on 127.0.0.1:5432
            console.log('☁️  Using Google Cloud SQL via Auth Proxy (localhost:5432)');
            return {
                host: process.env.DB_HOST || '127.0.0.1',
                port: parseInt(process.env.DB_PORT, 10) || 5432,
                database: process.env.CLOUD_SQL_DATABASE || process.env.DB_NAME,
                user: process.env.CLOUD_SQL_USER || process.env.DB_USER,
                password: process.env.CLOUD_SQL_PASSWORD || process.env.DB_PASSWORD,
                ssl: false,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 10000,
            };
        }

        console.log('📦 Using local PostgreSQL database');
        return {
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT, 10) || 5432,
            database: process.env.DB_NAME,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            ssl: false,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        };
    };

    const pool = new Pool(getPoolConfig());

    pool.on('connect', () => {
        const dbType = useCloudSQL ? 'Google Cloud SQL' : useSupabase ? 'Supabase' : 'local';
        console.log(`✅ Connected to ${dbType} PostgreSQL database`);
    });

    pool.on('error', (err) => {
        console.error('❌ Unexpected database error:', err);
        process.exit(-1);
    });

    const withTransaction = async (callback) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const result = await callback(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    };

    db = {
        pool,
        query: (text, params) => pool.query(text, params),
        withTransaction,
        isUsingSupabase: () => useSupabase,
        isUsingCloudSQL: () => useCloudSQL,
        isUsingMySQL: () => false,
        generateUUID: () => require('crypto').randomUUID()
    };
}

// Add MySQL flag to the exported db object
if (!db.isUsingMySQL) {
    db.isUsingMySQL = () => useMySQL;
}

module.exports = db;
