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
                "What job role are you looking for? (e.g. Driver, Nurse, Cook, Mason, Electrician, Security Guard)"
            ),
            "si": (
                "දැන් Gulf රටවල urgent vacancies තිබෙනවා 🔥 "
                "ඔයාට ඕන job role eka mokakda? (Driver, Nurse, Cook, Mason, Electrician wage)"
            ),
            "ta": (
                "இப்போது Gulf நாடுகளில் urgent vacancies இருக்கு 🔥 "
                "நீங்கள் தேடும் job role என்ன? (Driver, Nurse, Cook, Mason, Electrician mathiri)"
            ),
            "singlish": (
                "Ipata Gulf ratawal urgent jobs tiyenawa 🔥 "
                "Oyata ona job role eka mokakda? (Driver, Nurse, Cook, Mason, Electrician wage)"
            ),
            "tanglish": (
                "Ippo Gulf naadugal-la urgent jobs irukku 🔥 "
                "Neenga thedra job role enna? (Driver, Nurse, Cook, Mason, Electrician mathiri)"
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
            "si": "Gulf vacancies ගොඩාක් 22–50 age range. ඔයාගේ වයස කොපමණද? (number eka vitharai kiyanna)",
            "ta": "Gulf vacancies பெரும்பாலும் 22–50 age range. உங்கள் வயது என்ன? (number மட்டும் சொன்னா போதும்)",
            "singlish": "Gulf jobs akka 22–50 age range wadi. Oyage wasaya kiyada? (number eka kiyanna puluwanda)",
            "tanglish": "Gulf jobs paartha 22–50 age range sarithaan. Unga vayasu enna? (number mattum sollunga)",
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
                "ඉතා ලඟ! 😊 WhatsApp number eka ගෙනගෙන ඉන්නවා. "
                "Job offers email කරන්න ඔයාගේ email address eka දෙනවද?"
            ),
            "ta": (
                "கிட்டத்தட்ட முடியும்! 😊 WhatsApp number ஒண்ணு இருக்கு. "
                "Job offers அனுப்ப உங்கள் email address என்ன?"
            ),
            "singlish": (
                "Almost done da! 😊 WhatsApp number eka tiyenawa. "
                "Job offers email karanna oyage email address eka denna puluwanda?"
            ),
            "tanglish": (
                "Almost done da! 😊 WhatsApp number kidaichuchu. "
                "Job offers anuppa unga email address enna?"
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Experience                                                          #
    # ------------------------------------------------------------------ #
    def experience_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Employers love experienced candidates 💪 How many years of experience do you have in this field?",
            "si": "Employers-ta experienced candidates gomara kamathi 💪 Meka genata kochchara avurudu experience thiyenawada?",
            "ta": "Employers-ku experienced candidates romba pudikkum 💪 Inga ungalukku evalo varusham experience irukku?",
            "singlish": "Employers-ta experienced eka gomara kamathi 💪 Oyata meka genata kochchara avurudu experience thiyenawada?",
            "tanglish": "Employers-ku experience ullavangala romba pudikkum 💪 Ungalukku inta field-la evvalo varudam experience irukku?",
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
                "It helps our recruiters match you to the best jobs faster 📄"
            ),
            "si": (
                "🎉 Profile eka ලෝකේ! Last step — "
                "ඔයාගේ CV eka upload කරන්න (PDF හෝ Word). "
                "Recruiters-ta ඔයාව best job ekata match කරන්න giyak wela yanawa 📄"
            ),
            "ta": (
                "🎉 Profile கிட்டத்தட்ட complete! Last step — "
                "உங்கள் CV upload பண்ணுங்கள் (PDF or Word). "
                "Recruiters உங்களுக்கு best job match பண்ண help ஆகும் 📄"
            ),
            "singlish": (
                "🎉 Profile eka aluth! Dan last step — "
                "oyage CV eka upload karanna (PDF atau Word). "
                "Recruiters-ta oyawa best job ekata match karanna puluwanda wenawa 📄"
            ),
            "tanglish": (
                "🎉 Profile almost complete da! Last step — "
                "unga CV upload pannunga (PDF or Word). "
                "Recruiters-ku best job match pannanum-na help aagum 📄"
            ),
        }
        return prompts.get(lang, prompts["en"])

    # ------------------------------------------------------------------ #
    #  Helper: field → prompt dispatcher                                   #
    # ------------------------------------------------------------------ #
    def get_prompt_for_field(self, field: str, lang: str) -> str:
        """Return the deterministic prompt for a given missing field."""
        dispatch = {
            "name": self.name_prompt,
            "job_role": self.job_role_prompt,
            "countries": self.country_prompt,
            "age": self.age_prompt,
            "email": self.email_prompt,
            "experience_years": self.experience_prompt,
            "cv": self.cv_prompt,
        }
        fn = dispatch.get(field)
        return fn(lang) if fn else ""


intake_agent = IntakeAgent()
