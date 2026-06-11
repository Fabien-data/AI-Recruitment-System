# Meta WhatsApp Templates — submission guide & template pack

This is the complete set of WhatsApp message templates to create and submit for
approval in **Meta Business Manager**. They are what the chatbot code will send
when a candidate is **outside WhatsApp's 24-hour customer-service window** (the
normal case for certifications/interviews that happen days after the candidate
last messaged). Until a template is approved and its env var is set, the system
falls back to free-form (which Meta drops out-of-window) — so getting these
approved is what makes out-of-window delivery actually work.

> **Who does this:** only an admin of the Dewan Meta Business account can submit
> templates. Claude cannot do this step. Follow the guide below, then tell us the
> approved template names so we set the env vars and redeploy the chatbot.

---

## How the code uses these

- Each template is registered **once** under its `name`, with **three language
  variants**: English (`en`), Sinhala (`si`), Tamil (`ta`). The code picks the
  variant matching the candidate's language; unsupported languages fall back to
  English. **Use plain "English" (code `en`), NOT "English (US)" (`en_US`)** — a
  mismatch causes API error 132001 "template not found in language".
- Body parameters are positional: `{{1}}`, `{{2}}`, … The code fills them in the
  exact order listed per template. **Do not reorder or add parameters.**
- After approval, set the matching env var in the chatbot's `env.yaml` and
  redeploy (see the bottom of this file). Partial rollout is safe — set each var
  only once at least its `en` variant is approved.

| Template name | Env var | Body params (in order) |
|---|---|---|
| `dewan_welcome` | `TEMPLATE_WELCOME` | 1=first name |
| `dewan_status_update` | `TEMPLATE_STATUS_UPDATE` | 1=first name, 2=one-line summary |
| `dewan_interview_scheduled` | `TEMPLATE_INTERVIEW_SCHEDULED` | 1=first name, 2=job title, 3=date/time |
| `dewan_interview_reminder` | `TEMPLATE_INTERVIEW_REMINDER` | 1=first name, 2=job title, 3=date/time |
| `dewan_interview_day_reminder` | `TEMPLATE_INTERVIEW_DAY_REMINDER` | 1=first name, 2=job title, 3=date/time |
| `dewan_job_now_available` | `TEMPLATE_JOB_NOW_AVAILABLE` | 1=first name, 2=job title |
| `dewan_reengage` | `TEMPLATE_REENGAGE` | 1=first name |
| `dewan_followup_missing_info` | `FOLLOWUP_TEMPLATE_MISSING_INFO` | 1=first name, 2=missing field |

`dewan_status_update` is the **generic catch-all**: it covers certified,
prescreening, application-received, shortlisted, hired, general-pool,
rejected-with-alternatives, transferred, and interview reschedule/cancel — the
`{{2}}` summary line is rendered per status by the code. The full detailed
message is delivered automatically when the candidate replies.

---

## Step-by-step submission

1. Go to **business.facebook.com** → select the Dewan business → open **WhatsApp
   Manager** (also reachable via Meta Business Suite → All tools → WhatsApp
   Manager). Select the WABA that owns the chatbot's phone number.
2. Left nav → **Account tools → Message templates** → **Create template**.
3. Choose the **Category** (Utility or Marketing — see each template below),
   enter the exact **Name** (snake_case, as listed), and add **all three
   languages** (English, Sinhala, Tamil) before editing.
4. In each language tab: paste the **Body**, add the **Quick reply button** where
   noted (Buttons → Quick reply), then click **Add sample** and fill every
   `{{n}}` with the sample values given (Meta rejects submissions without
   samples).
5. **Submit.** Each language variant is reviewed independently; status shows in
   the Message templates list (Pending → Approved/Rejected). Approval is usually
   minutes to a few hours, occasionally up to 24–48h.
6. Send us the approved template names so we can set the env vars + redeploy.

