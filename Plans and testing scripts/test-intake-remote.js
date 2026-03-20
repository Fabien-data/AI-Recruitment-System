const https = require('https');

const data = JSON.stringify({
  phone: "94727533155",
  name: "NILESH FERNANDO",
  email: "timothy.nilesh@gmail.com",
  job_interest: "Duty Patrol Driver",
  destination_country: "Oman",
  preferred_language: "en",
  experience_years: 12,
  highest_qualification: "GCE Advanced level",
  cv_parsed_data: {
      technical_skills: ["Photoshop", "Blender 3D"],
      age: 25
  }
});

const req = https.request({
  hostname: 'recruitment-backend-ay6blp2yuq-uc.a.run.app',
  port: 443,
  path: '/api/chatbot/intake',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'x-chatbot-api-key': 'dewan_chatbot_secret_2024_change_in_production'
  }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', body));
});

req.on('error', e => console.error(e));
req.write(data);
req.end();
