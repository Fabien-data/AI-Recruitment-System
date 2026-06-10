/**
 * Notification Service
 * Handles sending notifications via WhatsApp, Email, and SMS when candidates are certified or status changes
 */
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const whatsapp = require('./whatsapp');
const sms = require('./sms');
const chatbotNotifier = require('./chatbotNotifier');
const logger = require('../utils/logger');

// Notification templates for different scenarios
const NOTIFICATION_TEMPLATES = {
    // Sent when an agent manually adds a candidate from the Messages panel — a
    // warm intro that opens the conversation and hands them to the bot's intake
    // flow. The actual WhatsApp text is rendered by the chatbot (status='welcome',
    // template if out-of-window); this copy is what gets logged to communications.
    welcome: {
        en: {
            subject: '👋 Welcome to Dewan Recruitment',
            message: `👋 Hi {name}, welcome to Dewan Recruitment — Sri Lanka's trusted overseas recruitment agency. We'd love to help you find a great job abroad. To get started, please reply here and our assistant will guide you through a few quick questions.`
        },
        si: {
            subject: '👋 Dewan Recruitment වෙත සාදරයෙන් පිළිගනිමු',
            message: `👋 ආයුබෝවන් {name}, Dewan Recruitment වෙත සාදරයෙන් පිළිගනිමු. විදේශගත හොඳ රැකියාවක් සොයා ගැනීමට අපි ඔබට උදව් කරමු. ආරම්භ කිරීමට, මෙහි පිළිතුරු දෙන්න — අපගේ සහායක ඔබට කෙටි ප්‍රශ්න කිහිපයක් අසනු ඇත.`
        },
        ta: {
            subject: '👋 Dewan Recruitment-க்கு வரவேற்கிறோம்',
            message: `👋 வணக்கம் {name}, Dewan Recruitment-க்கு வரவேற்கிறோம். வெளிநாட்டில் சிறந்த வேலையைக் கண்டுபிடிக்க உங்களுக்கு உதவ விரும்புகிறோம். தொடங்க, இங்கே பதிலளியுங்கள் — எங்கள் உதவியாளர் சில விரைவான கேள்விகளுடன் உங்களை வழிநடத்தும்.`
        }
    },
    // Sent when a recruiter moves a candidate New → Screening (details + CV
    // complete). Confirms the application was received and is under review.
    application_complete: {
        en: {
            subject: '✅ Application Received — {job_title}',
            message: `✅ Dear {name},

Thank you! We have successfully received your application and details for the position of {job_title}.

📋 What happens next:
1. Our team is now reviewing your profile (screening stage)
2. If shortlisted, you will be contacted for the next step
3. Please keep your phone reachable

Thank you for choosing Dewan Recruitment.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: '✅ අයදුම්පත ලැබුණි — {job_title}',
            message: `✅ ආදරණීය {name},

ස්තූතියි! {job_title} තනතුර සඳහා ඔබගේ අයදුම්පත සහ විස්තර අපට සාර්ථකව ලැබී ඇත.

📋 ඊළඟට සිදුවන දේ:
1. අපගේ කණ්ඩායම දැන් ඔබගේ පැතිකඩ සමාලෝචනය කරයි (පරීක්ෂණ අදියර)
2. තෝරාගත හොත්, ඊළඟ පියවර සඳහා ඔබව සම්බන්ධ කරගනු ඇත
3. කරුණාකර ඔබේ දුරකථනය ළඟා විය හැකි ලෙස තබා ගන්න

Dewan Recruitment තෝරා ගැනීම ගැන ස්තූතියි.

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: '✅ விண்ணப்பம் பெறப்பட்டது — {job_title}',
            message: `✅ அன்புள்ள {name},

நன்றி! {job_title} பதவிக்கான உங்கள் விண்ணப்பத்தையும் விவரங்களையும் நாங்கள் வெற்றிகரமாக பெற்றுள்ளோம்.

📋 அடுத்து என்ன நடக்கும்:
1. எங்கள் குழு இப்போது உங்கள் சுயவிவரத்தை மதிப்பாய்வு செய்கிறது (திரையிடல் நிலை)
2. தேர்வு செய்யப்பட்டால், அடுத்த படிக்கு உங்களை தொடர்பு கொள்வோம்
3. உங்கள் தொலைபேசியை அழைப்பில் வைத்திருங்கள்

Dewan Recruitment-ஐ தேர்ந்தெடுத்ததற்கு நன்றி.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    // Sent when a candidate is (auto-)assigned/selected to a job. "You've been
    // selected for {job_title}" — awaiting certification by an agent.
    job_assignment: {
        en: {
            subject: '🎯 You have been selected for {job_title}',
            message: `🎯 Dear {name},

Good news! You have been selected for the role of {job_title} and added to our shortlist.

📋 What happens next:
1. Our team will review and certify your profile
2. Once certified, we will schedule your interview
3. Keep your documents ready and your phone reachable

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: '🎯 ඔබ {job_title} සඳහා තෝරාගෙන ඇත',
            message: `🎯 ආදරණීය {name},

සුභ ආරංචියක්! ඔබ {job_title} තනතුර සඳහා තෝරාගෙන අපගේ කෙටි ලැයිස්තුවට එක් කර ඇත.

📋 ඊළඟට සිදුවන දේ:
1. අපගේ කණ්ඩායම ඔබගේ පැතිකඩ සමාලෝචනය කර සහතික කරයි
2. සහතික වූ පසු, ඔබගේ සම්මුඛ පරීක්ෂණය සැලසුම් කරනු ඇත
3. ලේඛන සූදානම්ව සහ දුරකථනය ළඟා විය හැකි ලෙස තබා ගන්න

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: '🎯 {job_title} பதவிக்கு நீங்கள் தேர்வாகியுள்ளீர்கள்',
            message: `🎯 அன்புள்ள {name},

நல்ல செய்தி! {job_title} பதவிக்கு நீங்கள் தேர்வு செய்யப்பட்டு எங்கள் சுருக்கப்பட்ட பட்டியலில் சேர்க்கப்பட்டுள்ளீர்கள்.

📋 அடுத்து என்ன நடக்கும்:
1. எங்கள் குழு உங்கள் சுயவிவரத்தை மதிப்பாய்வு செய்து சான்றளிக்கும்
2. சான்றளிக்கப்பட்டதும், உங்கள் நேர்காணலை திட்டமிடுவோம்
3. உங்கள் ஆவணங்களை தயாராகவும் தொலைபேசியை அழைப்பிலும் வைத்திருங்கள்

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    certified: {
        en: {
            subject: 'Congratulations! You have passed pre-screening',
            message: `🎉 Dear {name},

Congratulations! You have successfully passed our pre-screening process for the position of {job_title}.

📋 Next Steps:
1. Our team will contact you shortly to schedule an interview
2. Please keep your documents ready
3. Make sure your phone is reachable

If you have any questions, feel free to reply to this message.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'සුභ පැතුම්! ඔබ පූර්ව පරීක්ෂණය සමත් විය',
            message: `🎉 ආදරණීය {name},

සුභ පැතුම්! ඔබ {job_title} තනතුර සඳහා අපගේ පූර්ව පරීක්ෂණ ක්‍රියාවලිය සාර්ථකව සම්පූර්ණ කර ඇත.

📋 ඊළඟ පියවර:
1. සම්මුඛ පරීක්ෂණයක් සැලසුම් කිරීමට අපගේ කණ්ඩායම ඔබව ඉක්මනින් සම්බන්ධ කර ගනු ඇත
2. කරුණාකර ඔබේ ලේඛන සූදානම්ව තබා ගන්න
3. ඔබේ දුරකථනය ළඟා විය හැකි බව සහතික කර ගන්න

ප්‍රශ්න ඇත්නම්, මෙම පණිවිඩයට පිළිතුරු දෙන්න.

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'வாழ்த்துக்கள்! நீங்கள் முன்-திரையிடலில் தேர்ச்சி பெற்றுள்ளீர்கள்',
            message: `🎉 அன்புள்ள {name},

வாழ்த்துக்கள்! {job_title} பதவிக்கான எங்கள் முன்-திரையிடல் செயல்முறையை நீங்கள் வெற்றிகரமாக கடந்துள்ளீர்கள்.

📋 அடுத்த படிகள்:
1. நேர்காணலை திட்டமிட எங்கள் குழு விரைவில் உங்களை தொடர்பு கொள்ளும்
2. உங்கள் ஆவணங்களை தயாராக வைத்திருங்கள்
3. உங்கள் தொலைபேசி அழைப்பில் இருப்பதை உறுதிசெய்யவும்

கேள்விகள் இருந்தால், இந்த செய்திக்கு பதிலளிக்கவும்.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    pre_screened_passed: {
        en: {
            subject: 'Pre-Screening Passed — Interview Next',
            message: `🎉 Dear {name},

Great news! You have successfully passed our pre-screening for the position of {job_title}.

📋 What happens next:
1. Our team will schedule a formal interview with the employer
2. You will receive a separate WhatsApp message with the date, time, and location
3. Keep your documents ready (ID, certificates, work experience letters)
4. Make sure your phone is reachable so we can confirm

Stay tuned and feel free to reply to this message if you have any questions.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'පූර්ව පරීක්ෂණය සමත් — සම්මුඛ පරීක්ෂණය ඊළඟට',
            message: `🎉 ආදරණීය {name},

සුභ ආරංචියක්! {job_title} තනතුර සඳහා අපගේ පූර්ව පරීක්ෂණය ඔබ සාර්ථකව සමත් වී ඇත.

📋 ඊළඟ පියවර:
1. රැකියා හිමියා සමඟ විධිමත් සම්මුඛ පරීක්ෂණයක් අපගේ කණ්ඩායම සැලසුම් කරනු ඇත
2. දිනය, වේලාව සහ ස්ථානය සහිත වෙනම WhatsApp පණිවිඩයක් ඔබට ලැබෙනු ඇත
3. ලේඛන සූදානම්ව තබා ගන්න (හැඳුනුම්පත, සහතික, රැකියා අත්දැකීම් ලිපි)
4. දුරකථනය ළඟා විය හැකි බව සහතික කරන්න

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'முன்-திரையிடல் தேர்ச்சி — அடுத்தது நேர்காணல்',
            message: `🎉 அன்புள்ள {name},

சிறந்த செய்தி! {job_title} பதவிக்கான எங்கள் முன்-திரையிடலை நீங்கள் வெற்றிகரமாக கடந்துள்ளீர்கள்.

📋 அடுத்த படிகள்:
1. வேலை வழங்குபவருடன் முறையான நேர்காணலை எங்கள் குழு திட்டமிடும்
2. தேதி, நேரம், இடம் கொண்ட தனி WhatsApp செய்தி உங்களுக்கு வரும்
3. ஆவணங்களை தயாராக வைக்கவும் (அடையாள அட்டை, சான்றிதழ்கள், அனுபவ கடிதங்கள்)
4. தொலைபேசி அழைப்பில் இருப்பதை உறுதிசெய்யவும்

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    prescreening_certified: {
        en: {
            subject: 'Congratulations! Pre-Screening Invitation - {job_title}',
            message: `🎉 Dear {name},

Congratulations! You have been certified for the position of {job_title} and are invited for pre-screening!

📅 Pre-Screening Details:
📆 Date & Time: {prescreening_datetime}
📍 Location: {prescreening_location}

📋 Please bring the following:
1. Original NIC / Passport
2. Educational certificates
3. Work experience letters
4. Passport-size photographs (2 copies)

⚠️ Please arrive 15 minutes early for registration.

If you need to reschedule, please contact us immediately by replying to this message.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'සුභ පැතුම්! පූර්ව පරීක්ෂණ ආරාධනය - {job_title}',
            message: `🎉 ආදරණීය {name},

සුභ පැතුම්! ඔබ {job_title} තනතුර සඳහා සහතික කර ඇති අතර පූර්ව පරීක්ෂණය සඳහා ආරාධනා කරනු ලැබේ!

📅 පූර්ව පරීක්ෂණ විස්තර:
📆 දිනය සහ වේලාව: {prescreening_datetime}
📍 ස්ථානය: {prescreening_location}

📋 කරුණාකර පහත දෑ රැගෙන එන්න:
1. මුල් හැඳුනුම්පත / විදේශ ගමන් බලපත්‍රය
2. අධ්‍යාපන සහතික
3. රැකියා අත්දැකීම් ලිපි
4. විදේශ ගමන් බලපත්‍ර ප්‍රමාණයේ ඡායාරූප (පිටපත් 2ක්)

⚠️ ලියාපදිංචිය සඳහා මිනිත්තු 15කට පෙර පැමිණෙන්න.

නැවත කාලසටහනට ගැනීමට අවශ්‍ය නම්, කරුණාකර මෙම පණිවිඩයට පිළිතුරු දීමෙන් අප හා සම්බන්ධ වන්න.

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'வாழ்த்துக்கள்! முன்-திரையிடல் அழைப்பு - {job_title}',
            message: `🎉 அன்புள்ள {name},

வாழ்த்துக்கள்! {job_title} பதவிக்கு நீங்கள் சான்றளிக்கப்பட்டுள்ளீர்கள், முன்-திரையிடலுக்கு அழைக்கப்படுகிறீர்கள்!

📅 முன்-திரையிடல் விவரங்கள்:
📆 தேதி & நேரம்: {prescreening_datetime}
📍 இடம்: {prescreening_location}

📋 பின்வருவனவற்றை கொண்டு வரவும்:
1. அசல் அடையாள அட்டை / கடவுச்சீட்டு
2. கல்வி சான்றிதழ்கள்
3. பணி அனுபவ கடிதங்கள்
4. பாஸ்போர்ட் அளவு புகைப்படங்கள் (2 பிரதிகள்)

⚠️ பதிவுக்காக 15 நிமிடங்கள் முன்னதாக வரவும்.

மறுதிட்டமிட வேண்டுமென்றால், இந்த செய்திக்கு பதிலளித்து எங்களை தொடர்பு கொள்ளவும்.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    interview_scheduled: {
        en: {
            subject: 'Interview Scheduled - {job_title}',
            template_name: 'interview_scheduled_en',
            message: `📅 Dear {name},

Your interview has been scheduled!

📍 Position: {job_title}
📆 Date & Time: {interview_datetime}
📍 Location: {interview_location}{notes_block}

Please arrive 15 minutes early and bring:
- Original ID/Passport
- Educational certificates
- Work experience letters

If you need to reschedule, please contact us immediately.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'සම්මුඛ පරීක්ෂණය නියමිතයි - {job_title}',
            template_name: 'interview_scheduled_si',
            message: `📅 ආදරණීය {name},

ඔබේ සම්මුඛ පරීක්ෂණය කාලසටහනට ගෙන ඇත!

📍 තනතුර: {job_title}
📆 දිනය සහ වේලාව: {interview_datetime}
📍 ස්ථානය: {interview_location}{notes_block}

කරුණාකර මිනිත්තු 15කට පෙර පැමිණ රැගෙන එන්න:
- මුල් හැඳුනුම්පත / විදේශ ගමන් බලපත්‍රය
- අධ්‍යාපන සහතික
- රැකියා අත්දැකීම් ලිපි

නැවත කාලසටහනට ගැනීමට අවශ්‍ය නම් ඉක්මනින් අප හා සම්බන්ධ වන්න.

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'நேர்காணல் திட்டமிடப்பட்டது - {job_title}',
            template_name: 'interview_scheduled_ta',
            message: `📅 அன்புள்ள {name},

உங்கள் நேர்காணல் திட்டமிடப்பட்டுள்ளது!

📍 பதவி: {job_title}
📆 தேதி & நேரம்: {interview_datetime}
📍 இடம்: {interview_location}{notes_block}

15 நிமிடங்கள் முன்னதாக வந்து பின்வருவனவற்றை கொண்டு வரவும்:
- அசல் அடையாள அட்டை / கடவுச்சீட்டு
- கல்வி சான்றிதழ்கள்
- பணி அனுபவ கடிதங்கள்

மறுதிட்டமிட வேண்டுமென்றால் உடனே எங்களை தொடர்பு கொள்ளவும்.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    interview_reminder: {
        en: {
            subject: 'Reminder: Interview for {job_title}',
            template_name: 'interview_reminder_en',
            message: `⏰ Dear {name},

A friendly reminder about your upcoming interview:

📍 Position: {job_title}
📆 Date & Time: {interview_datetime}
📍 Location: {interview_location}

Please be prepared, arrive 15 minutes early, and bring your original documents.

If you need to reschedule, just reply to this message.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'මතක් කිරීම: {job_title} සම්මුඛ පරීක්ෂණය',
            template_name: 'interview_reminder_si',
            message: `⏰ ආදරණීය {name},

ඔබේ ඉදිරි සම්මුඛ පරීක්ෂණය පිළිබඳ මතක් කිරීමක්:

📍 තනතුර: {job_title}
📆 දිනය සහ වේලාව: {interview_datetime}
📍 ස්ථානය: {interview_location}

කරුණාකර සූදානම්ව, මිනිත්තු 15කට පෙර පැමිණ, මුල් ලේඛන රැගෙන එන්න.

නැවත කාලසටහනට ගැනීමට අවශ්‍ය නම් මෙම පණිවිඩයට පිළිතුරු දෙන්න.

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'நினைவூட்டல்: {job_title} நேர்காணல்',
            template_name: 'interview_reminder_ta',
            message: `⏰ அன்புள்ள {name},

உங்கள் வரவிருக்கும் நேர்காணல் குறித்த நினைவூட்டல்:

📍 பதவி: {job_title}
📆 தேதி & நேரம்: {interview_datetime}
📍 இடம்: {interview_location}

தயவுசெய்து தயாராக இருந்து, 15 நிமிடங்கள் முன்னதாக வந்து, அசல் ஆவணங்களைக் கொண்டு வரவும்.

மறுதிட்டமிட வேண்டுமென்றால், இந்த செய்திக்கு பதிலளிக்கவும்.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    interview_day_reminder: {
        en: {
            subject: 'Today: Interview for {job_title}',
            template_name: 'interview_dayof_en',
            message: `📅 Dear {name},

Your interview is TODAY! 🎯

📍 Position: {job_title}
🕒 Time: {interview_datetime}
📍 Location: {interview_location}

Please leave in good time, arrive 15 minutes early, and bring your original ID/passport and certificates. Best of luck! 🍀

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'අද: {job_title} සම්මුඛ පරීක්ෂණය',
            template_name: 'interview_dayof_si',
            message: `📅 ආදරණීය {name},

ඔබේ සම්මුඛ පරීක්ෂණය *අද* දිනයි! 🎯

📍 තනතුර: {job_title}
🕒 වේලාව: {interview_datetime}
📍 ස්ථානය: {interview_location}

කරුණාකර කල්තියා පිටත්ව, මිනිත්තු 15කට පෙර පැමිණ, මුල් හැඳුනුම්පත/විදේශ ගමන් බලපත්‍රය සහ සහතික රැගෙන එන්න. සුභ පැතුම්! 🍀

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'இன்று: {job_title} நேர்காணல்',
            template_name: 'interview_dayof_ta',
            message: `📅 அன்புள்ள {name},

உங்கள் நேர்காணல் *இன்று*! 🎯

📍 பதவி: {job_title}
🕒 நேரம்: {interview_datetime}
📍 இடம்: {interview_location}

தயவுசெய்து சரியான நேரத்தில் புறப்பட்டு, 15 நிமிடங்கள் முன்னதாக வந்து, அசல் அடையாள அட்டை/கடவுச்சீட்டு மற்றும் சான்றிதழ்களைக் கொண்டு வரவும். வாழ்த்துக்கள்! 🍀

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    interview_rescheduled: {
        en: {
            subject: 'Interview Rescheduled - {job_title}',
            template_name: 'interview_rescheduled_en',
            message: `🔄 Dear {name},

Your interview for *{job_title}* has been *rescheduled*.

📆 New date & time: {interview_datetime}
📍 Location: {interview_location}

Please make a note of the new time. We look forward to seeing you!

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'සම්මුඛ පරීක්ෂණය නැවත නියම කළා - {job_title}',
            template_name: 'interview_rescheduled_si',
            message: `🔄 ආදරණීය {name},

*{job_title}* සඳහා ඔබේ සම්මුඛ පරීක්ෂණය *නැවත නියම* කර ඇත.

📆 නව දිනය සහ වේලාව: {interview_datetime}
📍 ස්ථානය: {interview_location}

කරුණාකර නව වේලාව සටහන් කරගන්න. ඔබව හමුවීමට බලාපොරොත්තු වෙනවා!

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'நேர்காணல் மறுதிட்டமிடப்பட்டது - {job_title}',
            template_name: 'interview_rescheduled_ta',
            message: `🔄 அன்புள்ள {name},

*{job_title}* பதவிக்கான உங்கள் நேர்காணல் *மறுதிட்டமிடப்பட்டுள்ளது*.

📆 புதிய தேதி & நேரம்: {interview_datetime}
📍 இடம்: {interview_location}

தயவுசெய்து புதிய நேரத்தைக் குறித்துக்கொள்ளுங்கள். உங்களைச் சந்திக்க ஆவலுடன் இருக்கிறோம்!

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    interview_cancelled: {
        en: {
            subject: 'Interview Cancelled - {job_title}',
            template_name: 'interview_cancelled_en',
            message: `Dear {name},

Unfortunately, your interview for *{job_title}* has been *cancelled*. Our team will be in touch about the next steps.

We apologise for any inconvenience.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'සම්මුඛ පරීක්ෂණය අවලංගුයි - {job_title}',
            template_name: 'interview_cancelled_si',
            message: `ආදරණීය {name},

අවාසනාවන්ත ලෙස, *{job_title}* සඳහා ඔබේ සම්මුඛ පරීක්ෂණය *අවලංගු* කර ඇත. ඊළඟ පියවර ගැන අපේ කණ්ඩායම සම්බන්ධ වෙයි.

ඇතිවූ අපහසුතාවයට සමාව අයදිමු.

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'நேர்காணல் ரத்து - {job_title}',
            template_name: 'interview_cancelled_ta',
            message: `அன்புள்ள {name},

துரதிர்ஷ்டவசமாக, *{job_title}* பதவிக்கான உங்கள் நேர்காணல் *ரத்து* செய்யப்பட்டுள்ளது. அடுத்த படிகள் குறித்து எங்கள் குழு தொடர்பு கொள்ளும்.

ஏற்பட்ட சிரமத்திற்கு வருந்துகிறோம்.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    selected: {
        en: {
            subject: '🎉 Job Offer - {job_title}',
            template_name: 'selected_en',
            message: `🎊 Dear {name},

CONGRATULATIONS! 🎉

We are thrilled to inform you that you have been SELECTED for the position of {job_title}!

Our team will contact you with the offer details and next steps for your deployment.

Please keep this confidential until further notice.

Welcome to the team!

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: '🎉 රැකියා දීමනාව - {job_title}',
            template_name: 'selected_si',
            message: `🎊 ආදරණීය {name},

සුභ පැතුම්! 🎉

{job_title} තනතුර සඳහා ඔබ තෝරාගෙන ඇති බව ප්‍රීතිමත්ව දන්වා සිටිමු!

දිරිදීමනා විස්තර සහ ඊළඟ පියවර සඳහා අපගේ කණ්ඩායම ඔබව සම්බන්ධ කර ගනු ඇත.

තවදුරටත් දැනුම් දෙන තෙක් කරුණාකර රහස්‍ය ලෙස තබා ගන්න.

කණ්ඩායමට සාදරයෙන් පිළිගනිමු!

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: '🎉 வேலை சலுகை - {job_title}',
            template_name: 'selected_ta',
            message: `🎊 அன்புள்ள {name},

வாழ்த்துக்கள்! 🎉

{job_title} பதவிக்கு நீங்கள் தேர்ந்தெடுக்கப்பட்டீர்கள் என்பதை மகிழ்ச்சியுடன் தெரிவிக்கிறோம்!

சலுகை விவரங்கள் மற்றும் அடுத்த படிகளுக்கு எங்கள் குழு உங்களை தொடர்பு கொள்ளும்.

மேலும் அறிவிக்கும் வரை இரகசியமாக வைத்திருக்கவும்.

குழுவில் உங்களை வரவேற்கிறோம்!

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    rejected: {
        en: {
            subject: 'Application Update - {job_title}',
            template_name: 'rejected_en',
            message: `Dear {name},

Thank you for your interest in the {job_title} position.

After careful consideration, we regret to inform you that we have decided to proceed with other candidates whose qualifications more closely match our current requirements.

However, we have added you to our talent pool for future opportunities that may be a better fit.

We wish you the best in your career journey.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'අයදුම්පත් යාවත්කාලීන - {job_title}',
            template_name: 'rejected_si',
            message: `ආදරණීය {name},

{job_title} තනතුරට ඔබේ උනන්දුවට ස්තුතිය.

සැලකිලිමත් ලෙස සලකා බැලීමෙන් පසු, අපගේ වර්තමාන අවශ්‍යතාවලට වඩා සමීපව ගැළපෙන සුදුසුකම් සහිත අනෙකුත් අපේක්ෂකයින් සමඟ ඉදිරියට යාමට අපි තීරණය කළ බව කනගාටුවෙන් දන්වා සිටිමු.

කෙසේ වෙතත්, අනාගත අවස්ථා සඳහා ඔබව අපගේ දක්ෂතා සංචිතයේ ලයිස්තුගත කර ඇත.

ඔබේ රැකියා ගමනේ සුභ පතනවා.

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'விண்ணப்ப நிலை - {job_title}',
            template_name: 'rejected_ta',
            message: `அன்புள்ள {name},

{job_title} பதவியில் உங்கள் ஆர்வத்திற்கு நன்றி.

கவனமான பரிசீலனைக்குப் பிறகு, எங்கள் தற்போதைய தேவைகளை இன்னும் நெருக்கமாக பூர்த்தி செய்யும் தகுதிகள் கொண்ட மற்ற வேட்பாளர்களுடன் தொடர முடிவு செய்துள்ளோம் என்பதை வருத்தத்துடன் தெரிவிக்கிறோம்.

தோதான எதிர்கால வாய்ப்புகளுக்காக உங்களை எங்கள் திறமை குழுவில் சேர்த்துள்ளோம்.

உங்கள் தொழில் பயணத்தில் வாழ்த்துக்கள்.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    general_pool: {
        en: {
            subject: 'Application Update - Dewan Recruitment',
            message: `Dear {name},

Thank you for your interest in working with Dewan Recruitment.

We have carefully reviewed your profile. Unfortunately, we do not have a position that matches your qualifications at this time.

However, we have added your profile to our talent pool. We will contact you as soon as a suitable opportunity becomes available.

Please keep your contact details up to date so we can reach you.

We wish you all the best!

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'අයදුම්පත් යාවත්කාලීන - Dewan Recruitment',
            message: `ආදරණීය {name},

Dewan Recruitment සමඟ සේවය කිරීමට ඔබේ උනන්දුවට ස්තුතිය.

අපි ඔබේ පැතිකඩ ප්‍රවේශමෙන් සමාලෝචනය කර ඇත. අවාසනාවකට, මේ වන විට ඔබේ සුදුසුකම්වලට ගැළපෙන තනතුරක් අප සතුව නොමැත.

කෙසේ වෙතත්, ඔබේ පැතිකඩ අපගේ දක්ෂතා එකතුවට එක් කර ඇත. සුදුසු අවස්ථාවක් ලැබුණු වහාම අපි ඔබව සම්බන්ධ කර ගනිමු.

අපට ඔබව සම්බන්ධ කර ගත හැකි වන පරිදි ඔබේ සම්බන්ධතා තොරතුරු යාවත්කාලීනව තබා ගන්න.

ඔබට සුභ පතනවා!

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'விண்ணப்ப புதுப்பிப்பு - Dewan Recruitment',
            message: `அன்புள்ள {name},

Dewan Recruitment நிறுவனத்தில் பணிபுரிய உங்கள் ஆர்வத்திற்கு நன்றி.

உங்கள் சுயவிவரத்தை நாங்கள் கவனமாக மதிப்பாய்வு செய்துள்ளோம். துரதிர்ஷ்டவசமாக, இந்த நேரத்தில் உங்கள் தகுதிகளுக்கு பொருந்தக்கூடிய பதவி எங்களிடம் இல்லை.

இருப்பினும், உங்கள் சுயவிவரத்தை எங்கள் திறமை குழுவில் சேர்த்துள்ளோம். பொருத்தமான வாய்ப்பு கிடைத்தவுடன் நாங்கள் உங்களை தொடர்பு கொள்வோம்.

நாங்கள் உங்களை தொடர்பு கொள்ள முடியும் வகையில் உங்கள் தொடர்பு விவரங்களை புதுப்பித்து வைக்கவும்.

உங்களுக்கு அனைத்து வாழ்த்துக்களும்!

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    },
    job_now_available: {
        en: {
            subject: 'Good news — a {job_title} role just opened!',
            template_name: 'job_now_available_en',
            message: `🎉 Hi {name},

Great news! You earlier asked us about a *{job_title}* role. We now have an opening that matches! 🙌

Would you like to apply? Just reply *YES* and we'll continue your application right away.

Best regards,
Dewan Recruitment Team`
        },
        si: {
            subject: 'සුබ ආරංචියක් — {job_title} පුරප්පාඩුවක්!',
            template_name: 'job_now_available_si',
            message: `🎉 ආයුබෝවන් {name},

සුබ ආරංචියක්! ඔබ කලින් *{job_title}* රැකියාවක් ගැන විමසුවා. දැන් ඒකට ගැලපෙන පුරප්පාඩුවක් තිබෙනවා! 🙌

අයදුම් කරන්න කැමතිද? *YES* කියලා reply කරන්න, අපි ඔබේ අයදුම්පත ඉදිරියට ගෙනියමු.

සුබ පැතුම්,
Dewan Recruitment Team`
        },
        ta: {
            subject: 'நல்ல செய்தி — {job_title} வேலை!',
            template_name: 'job_now_available_ta',
            message: `🎉 வணக்கம் {name},

நல்ல செய்தி! நீங்கள் முன்பு *{job_title}* வேலை பற்றி கேட்டீர்கள். இப்போது அதற்கு பொருந்தும் வேலை ஒன்று உள்ளது! 🙌

விண்ணப்பிக்க விரும்புகிறீர்களா? *YES* என்று பதிலளியுங்கள், உங்கள் விண்ணப்பத்தை தொடர்வோம்.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
    }
};

/**
 * Build WhatsApp template components for a given notification type.
 * Returns an array of component objects suitable for the Cloud API.
 * Add more cases as Meta-approved templates are created.
 */
function buildTemplateComponents(type, variables) {
    // All templates use a simple body with named parameters passed as positional {{1}}, {{2}}, etc.
    // Adjust to match your actual approved template parameter order.
    const paramMap = {
        application_complete: [variables.name, variables.job_title],
        job_assignment: [variables.name, variables.job_title],
        certified: [variables.name, variables.job_title],
        prescreening_certified: [variables.name, variables.job_title, variables.prescreening_datetime, variables.prescreening_location],
        interview_scheduled: [variables.name, variables.job_title, variables.interview_datetime, variables.interview_location],
        selected: [variables.name, variables.job_title],
        rejected: [variables.name, variables.job_title],
        general_pool: [variables.name],
        transfer: [variables.name, variables.new_job_title, variables.old_job_title]
    };
    const params = paramMap[type] || [];
    return [{
        type: 'body',
        parameters: params.map(v => ({ type: 'text', text: String(v || '') }))
    }];
}

/**
 * Send notification to candidate
 * @param {Object} options - Notification options
 * @param {string} options.candidateId - Candidate UUID
 * @param {string} options.type - Notification type (certified, prescreening_certified, interview_scheduled, selected, rejected, general_pool)
 * @param {Object} options.data - Additional data for template variables
 * @param {string[]} options.channels - Channels to use ['whatsapp', 'email', 'sms']
 */
async function sendNotification(options) {
    const { candidateId, type, data = {}, channels = ['whatsapp'] } = options;
    const results = {
        success: [],
        failed: []
    };

    try {
        // Fetch candidate details
        const candidateResult = await query(
            adaptQuery('SELECT * FROM candidates WHERE id = $1'),
            [candidateId]
        );

        if (candidateResult.rows.length === 0) {
            throw new Error('Candidate not found');
        }

        const candidate = candidateResult.rows[0];
        const language = candidate.preferred_language || 'en';

        // Get template
        const templates = NOTIFICATION_TEMPLATES[type];
        if (!templates) {
            throw new Error(`Unknown notification type: ${type}`);
        }

        const template = templates[language] || templates['en']; // Fallback to English

        // Replace template variables
        const variables = {
            name: candidate.name,
            phone: candidate.phone,
            email: candidate.email,
            ...data
        };

        const message = replaceTemplateVariables(template.message, variables);
        const subject = replaceTemplateVariables(template.subject, variables);

        // Send via each channel
        for (const channel of channels) {
            try {
                switch (channel) {
                    case 'whatsapp':
                        if (candidate.phone) {
                            // Route through the chatbot so the candidate sees this in the same
                            // WhatsApp thread as their bot conversation. The chatbot owns the
                            // Meta credentials and the language-aware template rendering.
                            const pushResult = await chatbotNotifier.pushCandidateStatus({
                                phone: candidate.phone,
                                name: candidate.name,
                                type,
                                jobTitle: data.job_title,
                                interviewDate: data.interview_datetime,
                                interviewLocation: data.interview_location,
                                interviewNotes: data.interview_notes,
                                // Opt-in translation: off by default to save API cost
                                // (the note is sent exactly as typed).
                                translateNotes: data.translate_notes === true,
                                alternativeJobs: data.alternative_jobs,
                                prescreeningDatetime: data.prescreening_datetime,
                                prescreeningLocation: data.prescreening_location,
                                certificationNotes: data.certification_notes,
                                oldJobTitle: data.old_job_title,
                                newJobTitle: data.new_job_title,
                            });

                            if (pushResult.ok) {
                                results.success.push({
                                    channel: 'whatsapp',
                                    phone: candidate.phone,
                                    messageId: pushResult.messageId,
                                });
                                await logCommunication(candidateId, 'whatsapp', 'outbound', message, type, {
                                    deliveryStatus: 'sent',
                                    whatsappMessageId: pushResult.messageId,
                                });
                            } else {
                                results.failed.push({
                                    channel: 'whatsapp',
                                    error: pushResult.error,
                                    // Coarse classification (no_whatsapp / out_of_window /
                                    // token_expired / rate_limited / other) so callers can
                                    // flag truly-unreachable candidates vs. transient failures.
                                    reason: pushResult.reason || null,
                                });
                                await logCommunication(candidateId, 'whatsapp', 'outbound', message, type, {
                                    deliveryStatus: 'failed',
                                    error: pushResult.error,
                                    reason: pushResult.reason || null,
                                });
                            }
                        } else {
                            results.failed.push({ channel: 'whatsapp', error: 'candidate has no phone number' });
                        }
                        break;

                    case 'sms':
                        if (candidate.phone) {
                            const smsResult = await sms.sendSMS(candidate.phone, message.substring(0, 480));
                            if (smsResult.simulated) {
                                results.failed.push({
                                    channel: 'sms',
                                    error: 'SMS provider not configured (NOTIFYLK credentials missing)',
                                });
                                await logCommunication(candidateId, 'sms', 'outbound', message.substring(0, 480), type, {
                                    deliveryStatus: 'simulated',
                                });
                            } else {
                                results.success.push({ channel: 'sms', phone: candidate.phone });
                                await logCommunication(candidateId, 'sms', 'outbound', message.substring(0, 480), type, {
                                    deliveryStatus: 'sent',
                                });
                            }
                        } else {
                            results.failed.push({ channel: 'sms', error: 'candidate has no phone number' });
                        }
                        break;

                    case 'email':
                        if (candidate.email) {
                            const emailResult = await sendEmail(candidate.email, subject, message, candidate.name);
                            if (emailResult.ok) {
                                results.success.push({ channel: 'email', email: candidate.email, provider: emailResult.provider });
                                await logCommunication(candidateId, 'email', 'outbound', message, type, {
                                    deliveryStatus: 'sent',
                                    provider: emailResult.provider,
                                });
                            } else {
                                results.failed.push({ channel: 'email', error: emailResult.error });
                                await logCommunication(candidateId, 'email', 'outbound', message, type, {
                                    deliveryStatus: 'failed',
                                    error: emailResult.error,
                                });
                            }
                        } else {
                            results.failed.push({ channel: 'email', error: 'candidate has no email address' });
                        }
                        break;
                }
            } catch (channelError) {
                logger.error(`Failed to send ${channel} notification to ${candidateId}:`, channelError);
                results.failed.push({
                    channel,
                    error: channelError.message,
                    simulated: !process.env.WHATSAPP_ACCESS_TOKEN
                });
            }
        }

        // Add to notification queue for retry if there are failures
        if (results.failed.length > 0) {
            await queueNotification(candidateId, type, channels.filter(c => results.failed.some(f => f.channel === c)), data);
        }

        return results;
    } catch (error) {
        logger.error('Notification service error:', error);
        throw error;
    }
}

/**
 * Send "application complete" notification — fired when a candidate moves
 * New → Screening (details + CV verified). Confirms receipt + screening stage.
 */
async function sendApplicationCompleteNotification(candidateId, jobTitle, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'application_complete',
        data: { job_title: jobTitle },
        channels,
    });
}

/**
 * Send "you've been selected for {job}" notification — fired when a candidate
 * is (auto-)assigned to a job, before certification.
 */
async function sendJobAssignmentNotification(candidateId, jobTitle, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'job_assignment',
        data: { job_title: jobTitle },
        channels,
    });
}

/**
 * Send certification notification (basic - no pre-screening details)
 */
async function sendCertificationNotification(candidateId, jobTitle, certificationNotes = '', channels = ['whatsapp'], translateNotes = false) {
    return sendNotification({
        candidateId,
        type: 'certified',
        data: {
            job_title: jobTitle,
            certification_notes: certificationNotes,
            // Opt-in translation of the cert note (off by default to save cost).
            translate_notes: translateNotes === true,
        },
        channels
    });
}

// ── Interview date/time formatting ────────────────────────────────────────────
// Interview datetimes are a *literal Asia/Colombo wall-clock* — the exact time the
// recruiter typed in the schedule panel — NOT a UTC instant. They must be rendered
// by their literal calendar components and never run through a timezone conversion.
// The old `new Date(x).toLocaleString('en-US', …)` shifted the time by the server↔
// Sri Lanka offset (e.g. 2:30 PM → 9:00 AM on a UTC Cloud Run host), so candidates
// received the wrong interview time. This reads Y/M/D/H/M straight off the value
// (naive string, ISO string, or pg Date) and formats those exact numbers, so
// "what you scheduled" is always "what the candidate receives", regardless of the
// host timezone.
function formatInterviewWallClock(value) {
    if (value === null || value === undefined || value === '') return '';
    let d;
    if (value instanceof Date) {
        // pg returns tz-naive TIMESTAMP columns as a Date whose UTC fields hold the
        // stored wall-clock when the process runs in UTC (Cloud Run default).
        d = value;
    } else {
        const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
        if (m) {
            // Place the literal components in the UTC slot so formatting in UTC echoes
            // them back unchanged — no offset math, no DST surprises.
            d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
        } else {
            d = new Date(value); // last-resort parse for unexpected formats
        }
    }
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'UTC',
    });
}

/**
 * Send interview reminder (bell icon / scheduled reminder job).
 * Same job/datetime fields as sendInterviewNotification but uses the
 * reminder template so the candidate sees this as a friendly nudge,
 * not a re-issue of the original schedule message.
 */
async function sendInterviewReminderNotification(candidateId, jobTitle, interviewDatetime, interviewLocation, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'interview_reminder',
        data: {
            job_title: jobTitle,
            interview_datetime: formatInterviewWallClock(interviewDatetime),
            interview_location: interviewLocation
        },
        channels
    });
}

/**
 * Send the morning-of interview reminder — a distinct, more urgent nudge sent
 * on the interview date itself (separate from the daily final-3-days reminders).
 */
async function sendInterviewDayOfNotification(candidateId, jobTitle, interviewDatetime, interviewLocation, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'interview_day_reminder',
        data: {
            job_title: jobTitle,
            interview_datetime: formatInterviewWallClock(interviewDatetime),
            interview_location: interviewLocation
        },
        channels
    });
}

/**
 * Send pre-screening certification notification (with date/time/location)
 */
/**
 * Send "you passed pre-screening" notification — fired when the recruiter
 * moves an application from certified → pre_screened. The interview
 * scheduled message is a separate event (sent when interview is created).
 */
async function sendPreScreenedPassedNotification(candidateId, jobTitle, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'pre_screened_passed',
        data: { job_title: jobTitle },
        channels,
    });
}

async function sendPreScreeningNotification(candidateId, jobTitle, prescreeningDatetime, prescreeningLocation, channels = ['whatsapp']) {
    const formattedDateTime = formatInterviewWallClock(prescreeningDatetime);

    return sendNotification({
        candidateId,
        type: 'prescreening_certified',
        data: {
            job_title: jobTitle,
            prescreening_datetime: formattedDateTime,
            prescreening_location: prescreeningLocation
        },
        channels
    });
}

/**
 * Send interview scheduled notification
 */
async function sendInterviewNotification(candidateId, jobTitle, interviewDatetime, interviewLocation, channels = ['whatsapp'], description = null, translateNotes = false) {
    // Pre-format the optional extra-details note here so the template stays a
    // single placeholder — empty string collapses to nothing (B016).
    const notesBlock = description ? `\n📝 Additional details: ${description}` : '';
    return sendNotification({
        candidateId,
        type: 'interview_scheduled',
        data: {
            job_title: jobTitle,
            interview_datetime: formatInterviewWallClock(interviewDatetime),
            interview_location: interviewLocation,
            // notes_block: pre-formatted, used by the email/SMS templates here.
            notes_block: notesBlock,
            // interview_notes: the raw description, forwarded to the chatbot so it
            // can be used as the message body. Translated into the candidate's
            // language only when translate_notes is true (off by default = no LLM
            // call = no API cost; the note is sent exactly as typed).
            interview_notes: description || null,
            translate_notes: translateNotes === true,
        },
        channels
    });
}

/**
 * Send selection notification
 */
async function sendSelectionNotification(candidateId, jobTitle, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'selected',
        data: { job_title: jobTitle },
        channels
    });
}