### Rejection tips
- **Utility** templates must read as transactional updates about an existing
  application. Promotional language ("great news!", offers, urgency) can get a
  Utility template rejected or silently recategorized to Marketing. If a Utility
  template is rejected for tone, either soften the wording or resubmit it as
  Marketing — the code doesn't care about the category, only the name.
- Parameters can't be adjacent (`{{1}} {{2}}` needs literal text between them) and
  the body can't start or end with a parameter. All bodies below already comply.
- If a single language variant is rejected, fix and resubmit just that variant —
  approved variants stay usable. Get **English approved first** (the code falls
  back to English for any unsupported language).

---

## Template pack (submit verbatim)

### 1. `dewan_welcome` — Category: **Marketing** — Button: Quick reply
First touch to someone who has never messaged in (agent-added candidate).
Param: `{{1}}` = first name. Sample `{{1}}` = `Kasun`.

- **English** — Button: `Get started`
  > Hi {{1}}! Welcome to Dewan Consultants — Sri Lanka's trusted overseas recruitment agency. We'd love to help you find a great job abroad. Reply to this message and we'll get started with a few quick questions.
- **Sinhala** — Button: `පටන් ගන්න`
  > ආයුබෝවන් {{1}}! Dewan Consultants වෙත සාදරයෙන් පිළිගනිමු — විදේශ රැකියා සඳහා ශ්‍රී ලංකාවේ විශ්වාසනීය ආයතනය. විදේශගත හොඳ රැකියාවක් සොයා ගැනීමට අපි ඔබට උදව් කරන්නෙමු. ආරම්භ කිරීමට මෙම පණිවිඩයට පිළිතුරු දෙන්න.
- **Tamil** — Button: `தொடங்க`
  > வணக்கம் {{1}}! Dewan Consultants-க்கு வரவேற்கிறோம் — வெளிநாட்டு வேலைவாய்ப்புக்கான இலங்கையின் நம்பகமான நிறுவனம். வெளிநாட்டில் சிறந்த வேலையைக் கண்டுபிடிக்க நாங்கள் உதவுகிறோம். தொடங்க இந்த செய்திக்கு பதிலளியுங்கள்.

### 2. `dewan_status_update` — Category: **Utility**
Generic application update. Params: `{{1}}` = first name, `{{2}}` = one-line
summary. Samples: `{{1}}` = `Kasun`, `{{2}}` = `You have been certified for the Electrician (Qatar) position — our team will contact you with next steps.`

- **English**
  > Hi {{1}}, here is an update on your job application with Dewan Consultants: {{2}} Reply to this message to see the full details and continue.
- **Sinhala** — `{{2}}` sample: `ඔබව Electrician (Qatar) තනතුර සඳහා සහතික කර ඇත — ඉදිරි පියවර ගැන අපේ කණ්ඩායම සම්බන්ධ වෙයි.`
  > ආයුබෝවන් {{1}}, Dewan Consultants සමඟ ඔබේ රැකියා අයදුම්පත පිළිබඳ යාවත්කාලීනයක්: {{2}} සම්පූර්ණ විස්තර බැලීමට සහ ඉදිරියට යාමට මෙම පණිවිඩයට පිළිතුරු දෙන්න.
- **Tamil** — `{{2}}` sample: `Electrician (Qatar) பதவிக்கு நீங்கள் சான்றளிக்கப்பட்டுள்ளீர்கள் — அடுத்த படிகள் பற்றி எங்கள் குழு தொடர்பு கொள்ளும்.`
  > வணக்கம் {{1}}, Dewan Consultants உடனான உங்கள் வேலை விண்ணப்பம் குறித்த புதுப்பிப்பு: {{2}} முழு விவரங்களைப் பார்க்கவும் தொடரவும் இந்த செய்திக்கு பதிலளியுங்கள்.

### 3. `dewan_interview_scheduled` — Category: **Utility**
Params: `{{1}}` = first name, `{{2}}` = job title, `{{3}}` = date/time. Samples:
`Kasun` / `Electrician (Qatar)` / `Monday, June 15 at 10:00 AM`.

