"""Deterministic intake agent for field progression prompts."""

from __future__ import annotations

from typing import Dict, Optional


class IntakeAgent:
    """Provides deterministic prompts and next-step selection for intake."""

    # Ordered field list: name must come first so every candidate is personalised early.
    FIELD_ORDER = ["name", "job_role", "countries", "age", "email", "experience_years"]

    def next_missing_field(self, state: Dict[str, object]) -> Optional[str]:
        collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
        if not collected.get("name"):
            return "name"
        if not collected.get("job_role"):
            return "job_role"
        has_countries = bool(collected.get("countries") or collected.get("country"))
        if not has_countries:
            return "countries"
        if collected.get("age") is None:
            return "age"
        if not collected.get("email"):
            return "email"
        if not collected.get("experience_years"):
            return "experience_years"
        return None

    # ------------------------------------------------------------------ #
    #  Name — always first, sets a warm branded tone                       #
    # ------------------------------------------------------------------ #
    def name_prompt(self, lang: str) -> str:
        prompts = {
            "en": (
                "👋 Welcome to Dewan Consultants — Sri Lanka's trusted overseas recruitment agency! "
                "I'm Dilan from our team. We've helped 200+ workers land great Gulf jobs this year alone 🌟 "
                "May I have your full name to get started?"
            ),
            "si": (
                "👋 Dewan Consultants වෙත සාදරයෙන් පිළිගනිමු — ශ්‍රී ලංකාවේ විශ්වාසදායක විදේශ රැකියා agency! "
                "මම Dilan. මෙ වර්ෂය පමණකදීම 200+ දෙනෙකුට Gulf රැකියා ලබා දුනා 🌟 "
                "ඔබගේ සම්පූර්ණ නම කියන්නද?"
            ),
            "ta": (
                "👋 Dewan Consultants-க்கு வரவேற்கிறோம் — இலங்கையின் நம்பகமான வெளிநாட்டு வேலை agency! "
                "நான் Dilan. இந்த ஆண்டு மட்டும் 200+ பேருக்கு Gulf வேலை வாங்கி தந்தோம் 🌟 "
                "உங்கள் முழு பெயரை சொல்லுங்கள்?"
            ),
            "singlish": (
                "👋 Dewan Consultants-ta welcome! Sri Lanka-ta number one overseas job agency. "
                "Mama Dilan. Meh avuruddey vitharai 200+ denata Gulf jobs labada dunna 🌟 "
                "Oyage full name eka kiyanna da?"
            ),
            "tanglish": (
                "👋 Dewan Consultants-ku welcome! Sri Lanka-la trust-aana overseas job agency. "
                "Naan Dilan. Intha year-la mattum 200+ perunga-ku Gulf jobs vaangithomu 🌟 "
                "Unga full name enna-nu sollunga da?"
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Job Role                                                            #
    # ------------------------------------------------------------------ #
    def job_role_prompt(self, lang: str) -> str:
        prompts = {
            "en": (
                "We have urgent openings across the Gulf right now 🔥 "
                "Which role are you interested in? (e.g. Security Officer)"
            ),
            "si": (
                "දැන් Gulf රටවල හදිසි පුරප්පාඩු තිබෙනවා 🔥 "
                "ඔබට කැමති රැකියාව මොකක්ද? (උදා: Security Officer)"
            ),
            "ta": (
                "இப்போது Gulf நாடுகளில் அவசர வேலைவாய்ப்புகள் உள்ளன 🔥 "
                "உங்களுக்கு விருப்பமான வேலை என்ன? (எ.கா: Security Officer)"
            ),
            "singlish": (
                "Dan Gulf ratawal urgent vacancies tiyenawa 🔥 "
                "Oyata kemathi job role eka mokakda? (eg: Security Officer)"
            ),
            "tanglish": (
                "Ippo Gulf naadugal-la urgent vacancies irukku 🔥 "
                "Ungaluku virumbura job role enna? (eg: Security Officer)"
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Countries                                                           #
    # ------------------------------------------------------------------ #
    def country_prompt(self, lang: str) -> str:
        prompts = {
            "en": (
                "Great choice! 🌍 We place workers in UAE, Qatar, Saudi Arabia, Kuwait, Oman and Malaysia. "
                "Which country or countries would you like to work in? You can name more than one!"
            ),
            "si": (
                "UAE, Qatar, Saudi Arabia, Kuwait, Oman, Malaysia — රට ගොඩක් තිබෙනවා 🌍 "
                "ඔයාට වැඩ කරන්න කැමති රටවල් මොනවද? එකට වඩා කියන්න පුළුවන්!"
            ),
            "ta": (
                "UAE, Qatar, Saudi Arabia, Kuwait, Oman, Malaysia — நிறைய நாடுகள் இருக்கு 🌍 "
                "நீங்கள் வேலை செய்ய விரும்பும் நாடு அல்லது நாடுகள் எவை? ஒன்றுக்கு மேல் சொல்லலாம்!"
            ),
            "singlish": (
                "UAE, Qatar, Saudi, Kuwait, Oman, Malaysia — ratawal tiyenawa 🌍 "
                "Oya kemathi rata/ratawal mokakda? Ekath vada kiyanna puluwanda!"
            ),
            "tanglish": (
                "UAE, Qatar, Saudi, Kuwait, Oman, Malaysia — naadugal irukku 🌍 "
                "Neenga velai-ku virumbura naadu/naadugal enna? Onrukku mela sollalamam!"
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Age                                                                 #
    # ------------------------------------------------------------------ #
    def age_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Most of our Gulf vacancies are open to ages 22–50. How old are you? (just the number is fine)",
            "si": "Gulf රැකියා බොහෝමයක් වයස 22–50 අතර අයට. ඔබේ වයස කීයද? (number එක පමණක් කියන්න)",
            "ta": "பெரும்பாலான Gulf வேலைகள் 22–50 வயதுக்கு இடைப்பட்டவர்களுக்கு. உங்கள் வயது என்ன? (number மட்டும் சொன்னால் போதும்)",
            "singlish": "Gulf jobs godak 22–50 atharei wadi. Oyage wasaya kochcharada? (number eka vitharai kiyanna)",
            "tanglish": "Perumbalum Gulf jobs 22–50 vayasuku-thaan. Unga vayasu enna? (number mattum sollunga)",
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Email                                                               #
    # ------------------------------------------------------------------ #
    def email_prompt(self, lang: str) -> str:
        prompts = {
            "en": (
                "Almost there! 😊 We already have your WhatsApp number. "
                "Could you share your email address so we can send you job offers and updates?"
            ),
            "si": (
                "ඉතාම ළඟයි! 😊 ඔබේ WhatsApp number එක අප ළඟ තියෙනවා. "
                "රැකියා offers එවන්න ඔබේ email ලිපිනය කියන්නද?"
            ),
            "ta": (
                "கிட்டத்தட்ட முடிந்துவிட்டது! 😊 உங்கள் WhatsApp number எங்களிடம் உள்ளது. "
                "வேலை offers அனுப்ப உங்கள் email முகவரியை சொல்லுங்கள்."
            ),
            "singlish": (
                "Almost done! 😊 Oyage WhatsApp number eka apita tiyenawa. "
                "Job offers evanna oyage email address eka denna puluwanda?"
            ),
            "tanglish": (
                "Almost done! 😊 Unga WhatsApp number engalukku irukku. "
                "Job offers anuppa unga email address-a sollunga."
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Experience                                                          #
    # ------------------------------------------------------------------ #
    def experience_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Employers love experienced candidates 💪 How many years of experience do you have in this field?",
            "si": "අත්දැකීම් සහිත අයට employers-ට වැඩි කැමැත්තක් 💪 මේ ක්ෂේත්‍රයේ ඔබට වසර කීයක අත්දැකීම් තිබෙනවද?",
            "ta": "அனுபவம் உள்ளவர்களை employers-க்கு மிகவும் பிடிக்கும் 💪 இந்த துறையில் உங்களுக்கு எத்தனை வருட அனுபவம் உள்ளது?",
            "singlish": "Anubawa thiyena ayata employers-ta wadi kamathi 💪 Me field eke oyata kochchara avurudu anubawa thiyenawada?",
            "tanglish": "Anubavam ullavangala employers-ku romba pudikkum 💪 Inta field-la ungalukku evvalo varusham anubavam irukku?",
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  CV Upload                                                           #
    # ------------------------------------------------------------------ #
    def cv_prompt(self, lang: str) -> str:
        prompts = {
            "en": (
                "🎉 Your profile is almost complete! Just one last step — "
                "please upload your CV (PDF or Word). "
                "It helps our recruiters match you to the best jobs faster. 📄"
            ),
            "si": (
                "🎉 ඔබේ profile එක සම්පූර්ණයි! අවසන් පියවර — "
                "කරුණාකර ඔබේ CV එක upload කරන්න (PDF හෝ Word). "
                "මෙය recruiters-ට ඔබට ගැලපෙන හොඳම රැකියාව ඉක්මනින් සොයාගන්න උපකාරී වේ. 📄"
            ),
            "ta": (
                "🎉 உங்கள் profile கிட்டத்தட்ட முடிந்துவிட்டது! கடைசி படி — "
                "உங்கள் CV-ஐ upload செய்யுங்கள் (PDF அல்லது Word). "
                "இது recruiters-க்கு உங்களுக்கு ஏற்ற சிறந்த வேலையை விரைவாக கண்டுபிடிக்க உதவும். 📄"
            ),
            "singlish": (
                "🎉 Profile eka almost complete! Last step — "
                "oyage CV eka upload karanna (PDF or Word). "
                "Eken recruiters-ta oyata gelapena hondama job eka ikmanata hoyaganna pulwan. 📄"
            ),
            "tanglish": (
                "🎉 Profile almost complete! Last step — "
                "unga CV-ya upload pannunga (PDF or Word). "
                "Ithu recruiters-ku ungalukku porutha-ndha best job-a sikram thedi-edukka help pannum. 📄"
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Extended fields (used when a job's required_fields_schema asks    #
    #  for them — e.g. driver/security/hospitality roles)                #
    # ------------------------------------------------------------------ #
    def passport_number_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Could you share your passport number? (Skip if not issued yet.)",
            "si": "ඔබේ passport number එක කියන්න පුළුවන්ද? (තවම නිකුත් කරගෙන නැත්නම් skip කරන්න.)",
            "ta": "உங்கள் passport number-ஐ சொல்லுங்கள். (இன்னும் வாங்கவில்லை என்றால் skip செய்யுங்கள்.)",
            "singlish": "Oyage passport number eka denna puluwanda? (Tawama gatte nethnan skip karanna.)",
            "tanglish": "Unga passport number sollunga. (Innum vangala-na skip pannunga.)",
        }
        return prompts.get(lang, prompts["en"])

    def phone_alternative_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Is there a second phone number we can reach you on? (Family member is fine.)",
            "si": "ඔබව සම්බන්ධ කරගැනීමට තවත් phone number එකක් තියෙනවද? (පවුලේ අයෙකුගේ එකක් වුණත් කමක් නෑ.)",
            "ta": "உங்களைத் தொடர்புகொள்ள இன்னொரு phone number இருக்கிறதா? (குடும்ப உறுப்பினரின் number-ஆனாலும் பரவாயில்லை.)",
            "singlish": "Oyawa contact karanna thawath phone number ekak tiyenawada? (Family member ekkenage ekak vunath kamak nehe.)",
            "tanglish": "Ungala contact panna innoru phone number irukka? (Family member-de-anu paravailla.)",
        }
        return prompts.get(lang, prompts["en"])

    def height_prompt(self, lang: str) -> str:
        prompts = {
            "en": "What's your height? (in cm — e.g. 170 — or feet+inches — e.g. 5'7\")",
            "si": "ඔබේ උස කොච්චරද? (cm වලින් — උදා: 170 — හෝ feet+inches — උදා: 5'7\")",
            "ta": "உங்கள் உயரம் என்ன? (cm-இல் — எ.கா: 170 — அல்லது feet+inches — எ.கா: 5'7\")",
            "singlish": "Oyage usa kochchara da? (cm walin — eg: 170 — hari feet+inches — eg: 5'7\")",
            "tanglish": "Unga uyaram enna? (cm-la — eg: 170 — illana feet+inches — eg: 5'7\")",
        }
        return prompts.get(lang, prompts["en"])

    def licenses_prompt(self, lang: str) -> str:
        prompts = {
            "en": "What driving licence categories do you hold? (e.g. light, heavy, bus)",
            "si": "ඔබට තියෙන driving licence කාණ්ඩ මොනවද? (උදා: light, heavy, bus)",
            "ta": "உங்களிடம் என்ன driving licence categories உள்ளன? (எ.கா: light, heavy, bus)",
            "singlish": "Oyata tiyena driving licence categories monawada? (eg: light, heavy, bus)",
            "tanglish": "Ungaitam enna driving licence categories irukku? (eg: light, heavy, bus)",
        }
        return prompts.get(lang, prompts["en"])

    def nic_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Could you share your NIC number?",
            "si": "ඔබේ NIC number එක කියන්න පුළුවන්ද?",
            "ta": "உங்கள் NIC number-ஐ சொல்லுங்கள்?",
            "singlish": "Oyage NIC number eka kiyanna puluwanda?",
            "tanglish": "Unga NIC number sollunga?",
        }
        return prompts.get(lang, prompts["en"])

    def english_proficiency_prompt(self, lang: str) -> str:
        prompts = {
            "en": "How would you rate your English? (basic / conversational / fluent)",
            "si": "ඔබේ English මට්ටම කොහොමද? (basic / conversational / fluent)",
            "ta": "உங்கள் English திறமை எப்படி? (basic / conversational / fluent)",
            "singlish": "Oyage English level eka kohomada? (basic / conversational / fluent)",
            "tanglish": "Unga English level eppadi? (basic / conversational / fluent)",
        }
        return prompts.get(lang, prompts["en"])

    def previous_employer_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Who was your most recent employer, and how long did you work there?",
            "si": "ඔබේ අවසන් රැකියාව කොතන කෙළාද සහ කොපමණ කාලයක් වැඩ කෙළාද?",
            "ta": "உங்கள் கடைசி employer யார், எவ்வளவு காலம் வேலை செய்தீர்கள்?",
            "singlish": "Oyage last employer kawda, kochchara kalayak weda kelada?",
            "tanglish": "Unga last employer yaaru, evvalo kaalam velai senjeenga?",
        }
        return prompts.get(lang, prompts["en"])

    def date_of_birth_prompt(self, lang: str) -> str:
        prompts = {
            "en": "What's your date of birth? (DD/MM/YYYY)",
            "si": "ඔබේ උපන් දිනය මොකක්ද? (DD/MM/YYYY)",
            "ta": "உங்கள் பிறந்த தேதி என்ன? (DD/MM/YYYY)",
            "singlish": "Oyage upan dinaya mokakda? (DD/MM/YYYY)",
            "tanglish": "Unga date of birth enna? (DD/MM/YYYY)",
        }
        return prompts.get(lang, prompts["en"])

    def generic_field_prompt(self, field: str, lang: str) -> str:
        """Fallback prompt when the per-job schema names a field we have no
        bespoke prompt for. Keeps the flow moving without breaking on schemas
        that add custom fields like `previous_visa_country`."""
        pretty = field.replace("_", " ").strip()
        prompts = {
            "en": f"Could you share your {pretty}?",
            "si": f"ඔබේ {pretty} කියන්න පුළුවන්ද?",
            "ta": f"உங்கள் {pretty} சொல்லுங்கள்.",
            "singlish": f"Oyage {pretty} eka kiyanna puluwanda?",
            "tanglish": f"Unga {pretty} sollunga.",
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Ad-driven job welcome (sent right after the candidate picks       #
    #  their language; names the specific job and asks for the name)    #
    # ------------------------------------------------------------------ #
    def job_welcome_prompt(self, lang: str, job_title: str, country: str = "") -> str:
        """Welcome message used after an ad click + language selection.

        Combines (a) brand acknowledgement, (b) explicit thank-you that names
        the exact job the candidate clicked, and (c) the first intake question
        (their name) — in one outgoing message so the flow stays tight.
        """
        job = (job_title or "this role").strip()
        loc = f" ({country})" if country else ""
        prompts = {
            "en": (
                f"🙏 Welcome to Dewan Consultants!\n\n"
                f"Thank you for showing interest in *{job}*{loc}. "
                f"We'd love to help you apply — it only takes a few minutes.\n\n"
                f"To get started, may I have your full name?"
            ),
            "si": (
                f"🙏 Dewan Consultants වෙත සාදරයෙන් පිළිගනිමු!\n\n"
                f"*{job}*{loc} රැකියාව ගැන උනන්දුව දැක්වීමට ස්තූතියි. "
                f"අයදුම්පත සම්පූර්ණ කරගන්න මිනිත්තු කිහිපයක් පමණයි.\n\n"
                f"පටන්ගන්න, කරුණාකර ඔබේ සම්පූර්ණ නම කියන්නද?"
            ),
            "ta": (
                f"🙏 Dewan Consultants-க்கு வரவேற்கிறோம்!\n\n"
                f"*{job}*{loc} வேலையில் ஆர்வம் காட்டியதற்கு நன்றி. "
                f"விண்ணப்பத்தை முடிக்க சில நிமிடங்களே ஆகும்.\n\n"
                f"தொடங்க, உங்கள் முழுப் பெயரை சொல்லுங்கள்?"
            ),
            "singlish": (
                f"🙏 Dewan Consultants-ta welcome!\n\n"
                f"*{job}*{loc} job ekata interest ekak penvanna sthuthi. "
                f"Application eka complete karanna minithu kihipayak vitharai yanne.\n\n"
                f"Patan ganna, oyage full name eka kiyanna da?"
            ),
            "tanglish": (
                f"🙏 Dewan Consultants-ku welcome!\n\n"
                f"*{job}*{loc} velai-la interest kaatinathuku nandri. "
                f"Application-a mudikka konjam neram thaan aagum.\n\n"
                f"Thodanga, unga full name enna?"
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Ad-flow completion message (after CV upload, before sync close)   #
    # ------------------------------------------------------------------ #
    def application_complete_prompt(
        self, lang: str, name: str, job_title: str
    ) -> str:
        nm = (name or "").strip() or "there"
        job = (job_title or "this role").strip()
        prompts = {
            "en": (
                f"✅ Thank you {nm}!\n\n"
                f"Your application for *{job}* has been submitted successfully. "
                f"Our recruitment team will WhatsApp you within 24–48 hours.\n\n"
                f"If you have any questions in the meantime, just message us here anytime. 🙏"
            ),
            "si": (
                f"✅ {nm}, ස්තූතියි!\n\n"
                f"*{job}* සඳහා ඔබේ අයදුම්පත සාර්ථකව ඉදිරිපත් කළා. "
                f"අපගේ recruitment කණ්ඩායම පැය 24–48ක් ඇතුළත WhatsApp මගින් සම්බන්ධ වෙයි.\n\n"
                f"ඊට කලින් කිසියම් ප්‍රශ්නයක් තිබේ නම් මෙතනින්ම message කරන්න. 🙏"
            ),
            "ta": (
                f"✅ நன்றி {nm}!\n\n"
                f"*{job}*-க்கான உங்கள் விண்ணப்பம் வெற்றிகரமாக சமர்ப்பிக்கப்பட்டது. "
                f"எங்கள் recruitment team 24–48 மணி நேரத்திற்குள் WhatsApp மூலம் தொடர்புகொள்வோம்.\n\n"
                f"இடையில் ஏதேனும் கேள்வி இருந்தால் இங்கேயே message செய்யுங்கள். 🙏"
            ),
            "singlish": (
                f"✅ Sthuthi {nm}!\n\n"
                f"*{job}* sandaha oyage application eka successfully submit kaala. "
                f"Ape recruitment team eka pay 24–48k athulata WhatsApp karaviya.\n\n"
                f"Eta kalin prashnayak tiyenavanam methaninma message karanna. 🙏"
            ),
            "tanglish": (
                f"✅ Nandri {nm}!\n\n"
                f"*{job}*-ku unga application successfully submit aachu. "
                f"Engal recruitment team 24–48 hours-la WhatsApp pannuvanga.\n\n"
                f"Idayil yedhavadhu question irundha ingaye message pannunga. 🙏"
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Helper: field → prompt dispatcher                                   #
    # ------------------------------------------------------------------ #
    def get_prompt_for_field(self, field: str, lang: str) -> str:
        """Return the deterministic prompt for a given missing field.

        Falls back to ``generic_field_prompt`` for any field name a job's
        ``required_fields_schema`` introduces that this agent doesn't yet
        have a bespoke prompt for, so unknown fields never break the flow.
        """
        dispatch = {
            "name": self.name_prompt,
            "job_role": self.job_role_prompt,
            "countries": self.country_prompt,
            "country": self.country_prompt,
            "age": self.age_prompt,
            "email": self.email_prompt,
            "experience_years": self.experience_prompt,
            "experience": self.experience_prompt,
            "cv": self.cv_prompt,
            "passport_number": self.passport_number_prompt,
            "passport_no": self.passport_number_prompt,
            "phone_alternative": self.phone_alternative_prompt,
            "alternative_phone": self.phone_alternative_prompt,
            "height": self.height_prompt,
            "height_cm": self.height_prompt,
            "licenses": self.licenses_prompt,
            "license": self.licenses_prompt,
            "nic": self.nic_prompt,
            "nic_no": self.nic_prompt,
            "english_proficiency": self.english_proficiency_prompt,
            "previous_employer": self.previous_employer_prompt,
            "date_of_birth": self.date_of_birth_prompt,
            "dob": self.date_of_birth_prompt,
        }
        fn = dispatch.get(field)
        if fn:
            return fn(lang)
        return self.generic_field_prompt(field, lang)


intake_agent = IntakeAgent()