/**
 * Send rejection notification
 */
async function sendRejectionNotification(candidateId, jobTitle, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'rejected',
        data: { job_title: jobTitle },
        channels
    });
}

/**
 * Send general pool notification (candidate not selected for any current position)
 */
async function sendGeneralPoolNotification(candidateId, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'general_pool',
        data: {},
        channels
    });
}

/**
 * Log communication to database.
 * extras: { deliveryStatus, whatsappMessageId, provider, error }
 */
async function logCommunication(candidateId, channel, direction, content, messageType, extras = {}) {
    try {
        const metadata = {
            notification_type: messageType,
            delivery_status: extras.deliveryStatus || 'sent',
        };
        if (extras.provider) metadata.provider = extras.provider;
        if (extras.error) metadata.error = extras.error;
        if (extras.reason) metadata.reason = extras.reason;

        // Set sent_at explicitly (NOW()) rather than relying on a column default —
        // the Conversations list/counts gate on `lm.sent_at IS NOT NULL`, so a
        // logged outbound (e.g. the welcome to an agent-added candidate) must carry
        // a timestamp or the candidate would never surface in the Messages list.
        await query(
            adaptQuery('INSERT INTO communications (candidate_id, channel, direction, message_type, content, metadata, whatsapp_message_id, sent_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())'),
            [candidateId, channel, direction, 'text', content, JSON.stringify(metadata), extras.whatsappMessageId || null]
        );
    } catch (error) {
        logger.error('Failed to log communication:', error);
    }
}

