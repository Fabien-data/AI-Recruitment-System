/**
 * Direct SQL seeder for communications, translations, and audit_logs
 * Runs as a Cloud Run Job against Cloud SQL
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.CLOUD_SQL_HOST || `/cloudsql/${process.env.CLOUD_SQL_INSTANCE_CONNECTION_NAME}`,
  database: process.env.CLOUD_SQL_DATABASE || 'recruitment_db',
  user: process.env.CLOUD_SQL_USER || 'recruitment_user',
  password: process.env.CLOUD_SQL_PASSWORD,
  ssl: false,
});

async function seed() {
  const client = await pool.connect();
  try {
    console.log('Connected to DB');

    // Get all candidates
    const cands = (await client.query('SELECT id, name, preferred_language FROM candidates ORDER BY created_at')).rows;
    console.log(`Found ${cands.length} candidates`);

    // =====================================================
    // COMMUNICATIONS
    // =====================================================
    const inboundMsgs = [
      "Hello, I am interested in the security guard position. Can you provide more details?",
      "I have attached my CV for your review. I have 5 years of security experience.",
      "What is the salary package for the Dubai Mall position?",
      "I have a valid security license and first aid certification.",
      "I am available Monday to Friday, 9am to 5pm for an interview.",
      "Is accommodation provided with this position?",
      "I have experience working in GCC countries for 3 years.",
      "Can I apply for multiple positions at the same time?"
    ];
    const outboundMsgs = [
      "Thank you for your application. We would like to invite you for a screening interview.",
      "Your application has been reviewed. Please confirm your availability for an interview.",
      "Congratulations! You have been shortlisted. Please bring original documents.",
      "The salary ranges from 3000-3500 AED per month including accommodation and transport.",
      "Please send us copies of your certifications for verification.",
      "We will contact you with further interview details within 48 hours.",
      "Your interview is scheduled for next Monday at 10:00 AM at our office.",
      "Please complete the attached medical form before your interview."
    ];
    const channels = ['whatsapp','whatsapp','email','whatsapp','sms','whatsapp','email','whatsapp'];

    let commCount = 0;
    for (let i = 0; i < cands.length; i++) {
      const cand = cands[i];
      const numMsgs = 3 + (i % 3); // 3-5 messages per candidate
      for (let m = 0; m < numMsgs; m++) {
        const direction = m % 2 === 0 ? 'inbound' : 'outbound';
        const msg = direction === 'inbound'
          ? inboundMsgs[(i + m) % inboundMsgs.length]
          : outboundMsgs[(i + m) % outboundMsgs.length];
        const channel = channels[(i + m) % channels.length];
        const hoursAgo = (numMsgs - m) * 24 + i; // stagger timestamps
        await client.query(
          `INSERT INTO communications (candidate_id, channel, direction, message_type, content, sent_at)
           VALUES ($1, $2, $3, 'text', $4, NOW() - INTERVAL '${hoursAgo} hours')`,
          [cand.id, channel, direction, msg]
        );
        commCount++;
      }
    }
    console.log(`Communications inserted: ${commCount}`);

    // =====================================================
    // TRANSLATIONS
    // =====================================================
    const translations = [
      // Greetings
      ['greeting', 'en', 'Hello! Welcome to Dewan Recruitment Agency. How can I assist you today?', 'chatbot'],
      ['greeting', 'si', 'ආයුබෝවන්! දේවාන් රැකියා නියෝජිතායතනයට සාදරයෙන් පිළිගනිමු. අද ඔබට කෙසේ උදව් කළ හැකිද?', 'chatbot'],
      ['greeting', 'ta', 'வணக்கம்! தேவான் ஆட்சேர்ப்பு நிறுவனத்திற்கு வரவேற்கிறோம். இன்று உங்களுக்கு எவ்வாறு உதவலாம்?', 'chatbot'],
      // Ask name
      ['ask_name', 'en', 'What is your full name?', 'chatbot'],
      ['ask_name', 'si', 'ඔබේ සම්පූර්ණ නම කුමක්ද?', 'chatbot'],
      ['ask_name', 'ta', 'உங்கள் முழு பெயர் என்ன?', 'chatbot'],
      // Ask position
      ['ask_position', 'en', 'Which position are you interested in applying for?', 'chatbot'],
      ['ask_position', 'si', 'ඔබ ඉල්ලුම් කිරීමට කැමති රැකියාව කුමක්ද?', 'chatbot'],
      ['ask_position', 'ta', 'நீங்கள் எந்த பதவிக்கு விண்ணப்பிக்க விரும்புகிறீர்கள்?', 'chatbot'],
      // Ask phone
      ['ask_phone', 'en', 'Please provide your WhatsApp number for further communication.', 'chatbot'],
      ['ask_phone', 'si', 'තව දුරටත් සම්බන්ධ වීම සඳහා ඔබේ WhatsApp අංකය ලබා දෙన්න.', 'chatbot'],
      ['ask_phone', 'ta', 'மேலும் தொடர்புகொள்ள உங்கள் WhatsApp எண்ணை வழங்கவும்.', 'chatbot'],
      // Ask CV
      ['ask_cv', 'en', 'Please upload your CV (PDF or Word document).', 'chatbot'],
      ['ask_cv', 'si', 'ඔබේ CV (PDF හෝ Word ලේඛනය) උඩුගත කරන්න.', 'chatbot'],
      ['ask_cv', 'ta', 'உங்கள் CV ஐ (PDF அல்லது Word ஆவணம்) பதிவேற்றவும்.', 'chatbot'],
      // Application received
      ['application_received', 'en', 'Your application has been received. We will review and contact you within 2-3 business days.', 'chatbot'],
      ['application_received', 'si', 'ඔබේ ඉල්ලුම්පත ලැබී ඇත. අපි සමාලෝචනය කර ව්‍යාපාරික දින 2-3ක් ඇතුළත ඔබව සම්බන්ධ කරගන්නෙමු.', 'chatbot'],
      ['application_received', 'ta', 'உங்கள் விண்ணப்பம் பெறப்பட்டது. நாங்கள் 2-3 வணிக நாட்களுக்குள் உங்களைத் தொடர்பு கொள்வோம்.', 'chatbot'],
      // Interview invitation
      ['interview_invite', 'en', 'Congratulations! You have been shortlisted for an interview. Please confirm your availability.', 'chatbot'],
      ['interview_invite', 'si', 'සුභ පාතිිmath! ඔබ සම්මුඛ පරීක්ෂණය සඳහා කෙටපත් කර ඇත. ඔබේ ලබා ගත හැකිකම තහවුරු කරන්න.', 'chatbot'],
      ['interview_invite', 'ta', 'வாழ்த்துக்கள்! நீங்கள் நேர்காணலுக்கு தேர்ந்தெடுக்கப்பட்டீர்கள். உங்கள் கிடைக்கும் நேரத்தை உறுதிப்படுத்தவும்.', 'chatbot'],
      // Rejection
      ['rejection', 'en', 'Thank you for your interest. Unfortunately, your profile does not match our current requirements. We will keep your details for future opportunities.', 'chatbot'],
      ['rejection', 'si', 'ඔබේ කැමැත්ත ගැන ස්තූතියි. කනගාටුවෙන්, ඔබේ පැතිකඩ අපගේ වත්මන් අවශ්‍යතාවන්ට ගැලපෙන්නේ නැත.', 'chatbot'],
      ['rejection', 'ta', 'உங்கள் ஆர்வத்திற்கு நன்றி. துரதிர்ஷ்டவசமாக, உங்கள் சுயவிவரம் எங்கள் தேவைகளுக்கு பொருந்தவில்லை.', 'chatbot'],
    ];

    let transCount = 0;
    for (const [key, lang, value, ctx] of translations) {
      try {
        await client.query(
          `INSERT INTO translations (key, language, value, context) VALUES ($1, $2, $3, $4)
           ON CONFLICT (key, language) DO UPDATE SET value = $3, updated_at = NOW()`,
          [key, lang, value, ctx]
        );
        transCount++;
      } catch (e) {
        console.log(`Translation skip: ${key}/${lang} - ${e.message}`);
      }
    }
    console.log(`Translations inserted/updated: ${transCount}`);

    // =====================================================
    // AUDIT LOGS (sample activity)
    // =====================================================
    const adminId = (await client.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1")).rows[0]?.id;
    if (adminId) {
      const entities = ['candidate', 'job', 'project', 'application'];
      const actions = ['create', 'update', 'view', 'view', 'view', 'update'];
      let auditCount = 0;
      for (const cand of cands) {
        await client.query(
          `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, ip_address)
           VALUES ($1, 'view', 'candidate', $2, '192.168.1.1')`,
          [adminId, cand.id]
        );
        auditCount++;
      }
      console.log(`Audit logs inserted: ${auditCount}`);
    }

    console.log('\\nAll seed data inserted successfully!');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(e => { console.error(e); process.exit(1); });
