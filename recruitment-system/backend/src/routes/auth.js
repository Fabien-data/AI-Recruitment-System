const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../config/database');
const { generateToken } = require('../middleware/auth');

/**
 * User registration (admin only in production)
 */
router.post('/register', async (req, res, next) => {
    try {
        const { email, password, full_name, role = 'recruiter' } = req.body;
        
        if (!email || !password || !full_name) {
            return res.status(400).json({ error: 'Email, password, and full name are required' });
        }
        
        // Check if user exists
        const existingUser = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ error: 'User with this email already exists' });
        }
        
        // Hash password
        const password_hash = await bcrypt.hash(password, 10);
        
        // Create user
        const result = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, email, full_name, role, created_at`,
            [email, password_hash, full_name, role]
        );
        
        const user = result.rows[0];
        const token = generateToken(user.id);
        
        res.status(201).json({
            user,
            token
        });
    } catch (error) {
        next(error);
    }
});

/**
 * User login
 */
router.post('/login', async (req, res, next) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        
        // Get user
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND is_active = true',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        const user = result.rows[0];
        
        // Verify password
        const isValid = await bcrypt.compare(password, user.password_hash);
        
        if (!isValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Update last login
        await pool.query(
            'UPDATE users SET last_login_at = NOW() WHERE id = $1',
            [user.id]
        );
        
        // Generate token
        const token = generateToken(user.id);
        
        // Remove password hash from response
        delete user.password_hash;
        
        res.json({
            user,
            token
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Get current user profile
 */
router.get('/me', async (req, res, next) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        const jwt = require('jsonwebtoken');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-in-production');
        
        const result = await pool.query(
            'SELECT id, email, full_name, role, phone, created_at, last_login_at FROM users WHERE id = $1 AND is_active = true',
            [decoded.userId]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid token' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