/**
 * Send an email via Gmail (if OAuth connected) or SMTP (nodemailer fallback).
 * Returns { ok, provider?, error? } — never throws.
 */
async function sendEmail(toEmail, subject, body, recipientName) {
    // Try Gmail OAuth first
    try {
        const gmailService = require('./gmail');
        if (typeof gmailService.isConnected === 'function' && await gmailService.isConnected()) {
            // Existing gmail.sendAutoReply signature is (to, subject, name).
            // Prefer a richer sendEmail signature if the service ever exposes one.
            if (typeof gmailService.sendEmail === 'function') {
                await gmailService.sendEmail(toEmail, subject, body);
            } else {
                await gmailService.sendAutoReply(toEmail, subject, recipientName);
            }
            return { ok: true, provider: 'gmail' };
        }
    } catch (gmailErr) {
        logger.warn(`Gmail send failed, falling back to SMTP: ${gmailErr.message}`);
    }

    // SMTP fallback via nodemailer
    const smtpHost = process.env.SMTP_HOST;
    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const smtpFrom = process.env.SMTP_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass) {
        return { ok: false, error: 'No email provider configured (Gmail not connected and SMTP env vars missing)' };
    }

    try {
        const nodemailer = require('nodemailer');
        const transport = nodemailer.createTransport({
            host: smtpHost,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            auth: { user: smtpUser, pass: smtpPass },
        });
        await transport.sendMail({
            from: smtpFrom,
            to: toEmail,
            subject,
            text: body,
        });
        return { ok: true, provider: 'smtp' };
    } catch (smtpErr) {
        logger.error(`SMTP send failed for ${toEmail}: ${smtpErr.message}`);
        return { ok: false, error: `SMTP error: ${smtpErr.message}` };
    }
}

