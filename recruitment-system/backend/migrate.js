/**
 * Database Migration Script
 * Applies the schema.sql to the PostgreSQL database using Node.js
 * Run: node migrate.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'recruitment_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: false,
});

async function migrate() {
    console.log('Starting database migration...');
    console.log(`Connecting to: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);

    const client = await pool.connect();

    try {
        // Read schema file
        const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');

        console.log('Applying schema...');

        // Execute the schema
        await client.query(schema);

        console.log('Schema applied successfully!');

        // Verify tables were created
        const tablesResult = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            ORDER BY table_name;
        `);

        console.log('\nTables created:');
        tablesResult.rows.forEach((row) => {
            console.log(`  - ${row.table_name}`);
        });

        console.log('\nMigration completed successfully!');
    } catch (error) {
        if (error.message.includes('already exists')) {
            console.log('Some objects already exist, checking current state...');

            const tablesResult = await client.query(`
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public' 
                ORDER BY table_name;
            `);

            if (tablesResult.rows.length > 0) {
                console.log('\nExisting tables:');
                tablesResult.rows.forEach((row) => {
                    console.log(`  - ${row.table_name}`);
                });
                console.log('\nDatabase already has tables. Migration skipped.');
            } else {
                throw error;
            }
        } else {
            console.error('Migration failed:', error.message);
            throw error;
        }
    } finally {
        client.release();
        await pool.end();
    }
}

migrate().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
