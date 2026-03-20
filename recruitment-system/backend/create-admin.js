/**
 * Create Admin User Script
 * Run: node create-admin.js
 */

const bcrypt = require('bcrypt');
require('dotenv').config();

const ADMIN_EMAIL = 'admin@recruitment.com';
const ADMIN_PASSWORD = 'admin123';
const ADMIN_NAME = 'Admin User';

async function createAdmin() {
    const { pool } = require('./src/config/database');

    try {
        console.log('Creating admin user in PostgreSQL...');

        const existingUser = await pool.query(
            'SELECT id, email, full_name, role FROM users WHERE email = $1',
            [ADMIN_EMAIL]
        );

        if (existingUser.rows.length > 0) {
            console.log('Admin user already exists:');
            console.log(existingUser.rows[0]);
            await pool.end();
            return;
        }

        const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, role, is_active)
             VALUES ($1, $2, $3, $4, true)
             RETURNING id, email, full_name, role`,
            [ADMIN_EMAIL, password_hash, ADMIN_NAME, 'admin']
        );

        console.log('Admin user created successfully!');
        console.log(`\nEmail: ${ADMIN_EMAIL}`);
        console.log(`Password: ${ADMIN_PASSWORD}\n`);
        console.log('User details:', result.rows[0]);
        await pool.end();
    } catch (error) {
        console.error('Error creating admin user:', error.message);
        await pool.end();
        process.exit(1);
    }
}

createAdmin();