/**
 * Queue notification for retry
 */
async function queueNotification(candidateId, template, channels, variables) {
    try {
        await query(
            adaptQuery("INSERT INTO notification_queue (candidate_id, channel, template, variables, status) VALUES ($1, $2, $3, $4, 'pending')"),
            [candidateId, channels.join(','), template, JSON.stringify(variables)]
        );
    } catch (error) {
        logger.error('Failed to queue notification:', error);
    }
}

/**
 * Send transfer notification (application moved to a new job)
 */
async function sendTransferNotification(candidateId, newJobTitle, oldJobTitle, channels = ['whatsapp']) {
    // Add transfer template inline if not defined globally
    if (!NOTIFICATION_TEMPLATES.transfer) {
        NOTIFICATION_TEMPLATES.transfer = {
            en: {
                subject: 'Your Application has been Transferred - {new_job_title}',
                template_name: 'transfer_en',
                message: `Dear {name},

We wanted to let you know that your application has been transferred from {old_job_title} to {new_job_title}.

Your profile and documents have been moved automatically. Our team will be in touch shortly with next steps.

If you have any questions, please reply to this message.

Best regards,
Dewan Recruitment Team`
            },
            si: {
                subject: 'ඔබේ අයදුම්පත මාරු කර ඇත - {new_job_title}',
                template_name: 'transfer_si',
                message: `ආදරණීය {name},

ඔබේ අයදුම්පත {old_job_title} සිට {new_job_title} වෙත මාරු කර ඇති බව දැනුම් දීමට කැමතිව සිටිමු.

ඔබේ පැතිකඩ සහ ලේඛන ස්වයංක්‍රීයව ගෙනයා ඇත. ඊළඟ පියවරු සමඟ අපගේ කණ්ඩායම ඉක්මනින් ඔබව සම්බන්ධ කරනු ඇත.

ප්‍රශ්න ඇත්නම් මෙම පණිවිඩයට පිළිතුරු දෙන්න.

සුබ පැතුම්,
Dewan Recruitment Team`
            },
            ta: {
                subject: 'உங்கள் விண்ணப்பம் மாற்றப்பட்டது - {new_job_title}',
                template_name: 'transfer_ta',
                message: `அன்புள்ள {name},

உங்கள் விண்ணப்பம் {old_job_title} இலிருந்து {new_job_title} க்கு மாற்றப்பட்டுள்ளது என்பதை தெரிவிக்க விரும்புகிறோம்.

உங்கள் சுயவிவரமும் ஆவணங்களும் தானாகவே நகர்த்தப்பட்டன. அடுத்த படிகளுக்கு எங்கள் குழு விரைவில் தொடர்பு கொள்ளும்.

கேள்விகள் இருந்தால் இந்த செய்திக்கு பதிலளிக்கவும்.

வாழ்த்துக்கள்,
Dewan Recruitment Team`
            }
        };
    }

    return sendNotification({
        candidateId,
        type: 'transfer',
        data: {
            new_job_title: newJobTitle,
            old_job_title: oldJobTitle
        },
        channels
    });
}

