/**
 * quick-replies.js — canned agent replies for the Messages composer.
 * ==================================================================
 * A small set of localized answers to the questions agents field over and over
 * (salary, benefits, how to apply, asking for a CV, interview info). The
 * QuickReplyPicker shows the set for the candidate's language and hands the
 * rendered text back to the composer — nothing is auto-sent.
 *
 * Bodies use {name} / {job} / {phone} placeholders, substituted by
 * renderTemplate(). Languages mirror the rest of Messages: en / si / ta /
 * singlish / tanglish. singlish/tanglish fall back to en (handled by the
 * picker via templatesForLang) so we don't have to duplicate every string.
 */

// id is shared across languages so the same "row" stays stable regardless of
// which language set is shown; label is the short menu caption; body is the
// inserted text.
export const QUICK_REPLY_TEMPLATES = {
  en: [
    {
      id: 'salary',
      label: 'Salary',
      body: 'Hi {name}, thanks for your interest in {job}. The salary depends on your experience and the final interview — we\'ll share the exact package once your profile is reviewed. Is there anything else I can help with?',
    },
    {
      id: 'benefits',
      label: 'Benefits',
      body: 'Hi {name}, for the {job} role we typically offer food and accommodation, medical cover and annual leave as per the contract. I can send the full details once we move forward.',
    },
    {
      id: 'how_to_apply',
      label: 'How to apply',
      body: 'Hi {name}, to apply for {job} just reply here with your full name and send your CV as a PDF or photo. I\'ll take it from there and guide you through the next steps.',
    },
    {
      id: 'ask_cv',
      label: 'Ask for CV',
      body: 'Hi {name}, could you please share your CV here? A PDF works best, but a clear photo of your CV is also fine. This helps us match you to {job} faster.',
    },
    {
      id: 'interview_info',
      label: 'Interview info',
      body: 'Hi {name}, great news — we\'d like to move forward with your application for {job}. I\'ll confirm the interview date and time shortly. Please keep your documents ready.',
    },
  ],

  si: [
    {
      id: 'salary',
      label: 'වැටුප',
      body: 'ආයුබෝවන් {name}, {job} සඳහා ඔබගේ උනන්දුවට ස්තූතියි. වැටුප ඔබගේ පළපුරුද්ද සහ අවසන් සම්මුඛ පරීක්ෂණය මත රඳා පවතී — ඔබගේ විස්තර සමාලෝචනය කළ පසු නිශ්චිත වැටුප බෙදා ගනිමු. තවත් යමක් අවශ්‍යද?',
    },
    {
      id: 'benefits',
      label: 'ප්‍රතිලාභ',
      body: 'ආයුබෝවන් {name}, {job} සඳහා සාමාන්‍යයෙන් ආහාර හා නවාතැන්, වෛද්‍ය පහසුකම් සහ වාර්ෂික නිවාඩු ගිවිසුමට අනුව ලබා දෙනවා. ඉදිරියට ගිය විට සම්පූර්ණ විස්තර එවන්නම්.',
    },
    {
      id: 'how_to_apply',
      label: 'අයදුම් කරන හැටි',
      body: '{name}, {job} සඳහා අයදුම් කරන්න ඔබගේ සම්පූර්ණ නම මෙතැනට එවා, ඔබගේ CV එක PDF හෝ ඡායාරූපයක් ලෙස එවන්න. ඊළඟ පියවර මම ඔබට කියා දෙන්නම්.',
    },
    {
      id: 'ask_cv',
      label: 'CV එක ඉල්ලන්න',
      body: 'ආයුබෝවන් {name}, කරුණාකර ඔබගේ CV එක මෙතැනට එවන්න පුළුවන්ද? PDF එකක් හොඳම, නැත්නම් පැහැදිලි ඡායාරූපයක් වුණත් හරි. මෙය {job} සඳහා ඔබව ඉක්මනින් ගැලපීමට උදව් වෙනවා.',
    },
    {
      id: 'interview_info',
      label: 'සම්මුඛ පරීක්ෂණ විස්තර',
      body: 'ආයුබෝවන් {name}, ශුභ ආරංචියක් — {job} සඳහා ඔබගේ අයදුම්පත ඉදිරියට ගෙන යාමට අපි කැමතියි. සම්මුඛ පරීක්ෂණයේ දිනය සහ වේලාව ඉක්මනින් තහවුරු කරන්නම්. කරුණාකර ඔබගේ ලේඛන සූදානම්ව තබා ගන්න.',
    },
  ],

  ta: [
    {
      id: 'salary',
      label: 'சம்பளம்',
      body: 'வணக்கம் {name}, {job} பதவியில் உங்கள் ஆர்வத்திற்கு நன்றி. சம்பளம் உங்கள் அனுபவம் மற்றும் இறுதி நேர்காணலைப் பொறுத்தது — உங்கள் விவரங்கள் பரிசீலிக்கப்பட்ட பிறகு சரியான தொகையைப் பகிர்வோம். வேறு ஏதேனும் உதவி வேண்டுமா?',
    },
    {
      id: 'benefits',
      label: 'சலுகைகள்',
      body: 'வணக்கம் {name}, {job} பதவிக்கு பொதுவாக உணவு மற்றும் தங்குமிடம், மருத்துவ வசதி மற்றும் ஆண்டு விடுப்பு ஒப்பந்தத்தின்படி வழங்கப்படும். நாம் முன்னேறும்போது முழு விவரங்களையும் அனுப்புகிறேன்.',
    },
    {
      id: 'how_to_apply',
      label: 'விண்ணப்பிக்கும் முறை',
      body: 'வணக்கம் {name}, {job} பதவிக்கு விண்ணப்பிக்க உங்கள் முழுப் பெயரை இங்கே பதிலளித்து, உங்கள் CV ஐ PDF அல்லது புகைப்படமாக அனுப்பவும். அடுத்த படிகளை நான் வழிநடத்துகிறேன்.',
    },
    {
      id: 'ask_cv',
      label: 'CV கேட்க',
      body: 'வணக்கம் {name}, தயவுசெய்து உங்கள் CV ஐ இங்கே பகிர முடியுமா? PDF சிறந்தது, ஆனால் தெளிவான புகைப்படமும் சரி. இது {job} பதவிக்கு உங்களை விரைவாகப் பொருத்த உதவும்.',
    },
    {
      id: 'interview_info',
      label: 'நேர்காணல் தகவல்',
      body: 'வணக்கம் {name}, நல்ல செய்தி — {job} பதவிக்கான உங்கள் விண்ணப்பத்தை முன்னெடுக்க விரும்புகிறோம். நேர்காணல் தேதி மற்றும் நேரத்தை விரைவில் உறுதிப்படுத்துகிறேன். உங்கள் ஆவணங்களைத் தயாராக வைத்திருங்கள்.',
    },
  ],
}

/**
 * templatesForLang(lang) — the template list for a language, with singlish /
 * tanglish (and anything unknown) falling back to English. Kept here so both
 * the picker and any future caller share one fallback rule.
 */
export function templatesForLang(lang) {
  return QUICK_REPLY_TEMPLATES[lang] || QUICK_REPLY_TEMPLATES.en
}

/**
 * renderTemplate(body, vars) — substitute {name} / {job} / {phone} in a
 * template body. Unknown placeholders are left blank rather than throwing, and
 * a missing/blank var also renders as empty. Safe to call with a partial vars
 * object or none at all.
 */
export function renderTemplate(body, vars = {}) {
  if (!body) return ''
  return String(body).replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key]
    return v == null ? '' : String(v)
  })
}
