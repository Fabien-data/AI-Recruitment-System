const bcrypt = require('bcrypt');
const { pool } = require('./src/config/database');
async function resetPassword() {
    try {
        console.log('Resetting admin user password in PostgreSQL...');
        const password_hash = await bcrypt.hash('admin123', 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [password_hash, 'admin@recruitment.com']);
        console.log('Password reset successfully to admin123!');
        await pool.end();
    } catch (e) {
        console.error(e);
        await pool.end();
    }
}
resetPassword();