- **English**
  > Hi {{1}}! Your interview for the {{2}} position has been scheduled for {{3}}. Please reply to this message to confirm and receive the venue details and instructions. Good luck!
- **Sinhala**
  > ආයුබෝවන් {{1}}! {{2}} තනතුර සඳහා ඔබේ සම්මුඛ පරීක්ෂණය {{3}} දිනට නියමිතයි. තහවුරු කිරීමට සහ ස්ථානය හා උපදෙස් ලබා ගැනීමට මෙම පණිවිඩයට පිළිතුරු දෙන්න. සුභ පැතුම්!
- **Tamil**
  > வணக்கம் {{1}}! {{2}} பதவிக்கான உங்கள் நேர்காணல் {{3}} அன்று திட்டமிடப்பட்டுள்ளது. உறுதிப்படுத்தவும் இடம் மற்றும் வழிமுறைகளைப் பெறவும் இந்த செய்திக்கு பதிலளியுங்கள். வாழ்த்துக்கள்!

### 4. `dewan_interview_reminder` — Category: **Utility**
Same params as #3. Samples: `Kasun` / `Electrician (Qatar)` / `Monday, June 15 at 10:00 AM`.

- **English**
  > Hi {{1}}! Friendly reminder — your interview for the {{2}} position is on {{3}}. Please arrive on time and bring your original documents. Reply to this message if you have any questions.
- **Sinhala**
  > ආයුබෝවන් {{1}}! මතක් කිරීමක් — {{2}} තනතුර සඳහා ඔබේ සම්මුඛ පරීක්ෂණය {{3}} දිනට නියමිතයි. කරුණාකර වේලාවට පැමිණ මුල් ලේඛන රැගෙන එන්න. ප්‍රශ්න ඇත්නම් මෙම පණිවිඩයට පිළිතුරු දෙන්න.
- **Tamil**
  > வணக்கம் {{1}}! நினைவூட்டல் — {{2}} பதவிக்கான உங்கள் நேர்காணல் {{3}} அன்று நடைபெறும். நேரத்திற்கு வந்து உங்கள் அசல் ஆவணங்களைக் கொண்டு வாருங்கள். கேள்விகள் இருந்தால் இந்த செய்திக்கு பதிலளியுங்கள்.

### 5. `dewan_interview_day_reminder` — Category: **Utility**
Same params as #3. Samples: `Kasun` / `Electrician (Qatar)` / `today at 10:00 AM`.

- **English**
  > Hi {{1}}! Today is your interview for the {{2}} position — {{3}}. Please leave in good time, arrive 15 minutes early, and bring your original documents. Best of luck!
- **Sinhala**
  > ආයුබෝවන් {{1}}! අද ඔබේ {{2}} තනතුරේ සම්මුඛ පරීක්ෂණය — {{3}}. කරුණාකර කල්තියා පිටත්ව, මිනිත්තු 15කට පෙර පැමිණ, මුල් ලේඛන රැගෙන එන්න. සුභ පැතුම්!
- **Tamil**
  > வணக்கம் {{1}}! இன்று உங்கள் {{2}} பதவிக்கான நேர்காணல் — {{3}}. சரியான நேரத்தில் புறப்பட்டு, 15 நிமிடங்கள் முன்னதாக வந்து, அசல் ஆவணங்களைக் கொண்டு வாருங்கள். வாழ்த்துக்கள்!

### 6. `dewan_job_now_available` — Category: **Marketing** — Button: Quick reply `YES`
Params: `{{1}}` = first name, `{{2}}` = job title. Samples: `Kasun` / `Electrician (Qatar)`.

- **English**
  > Hi {{1}}! Good news — you asked us earlier about a {{2}} role, and we now have a matching opening. Would you like to apply? Reply YES and we will continue your application right away.
- **Sinhala**
  > ආයුබෝවන් {{1}}! සුබ ආරංචියක් — ඔබ කලින් {{2}} රැකියාවක් ගැන විමසුවා, දැන් ඒකට ගැලපෙන පුරප්පාඩුවක් තිබෙනවා. අයදුම් කරන්න කැමතිද? YES කියලා පිළිතුරු දෙන්න, අපි ඔබේ අයදුම්පත ඉදිරියට ගෙනියමු.
