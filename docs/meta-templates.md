# Meta WhatsApp Templates — copy-paste submission guide

This is the **complete, ready-to-paste pack** of WhatsApp message templates to
create in **Meta Business Manager**. The chatbot sends these when a candidate is
**outside WhatsApp's 24-hour window** (the normal case for certifications and
interviews that happen days after they last messaged). Until a template is
approved + its env var is set, the system falls back to free-form, which Meta
silently drops out-of-window — so approving these is what makes out-of-window
delivery actually work.

> **Who does this:** only an **admin of the Dewan Meta Business account** can
> submit templates — Claude can't. Do the steps below, then send us the approved
> template names so we set the env vars and redeploy the chatbot.

---

## TL;DR — what you'll do

1. Open **WhatsApp Manager → Message templates → Create template**.
2. For each of the **11 templates** below: set the **Category**, paste the
   **Name**, add **3 languages** (English, Sinhala, Tamil), paste each **Body**,
   add the **Buttons** where shown, fill the **Samples**, **Submit**.
3. When they're approved, **tell us** → we flip the env vars + redeploy.

**Submit English first** for every template — the code falls back to English for
any language that isn't approved yet, so English alone already lights up delivery.

---

## The 6 fields in Meta's form (read once)

When you click **Create template**, you fill these:

| Field | What to enter |
|---|---|
| **Category** | `Utility` or `Marketing` — stated per template below. |
| **Name** | The exact snake_case name (e.g. `dewan_welcome`). Paste it — don't retype. |
| **Languages** | Add **English**, **Sinhala**, **Tamil** before editing. ⚠️ Use plain **"English" (`en`)**, NOT "English (US)" (`en_US`). |
| **Body** | Paste the body text. `{{1}}`, `{{2}}`… are placeholders the bot fills. |
| **Buttons** | Where noted: **Buttons → Quick reply**, then type the button text. |
| **Samples** | Click **Add sample** and fill every `{{n}}` — **Meta rejects submissions with empty samples.** |

### 4 golden rules (avoid rejections)
- **`en`, not `en_US`.** A mismatch throws API error 132001 "template not found in language".
- **Samples are mandatory.** Fill every `{{n}}` before submitting.
- **Don't reorder or add `{{n}}`.** The bot fills them in the exact order listed. Bodies never start/end with a placeholder and never put two placeholders side-by-side (Meta requires literal text between them) — all bodies below already comply.
- **Utility = transactional tone.** Utility templates must read as a plain update about an existing application. Promo language ("great news!", urgency, offers) can get a Utility template rejected or auto-moved to Marketing. If that happens, soften the wording **or** just resubmit as **Marketing** — the code only cares about the *name*, never the category. If one language variant is rejected, fix and resubmit just that one; approved variants stay live.

---

## Checklist — the 11 templates

| # | Name | Category | Buttons | Submitted | Approved (en/si/ta) |
|---|---|---|---|---|---|
| 1 | `dewan_welcome` | Marketing | 1 quick-reply | ☐ | ☐ ☐ ☐ |
| 2 | `dewan_reengage` | Utility | 1 quick-reply | ☐ | ☐ ☐ ☐ |
| 3 | `dewan_status_update` | Utility | — | ☐ | ☐ ☐ ☐ |
| 4 | `dewan_followup_missing_info` | Utility | — | ☐ | ☐ ☐ ☐ |
| 5 | `dewan_interview_invite` | Utility | 3 quick-reply | ☐ | ☐ ☐ ☐ |
| 6 | `dewan_interview_scheduled` | Utility | — | ☐ | ☐ ☐ ☐ |
| 7 | `dewan_interview_reminder` | Utility | — | ☐ | ☐ ☐ ☐ |
| 8 | `dewan_interview_day_reminder` | Utility | — | ☐ | ☐ ☐ ☐ |
| 9 | `dewan_interview_reschedule_options` | Utility | — | ☐ | ☐ ☐ ☐ |
| 10 | `dewan_cant_make_job_offer` | Marketing | 1 quick-reply | ☐ | ☐ ☐ ☐ |
| 11 | `dewan_job_now_available` | Marketing | 1 quick-reply | ☐ | ☐ ☐ ☐ |

