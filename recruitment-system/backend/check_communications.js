require('dotenv').config();
const { pool } = require('./src/config/database');

async function check() {
    try {
        const res = await pool.query("SELECT content, sent_at FROM communications ORDER BY sent_at DESC LIMIT 5");
        console.log("Latest communications:");
        console.table(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
check();