- **Tamil**
  > வணக்கம் {{1}}! நல்ல செய்தி — நீங்கள் முன்பு {{2}} வேலை பற்றி கேட்டீர்கள், இப்போது அதற்கு பொருந்தும் வாய்ப்பு உள்ளது. விண்ணப்பிக்க விரும்புகிறீர்களா? YES என்று பதிலளியுங்கள், உங்கள் விண்ணப்பத்தைத் தொடர்வோம்.

### 7. `dewan_reengage` — Category: **Utility** — Button: Quick reply
Sent when an agent writes to a candidate outside the 24h window; their actual
message is queued and delivers on the reply. Param: `{{1}}` = first name. Sample: `Kasun`.

- **English** — Button: `View update`
  > Hi {{1}}, our recruitment team has an update about your job application and a message waiting for you. Please reply to this message to receive it.
- **Sinhala** — Button: `බලන්න`
  > ආයුබෝවන් {{1}}, ඔබේ රැකියා අයදුම්පත ගැන යාවත්කාලීනයක් සහ ඔබ වෙනුවෙන් පණිවිඩයක් අපේ කණ්ඩායම සතුව ඇත. එය ලබා ගැනීමට මෙම පණිවිඩයට පිළිතුරු දෙන්න.
- **Tamil** — Button: `பார்க்க`
  > வணக்கம் {{1}}, உங்கள் வேலை விண்ணப்பம் குறித்த புதுப்பிப்பும் உங்களுக்காக ஒரு செய்தியும் எங்கள் குழுவிடம் உள்ளது. அதைப் பெற இந்த செய்திக்கு பதிலளியுங்கள்.

### 8. `dewan_followup_missing_info` — Category: **Utility**
Stuck-candidate nudge (used by the follow-up engine). Params: `{{1}}` = first
name, `{{2}}` = missing field. Samples: `Kasun` / `CV document`.

- **English**
  > Hi {{1}}, your job application with Dewan Consultants is almost complete — we still need your {{2}}. Reply to this message to continue where you left off.
- **Sinhala**
  > ආයුබෝවන් {{1}}, Dewan Consultants සමඟ ඔබේ රැකියා අයදුම්පත වැඩ අවසන් වීමට ආසන්නයි — ඔබේ {{2}} තවම අවශ්‍යයි. නතර වූ තැනින් ඉදිරියට යාමට මෙම පණිවිඩයට පිළිතුරු දෙන්න.
- **Tamil**
  > வணக்கம் {{1}}, Dewan Consultants உடனான உங்கள் வேலை விண்ணப்பம் கிட்டத்தட்ட முடிந்துவிட்டது — உங்கள் {{2}} இன்னும் தேவை. நிறுத்திய இடத்திலிருந்து தொடர இந்த செய்திக்கு பதிலளியுங்கள்.

---

## After approval — activate (we do this)

Edit the chatbot's gitignored `Chatbot/whatsapp-recruitment-bot/env.yaml` (it
must contain the FULL var set, since `--env-vars-file` replaces everything):

```yaml
TEMPLATE_WELCOME: "dewan_welcome"
TEMPLATE_STATUS_UPDATE: "dewan_status_update"
TEMPLATE_REENGAGE: "dewan_reengage"
TEMPLATE_INTERVIEW_SCHEDULED: "dewan_interview_scheduled"
TEMPLATE_INTERVIEW_REMINDER: "dewan_interview_reminder"
TEMPLATE_INTERVIEW_DAY_REMINDER: "dewan_interview_day_reminder"
TEMPLATE_JOB_NOW_AVAILABLE: "dewan_job_now_available"
FOLLOWUP_TEMPLATE_MISSING_INFO: "dewan_followup_missing_info"
```

Then redeploy the chatbot (web + worker) via `deploy.ps1`. No backend or frontend
deploy is needed for this step.