/**
 * Replace template variables
 */
function replaceTemplateVariables(template, variables) {
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
        result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
    }
    return result;
}

/**
 * Process notification queue (called by a scheduled job)
 */
async function processNotificationQueue() {
    try {
        const pendingResult = await query(
            adaptQuery("SELECT * FROM notification_queue WHERE status = 'pending' AND retry_count < max_retries AND scheduled_for <= NOW() ORDER BY created_at ASC LIMIT 10")
        );

        for (const notification of pendingResult.rows) {
            try {
                const channels = notification.channel.split(',');
                const variables = notification.variables;

                await sendNotification({
                    candidateId: notification.candidate_id,
                    type: notification.template,
                    data: variables,
                    channels
                });

                await query(
                    adaptQuery("UPDATE notification_queue SET status = 'sent', sent_at = NOW() WHERE id = $1"),
                    [notification.id]
                );
            } catch (error) {
                await query(
                    adaptQuery('UPDATE notification_queue SET retry_count = retry_count + 1, error_message = $1 WHERE id = $2'),
                    [error.message, notification.id]
                );
            }
        }
    } catch (error) {
        logger.error('Failed to process notification queue:', error);
    }
}

/**
 * Send a "a {job} role just opened" re-engagement notification to a candidate
 * who earlier wanted a role we had no opening for (job re-engagement waitlist).
 */
