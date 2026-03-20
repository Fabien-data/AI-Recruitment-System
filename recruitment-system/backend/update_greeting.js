require('dotenv').config();
const { pool } = require('./src/config/database');

const greeting = {
    en: "Hello! 👋 Welcome to Dewan Consultants! I'm Dilan, from our recruitment team.\n\nWhich language do you prefer? / ඔබ කැමති කුමන භාෂාවෙන් සම්බන්ධ වීමටද? / நீங்கள் எந்த மொழியில் தொடர விரும்புகிறீர்கள்?\n\n🔹 English\n🔹 සිංහල\n🔹 தமிழ்",
    si: "ආයුබෝවන්! 👋 Dewan Consultants වෙත ඔබව සාදරයෙන් පිළිගනිමු! මම ඩිලාන්, අපේ බඳවා ගැනීමේ කණ්ඩායමෙන්.\n\nWhich language do you prefer? / ඔබ කැමති කුමන භාෂාවෙන් සම්බන්ධ වීමටද? / நீங்கள் எந்த மொழியில் தொடர விரும்புகிறீர்கள்?\n\n🔹 English\n🔹 සිංහල\n🔹 தமிழ்",
    ta: "வணக்கம்! 👋 Dewan Consultants-க்கு உங்களை வரவேற்கிறோம்! நான் திலன், எங்கள் ஆட்சேர்ப்பு குழுவிலிருந்து பேசுகிறேன்.\n\nWhich language do you prefer? / ඔබ කැමති කුමන භාෂාවෙන් සම්බන්ධ වීමටද? / நீங்கள் எந்த மொழியில் தொடர விரும்புகிறீர்கள்?\n\n🔹 English\n🔹 සිංහල\n🔹 தமிழ்"
};

async function updateGreeting() {
    try {
        await pool.query('UPDATE chatbot_config SET greeting_welcome = $1', [JSON.stringify(greeting)]);
        console.log("Greeting successfully updated in DB!");
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}

updateGreeting();