**Suggested order to submit** (highest impact first): 1 → 3 → 2 → 5 → 6 → then the rest.

### Master reference (name → env var → parameters)

| Template name | Env var we set after approval | Body params (in order) |
|---|---|---|
| `dewan_welcome` | `TEMPLATE_WELCOME` | 1=first name |
| `dewan_reengage` | `TEMPLATE_REENGAGE` | 1=first name |
| `dewan_status_update` | `TEMPLATE_STATUS_UPDATE` | 1=first name, 2=one-line summary |
| `dewan_followup_missing_info` | `FOLLOWUP_TEMPLATE_MISSING_INFO` | 1=first name, 2=missing field |
| `dewan_interview_invite` | `TEMPLATE_INTERVIEW_INVITE` | 1=first name, 2=job title, 3=date/time, 4=location, 5=what to bring, 6=dress code |
| `dewan_interview_scheduled` | `TEMPLATE_INTERVIEW_SCHEDULED` | 1=first name, 2=job title, 3=date/time |
| `dewan_interview_reminder` | `TEMPLATE_INTERVIEW_REMINDER` | 1=first name, 2=job title, 3=date/time |
| `dewan_interview_day_reminder` | `TEMPLATE_INTERVIEW_DAY_REMINDER` | 1=first name, 2=job title, 3=date/time |
| `dewan_interview_reschedule_options` | `TEMPLATE_INTERVIEW_RESCHEDULE_OPTIONS` | 1=first name |
| `dewan_cant_make_job_offer` | `TEMPLATE_CANT_MAKE_JOB_OFFER` | 1=first name, 2=job title |
| `dewan_job_now_available` | `TEMPLATE_JOB_NOW_AVAILABLE` | 1=first name, 2=job title |