async function sendJobAvailableNotification(candidateId, jobTitle, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'job_now_available',
        data: { job_title: jobTitle },
        channels,
    });
}

/**
 * Notify a candidate their interview was moved to a new date/time.
 */
async function sendInterviewRescheduledNotification(candidateId, jobTitle, interviewDatetime, interviewLocation, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'interview_rescheduled',
        data: {
            job_title: jobTitle,
            interview_datetime: formatInterviewWallClock(interviewDatetime),
            interview_location: interviewLocation,
        },
        channels,
    });
}

/**
 * Notify a candidate their interview was cancelled.
 */
async function sendInterviewCancelledNotification(candidateId, jobTitle, channels = ['whatsapp']) {
    return sendNotification({
        candidateId,
        type: 'interview_cancelled',
        data: { job_title: jobTitle },
        channels,
    });
}

module.exports = {
    sendNotification,
    sendApplicationCompleteNotification,
    sendJobAssignmentNotification,
    sendCertificationNotification,
    sendPreScreenedPassedNotification,
    sendPreScreeningNotification,
    sendInterviewNotification,
    sendInterviewReminderNotification,
    sendInterviewDayOfNotification,
    sendSelectionNotification,
    sendRejectionNotification,
    sendGeneralPoolNotification,
    sendTransferNotification,
    sendJobAvailableNotification,
    sendInterviewRescheduledNotification,
    sendInterviewCancelledNotification,
    processNotificationQueue,
    NOTIFICATION_TEMPLATES,
    // Exported for unit testing the wall-clock formatter (guards the interview-time
    // regression: the candidate must receive the exact time that was scheduled).
    formatInterviewWallClock,
};
