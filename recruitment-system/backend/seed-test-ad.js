/**
 * seed-test-ad.js — Seeds one ad_tracking row for integration testing
 * Run: node seed-test-ad.js
 */
require('dotenv').config();
const { query } = require('./src/config/database');

async function seed() {
    // Get first job and project
    const [jobRes, projRes] = await Promise.all([
        query('SELECT id, title FROM jobs LIMIT 1'),
        query('SELECT id, title FROM projects LIMIT 1')
    ]);

    if (!jobRes.rows.length) {
        console.error('❌ No jobs found in database. Please create a job first.');
        process.exit(1);
    }
    if (!projRes.rows.length) {
        console.error('❌ No projects found in database. Please create a project first.');
        process.exit(1);
    }

    const jobId = jobRes.rows[0].id;
    const projId = projRes.rows[0].id;
    const adRef = 'security_guard_test001';

    console.log(`Using job:    [${jobId}] ${jobRes.rows[0].title}`);
    console.log(`Using project:[${projId}] ${projRes.rows[0].title}`);
    console.log(`Ad ref:        ${adRef}`);

    // Insert (ignore if already exists)
    const isMySQL = process.env.USE_MYSQL === 'true';

    let result;
    if (isMySQL) {
        result = await query(
            `INSERT IGNORE INTO ad_tracking 
                (id, ad_ref, job_id, project_id, campaign_name, whatsapp_link, clicks, conversions, is_active)
             VALUES (UUID(), ?, ?, ?, ?, ?, 0, 0, 1)`,
            [adRef, jobId, projId,
                'Dubai Security Test Campaign',
                `https://wa.me/94771234567?text=START%3A${adRef}`]
        );
    } else {
        result = await query(
            `INSERT INTO ad_tracking 
                (id, ad_ref, job_id, project_id, campaign_name, whatsapp_link, clicks, conversions, is_active)
             VALUES (uuid_generate_v4()::text, $1, $2, $3, $4, $5, 0, 0, true)
             ON CONFLICT (ad_ref) DO NOTHING`,
            [adRef, jobId, projId,
                'Dubai Security Test Campaign',
                `https://wa.me/94771234567?text=START%3A${adRef}`]
        );
    }

    console.log(`\n✅ Ad tracking row seeded (${result.rowCount} inserted).`);
    console.log(`\n🔗 Test URL: http://localhost:3000/api/public/${adRef}`);
    console.log(`📱 WhatsApp link: https://wa.me/94771234567?text=START%3A${adRef}`);
    process.exit(0);
}

seed().catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
});