> **About the interview flow (templates 5–11):** `dewan_interview_invite` (#5) is
> the rich invite — its three quick-reply buttons are declared **on the template**
> so they deliver **out-of-window** (a candidate who last messaged weeks ago can
> still tap Confirm / Reschedule / Can't make it). When `TEMPLATE_INTERVIEW_INVITE`
> is set the bot sends #5; if unset it falls back to the buttonless
> `dewan_interview_scheduled` (#6) — no regression. The button taps route to the
> bot, which then sends bookable slots / other jobs as **in-window interactive
> lists**. Templates #9 and #10 are just the out-of-window "teasers" that re-open
> the window so those interactive lists can be sent.
>
> **Date-specific interviews:** #5 already covers them with no template change.
> When a project has configured interview days (`interview_config.days[]`), param 3
> carries the candidate's assigned day, param 4 the **per-day venue**, and params
> 5/6 the per-day what-to-bring / dress code. The full "other available days" list
> can't go in a template body (Meta rejects newlines/long runs), so it's delivered
> **in-window** on the candidate's first reply (via the pending-message queue);
> tapping **Reschedule** then offers the project's *other configured days* (each
> with its own venue) as an interactive list.
>
> **`dewan_status_update` (#3) is the catch-all:** one template covers certified,
> prescreening, application-received, shortlisted, hired, general-pool,
> rejected-with-alternatives, transferred, and reschedule/cancel — the code writes
> the right `{{2}}` summary per status, and the full message follows in-window when
> the candidate replies.

---

## Step-by-step (the click path)

1. Go to **business.facebook.com** → pick the **Dewan** business → open **WhatsApp
   Manager** (also under Meta Business Suite → All tools → WhatsApp Manager).
   Select the WABA that owns the chatbot's phone number.
2. Left nav → **Account tools → Message templates** → **Create template**.
3. Pick the **Category**, paste the **Name**, and **add all three languages**
   (English, Sinhala, Tamil) before you start typing bodies.
4. In each language tab: paste the **Body**, add the **Quick-reply button(s)**
   where noted, then **Add sample** and fill every `{{n}}`.
5. **Submit.** Each language is reviewed separately (Pending → Approved/Rejected) —
   usually minutes to a few hours, occasionally 24–48h.
6. **Send us the approved names** → we set env vars + redeploy.

---

# Template pack — copy & paste

> Each card gives you: the **Name** to paste, the **Category** to pick, the
> **Samples** to fill, and one block per language with its **Body** (and **Button**
> text). The placeholders (`{{1}}`…) stay literally in the body — do not replace
> them with the sample values; the sample values go only in the "Add sample" boxes.

---

## 1 · `dewan_welcome`

**Category:** `Marketing`  ·  **Buttons:** 1 quick-reply  ·  First touch to a candidate an agent added (never messaged in).

**Name:**
```
dewan_welcome
```

**Parameters & samples** (same sample for all 3 languages):
- `{{1}}` = first name — sample: `Kasun`

#### English  — Quick-reply button:
```
Get started
```
Body:
```
Hi {{1}}! Welcome to Dewan Consultants — Sri Lanka's trusted overseas recruitment agency. We'd love to help you find a great job abroad. Reply to this message and we'll get started with a few quick questions.
```

#### Sinhala  — Quick-reply button:
```
පටන් ගන්න
```
Body:
```
ආයුබෝවන් {{1}}! Dewan Consultants වෙත සාදරයෙන් පිළිගනිමු — විදේශ රැකියා සඳහා ශ්‍රී ලංකාවේ විශ්වාසනීය ආයතනය. විදේශගත හොඳ රැකියාවක් සොයා ගැනීමට අපි ඔබට උදව් කරන්නෙමු. ආරම්භ කිරීමට මෙම පණිවිඩයට පිළිතුරු දෙන්න.
```

#### Tamil  — Quick-reply button:
```
தொடங்க
```
Body:
```
வணக்கம் {{1}}! Dewan Consultants-க்கு வரவேற்கிறோம் — வெளிநாட்டு வேலைவாய்ப்புக்கான இலங்கையின் நம்பகமான நிறுவனம். வெளிநாட்டில் சிறந்த வேலையைக் கண்டுபிடிக்க நாங்கள் உதவுகிறோம். தொடங்க இந்த செய்திக்கு பதிலளியுங்கள்.
```

> **Optional richer English body** (keep the same name, single `{{1}}`, and `Get started` button; mirror in si/ta if you want):
> ```
> Hi {{1}}! Welcome to Dewan Consultants, Sri Lanka's trusted overseas recruitment partner. We help skilled workers find well-paid, verified jobs abroad with full visa and travel support. Tap Get started and we'll guide you step by step.
> ```

---

## 2 · `dewan_reengage`

**Category:** `Utility`  ·  **Buttons:** 1 quick-reply  ·  Sent when an agent messages a dormant candidate out-of-window; the agent's real message is queued and delivers on the reply.

**Name:**
```
dewan_reengage
```

**Parameters & samples:**
- `{{1}}` = first name — sample: `Kasun`

#### English  — Quick-reply button:
```
View update
```
Body:
```
Hi {{1}}, our recruitment team has an update about your job application and a message waiting for you. Please reply to this message to receive it.
```

#### Sinhala  — Quick-reply button:
```
බලන්න
```
Body:
```
ආයුබෝවන් {{1}}, ඔබේ රැකියා අයදුම්පත ගැන යාවත්කාලීනයක් සහ ඔබ වෙනුවෙන් පණිවිඩයක් අපේ කණ්ඩායම සතුව ඇත. එය ලබා ගැනීමට මෙම පණිවිඩයට පිළිතුරු දෙන්න.
```

#### Tamil  — Quick-reply button:
```
பார்க்க
```
Body:
```
வணக்கம் {{1}}, உங்கள் வேலை விண்ணப்பம் குறித்த புதுப்பிப்பும் உங்களுக்காக ஒரு செய்தியும் எங்கள் குழுவிடம் உள்ளது. அதைப் பெற இந்த செய்திக்கு பதிலளியுங்கள்.
```

---

## 3 · `dewan_status_update`

**Category:** `Utility`  ·  **Buttons:** none  ·  The generic catch-all application update.

**Name:**
```
dewan_status_update
```

**Parameters & samples** (`{{2}}` differs per language — use the matching one):
- `{{1}}` = first name — sample: `Kasun`
- `{{2}}` = one-line summary — samples below per language.

#### English
Body:
```
Hi {{1}}, here is an update on your job application with Dewan Consultants: {{2}} Reply to this message to see the full details and continue.
```
Sample for `{{2}}`:
```
You have been certified for the Electrician (Qatar) position — our team will contact you with next steps.
```

#### Sinhala
Body:
```
ආයුබෝවන් {{1}}, Dewan Consultants සමඟ ඔබේ රැකියා අයදුම්පත පිළිබඳ යාවත්කාලීනයක්: {{2}} සම්පූර්ණ විස්තර බැලීමට සහ ඉදිරියට යාමට මෙම පණිවිඩයට පිළිතුරු දෙන්න.
```
Sample for `{{2}}`:
```
ඔබව Electrician (Qatar) තනතුර සඳහා සහතික කර ඇත — ඉදිරි පියවර ගැන අපේ කණ්ඩායම සම්බන්ධ වෙයි.
```

#### Tamil
Body:
```
வணக்கம் {{1}}, Dewan Consultants உடனான உங்கள் வேலை விண்ணப்பம் குறித்த புதுப்பிப்பு: {{2}} முழு விவரங்களைப் பார்க்கவும் தொடரவும் இந்த செய்திக்கு பதிலளியுங்கள்.
```
Sample for `{{2}}`:
```
Electrician (Qatar) பதவிக்கு நீங்கள் சான்றளிக்கப்பட்டுள்ளீர்கள் — அடுத்த படிகள் பற்றி எங்கள் குழு தொடர்பு கொள்ளும்.
```

---

## 4 · `dewan_followup_missing_info`

**Category:** `Utility`  ·  **Buttons:** none  ·  Nudge for a stuck candidate (used by the follow-up engine).

**Name:**
```
dewan_followup_missing_info
```

**Parameters & samples** (same for all 3 languages):
- `{{1}}` = first name — sample: `Kasun`
- `{{2}}` = missing field — sample: `CV document`

#### English
Body:
```
Hi {{1}}, your job application with Dewan Consultants is almost complete — we still need your {{2}}. Reply to this message to continue where you left off.
```

#### Sinhala
Body:
```
ආයුබෝවන් {{1}}, Dewan Consultants සමඟ ඔබේ රැකියා අයදුම්පත වැඩ අවසන් වීමට ආසන්නයි — ඔබේ {{2}} තවම අවශ්‍යයි. නතර වූ තැනින් ඉදිරියට යාමට මෙම පණිවිඩයට පිළිතුරු දෙන්න.
```

#### Tamil
Body:
```
வணக்கம் {{1}}, Dewan Consultants உடனான உங்கள் வேலை விண்ணப்பம் கிட்டத்தட்ட முடிந்துவிட்டது — உங்கள் {{2}} இன்னும் தேவை. நிறுத்திய இடத்திலிருந்து தொடர இந்த செய்திக்கு பதிலளியுங்கள்.
```

---

## 5 · `dewan_interview_invite`  ⭐ (the rich invite — 3 buttons)

**Category:** `Utility`  ·  **Buttons:** **3 quick-reply** (add all three: Confirm, Reschedule, Can't make it).

**Name:**
```
dewan_interview_invite
```

**Parameters & samples** (same for all 3 languages):
- `{{1}}` = first name — sample: `Kasun`
- `{{2}}` = job title — sample: `Electrician (Qatar)`
- `{{3}}` = date/time — sample: `Monday, June 15 at 10:00 AM`
- `{{4}}` = location — sample: `Dewan Office, Colombo 03`
- `{{5}}` = what to bring — sample: `NIC and original certificates`
- `{{6}}` = dress code — sample: `Smart casual`

#### English  — Quick-reply buttons (add 3):
```
Confirm
```
```
Reschedule
```
```
Can't make it
```
Body:
```
Hi {{1}}! Your interview for the {{2}} position is scheduled for {{3}} at {{4}}. Please bring {{5}}, and the dress code is {{6}}. Tap a button below to confirm, reschedule, or let us know if you cannot make it.
```

#### Sinhala  — Quick-reply buttons (add 3):
```
තහවුරු කරන්න
```
```
වෙනස් කරන්න
```
```
බැහැ
```
Body:
```
ආයුබෝවන් {{1}}! {{2}} තනතුර සඳහා ඔබේ සම්මුඛ පරීක්ෂණය {{3}} දින {{4}} ස්ථානයේ නියමිතයි. කරුණාකර {{5}} රැගෙන එන්න, ඇඳුම් රටාව {{6}}. තහවුරු කිරීමට, වෙනස් කිරීමට, හෝ පැමිණිය නොහැකි නම් පහත බොත්තමක් ඔබන්න.
```

#### Tamil  — Quick-reply buttons (add 3):
```
உறுதி
```
```
மாற்று
```
```
முடியாது
```
Body:
```
வணக்கம் {{1}}! {{2}} பதவிக்கான உங்கள் நேர்காணல் {{3}} அன்று {{4}} இல் நடைபெறும். தயவுசெய்து {{5}} கொண்டு வாருங்கள், உடை {{6}}. உறுதிப்படுத்த, மாற்ற அல்லது வர முடியாது எனத் தெரிவிக்க கீழே ஒரு பொத்தானை அழுத்துங்கள்.
```

---

## 6 · `dewan_interview_scheduled`

**Category:** `Utility`  ·  **Buttons:** none  ·  Buttonless fallback invite (used when #5 isn't set).

**Name:**
```
dewan_interview_scheduled
```

**Parameters & samples** (same for all 3 languages):
- `{{1}}` = first name — sample: `Kasun`
- `{{2}}` = job title — sample: `Electrician (Qatar)`
- `{{3}}` = date/time — sample: `Monday, June 15 at 10:00 AM`

#### English
Body:
```
Hi {{1}}! Your interview for the {{2}} position has been scheduled for {{3}}. Please reply to this message to confirm and receive the venue details and instructions. Good luck!
```

#### Sinhala
Body:
```
ආයුබෝවන් {{1}}! {{2}} තනතුර සඳහා ඔබේ සම්මුඛ පරීක්ෂණය {{3}} දිනට නියමිතයි. තහවුරු කිරීමට සහ ස්ථානය හා උපදෙස් ලබා ගැනීමට මෙම පණිවිඩයට පිළිතුරු දෙන්න. සුභ පැතුම්!
```

#### Tamil
Body:
```
வணக்கம் {{1}}! {{2}} பதவிக்கான உங்கள் நேர்காணல் {{3}} அன்று திட்டமிடப்பட்டுள்ளது. உறுதிப்படுத்தவும் இடம் மற்றும் வழிமுறைகளைப் பெறவும் இந்த செய்திக்கு பதிலளியுங்கள். வாழ்த்துக்கள்!
```

---

## 7 · `dewan_interview_reminder`

**Category:** `Utility`  ·  **Buttons:** none  ·  Reminder a day or two before.

**Name:**
```
dewan_interview_reminder
```

**Parameters & samples** (same for all 3 languages):
- `{{1}}` = first name — sample: `Kasun`
- `{{2}}` = job title — sample: `Electrician (Qatar)`
- `{{3}}` = date/time — sample: `Monday, June 15 at 10:00 AM`

#### English
Body:
```
Hi {{1}}! Friendly reminder — your interview for the {{2}} position is on {{3}}. Please arrive on time and bring your original documents. Reply to this message if you have any questions.
```

#### Sinhala
Body:
```
ආයුබෝවන් {{1}}! මතක් කිරීමක් — {{2}} තනතුර සඳහා ඔබේ සම්මුඛ පරීක්ෂණය {{3}} දිනට නියමිතයි. කරුණාකර වේලාවට පැමිණ මුල් ලේඛන රැගෙන එන්න. ප්‍රශ්න ඇත්නම් මෙම පණිවිඩයට පිළිතුරු දෙන්න.
```

#### Tamil
Body:
```
வணக்கம் {{1}}! நினைவூட்டல் — {{2}} பதவிக்கான உங்கள் நேர்காணல் {{3}} அன்று நடைபெறும். நேரத்திற்கு வந்து உங்கள் அசல் ஆவணங்களைக் கொண்டு வாருங்கள். கேள்விகள் இருந்தால் இந்த செய்திக்கு பதிலளியுங்கள்.
```

---

## 8 · `dewan_interview_day_reminder`

**Category:** `Utility`  ·  **Buttons:** none  ·  Morning-of reminder.

**Name:**
```
dewan_interview_day_reminder
```

**Parameters & samples** (same for all 3 languages):
- `{{1}}` = first name — sample: `Kasun`
- `{{2}}` = job title — sample: `Electrician (Qatar)`
- `{{3}}` = date/time — sample: `today at 10:00 AM`

#### English
Body:
```
Hi {{1}}! Today is your interview for the {{2}} position — {{3}}. Please leave in good time, arrive 15 minutes early, and bring your original documents. Best of luck!
```

#### Sinhala
Body:
```
ආයුබෝවන් {{1}}! අද ඔබේ {{2}} තනතුරේ සම්මුඛ පරීක්ෂණය — {{3}}. කරුණාකර කල්තියා පිටත්ව, මිනිත්තු 15කට පෙර පැමිණ, මුල් ලේඛන රැගෙන එන්න. සුභ පැතුම්!
```

#### Tamil
Body:
```
வணக்கம் {{1}}! இன்று உங்கள் {{2}} பதவிக்கான நேர்காணல் — {{3}}. சரியான நேரத்தில் புறப்பட்டு, 15 நிமிடங்கள் முன்னதாக வந்து, அசல் ஆவணங்களைக் கொண்டு வாருங்கள். வாழ்த்துக்கள்!
```

---

## 9 · `dewan_interview_reschedule_options`

**Category:** `Utility`  ·  **Buttons:** none  ·  Out-of-window teaser — re-opens the window so the bot can send the actual slot list in-window.

**Name:**
```
dewan_interview_reschedule_options
```

**Parameters & samples:**
- `{{1}}` = first name — sample: `Kasun`

#### English
Body:
```
Hi {{1}}, we received your request to reschedule your interview. Reply to this message and we will send you the next available time slots to choose from.
```

#### Sinhala
Body:
```
ආයුබෝවන් {{1}}, ඔබේ සම්මුඛ පරීක්ෂණය වෙනස් කිරීමේ ඉල්ලීම ලැබුණා. මෙම පණිවිඩයට පිළිතුරු දෙන්න, ඊළඟට තිබෙන වේලාවන් ඔබට එවන්නම්.
```

#### Tamil
Body:
```
வணக்கம் {{1}}, உங்கள் நேர்காணலை மாற்றும் கோரிக்கை கிடைத்தது. இந்த செய்திக்கு பதிலளியுங்கள், அடுத்த கிடைக்கும் நேரங்களை அனுப்புகிறோம்.
```

---

## 10 · `dewan_cant_make_job_offer`

**Category:** `Marketing`  ·  **Buttons:** 1 quick-reply  ·  Offers other openings when a candidate can't attend. Out-of-window teaser; per-job Apply / Not-interested list is sent in-window.

**Name:**
```
dewan_cant_make_job_offer
```

**Parameters & samples** (same for all 3 languages):
- `{{1}}` = first name — sample: `Kasun`
- `{{2}}` = job title — sample: `Welder (Saudi Arabia)`

#### English  — Quick-reply button:
```
View jobs
```
Body:
```
Hi {{1}}, no problem about the interview. We have other openings that may suit you, including a {{2}} role. Reply to see them and apply in one tap.
```

#### Sinhala  — Quick-reply button:
```
රැකියා බලන්න
```
Body:
```
ආයුබෝවන් {{1}}, සම්මුඛ පරීක්ෂණය ගැන කරදර වෙන්න එපා. ඔබට ගැලපෙන වෙනත් රැකියා, {{2}} ඇතුළුව, තිබෙනවා. බලන්න මෙම පණිවිඩයට පිළිතුරු දෙන්න.
```

#### Tamil  — Quick-reply button:
```
வேலைகளைப் பார்
```
Body:
```
வணக்கம் {{1}}, நேர்காணல் பற்றி கவலை வேண்டாம். {{2}} உட்பட உங்களுக்கு பொருந்தும் வேறு வேலைகள் உள்ளன. பார்க்க இந்த செய்திக்கு பதிலளியுங்கள்.
```

---

## 11 · `dewan_job_now_available`

**Category:** `Marketing`  ·  **Buttons:** 1 quick-reply  ·  Tells a waitlisted candidate their requested role just opened.

**Name:**
```
dewan_job_now_available
```

**Parameters & samples** (same for all 3 languages):
- `{{1}}` = first name — sample: `Kasun`
- `{{2}}` = job title — sample: `Electrician (Qatar)`

**Button text** — use the same `YES` for all three languages (it's the reply keyword the body mentions):
```
YES
```

#### English
Body:
```
Hi {{1}}! Good news — you asked us earlier about a {{2}} role, and we now have a matching opening. Would you like to apply? Reply YES and we will continue your application right away.
```

#### Sinhala
Body:
```
ආයුබෝවන් {{1}}! සුබ ආරංචියක් — ඔබ කලින් {{2}} රැකියාවක් ගැන විමසුවා, දැන් ඒකට ගැලපෙන පුරප්පාඩුවක් තිබෙනවා. අයදුම් කරන්න කැමතිද? YES කියලා පිළිතුරු දෙන්න, අපි ඔබේ අයදුම්පත ඉදිරියට ගෙනියමු.
```

#### Tamil
Body:
```
வணக்கம் {{1}}! நல்ல செய்தி — நீங்கள் முன்பு {{2}} வேலை பற்றி கேட்டீர்கள், இப்போது அதற்கு பொருந்தும் வாய்ப்பு உள்ளது. விண்ணப்பிக்க விரும்புகிறீர்களா? YES என்று பதிலளியுங்கள், உங்கள் விண்ணப்பத்தைத் தொடர்வோம்.
```

---

# After approval — activation (we do this)

Once you tell us the approved names, we edit the chatbot's **gitignored**
`Chatbot/whatsapp-recruitment-bot/env.yaml` (it must hold the **full** var set —
`--env-vars-file` replaces everything) and set:

```yaml
TEMPLATE_WELCOME: "dewan_welcome"
TEMPLATE_REENGAGE: "dewan_reengage"
TEMPLATE_STATUS_UPDATE: "dewan_status_update"
FOLLOWUP_TEMPLATE_MISSING_INFO: "dewan_followup_missing_info"
TEMPLATE_INTERVIEW_INVITE: "dewan_interview_invite"
TEMPLATE_INTERVIEW_SCHEDULED: "dewan_interview_scheduled"
TEMPLATE_INTERVIEW_REMINDER: "dewan_interview_reminder"
TEMPLATE_INTERVIEW_DAY_REMINDER: "dewan_interview_day_reminder"
TEMPLATE_INTERVIEW_RESCHEDULE_OPTIONS: "dewan_interview_reschedule_options"
TEMPLATE_CANT_MAKE_JOB_OFFER: "dewan_cant_make_job_offer"
TEMPLATE_JOB_NOW_AVAILABLE: "dewan_job_now_available"
```

Partial rollout is safe — we set each var as soon as at least its **English**
variant is approved.

> **Bulk-import welcome auto-send:** to make a bulk import auto-send the welcome
> template to every imported candidate (and flag the no-WhatsApp ones for the CSV),
> set `BULK_IMPORT_SEND_WELCOME=true` in the **backend** env *after*
> `TEMPLATE_WELCOME` is approved. Left unset, imports stay silent — safe default
> until the template exists.

Then we redeploy the chatbot (web + worker) via `deploy.ps1`. No backend or
frontend deploy is needed for this step.
