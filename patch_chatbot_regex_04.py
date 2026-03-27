import re

CHATBOT_PATH = r"c:\Users\Tiran's PC\Documents\GitHub\AI-Recruitment-System\Chatbot\whatsapp-recruitment-bot\app\chatbot.py"

with open(CHATBOT_PATH, "r", encoding="utf-8") as f:
    orig_content = f.read()

content = orig_content

job_pattern = re.compile(r"(elif state == self\.STATE_AWAITING_JOB:\n)(.*?)(\n\n\s*# \S+ AWAITING DESTINATION COUNTRY)", re.DOTALL)
new_job = """elif state == self.STATE_AWAITING_JOB:
            entities = await rag_engine.extract_entities_multilingual(
                text=text,
                language=language,
                active_countries=vacancy_service.get_active_countries(),
                active_jobs=vacancy_service.get_active_job_titles()
            )
            target_data = entities.get("job_interest")

            if target_data:
                extracted_job = target_data
                matched = self._match_job_from_text(str(extracted_job))

                job_interest_value = str(extracted_job)
                if matched:
                    job_id, job_info = matched
                    job_interest_value = (job_info.get("title") or extracted_job)[:200]
                
                self._save_intake(db, candidate, 'job_interest', job_interest_value)
                self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_JOB)
                
                _edata = candidate.extracted_data or {}
                _edata['confusion_streak'] = 0
                
                if matched:
                    job_id, job_info = matched
                    _edata["matched_job_id"] = job_id
                    req = job_info.get("requirements")
                    _edata["job_requirements"] = dict(req) if isinstance(req, dict) else {}
                    _edata.pop("future_pool", None)
                else:
                    if get_job_cache():
                        _edata["future_pool"] = True
                        _edata["future_pool_role"] = job_interest_value
                
                candidate.extracted_data = _edata
                db.commit()

                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)

                if not matched and get_job_cache():
                    j = job_interest_value.strip().title() if job_interest_value else "that role"
                    no_match_note = {
                        'en': f"Thank you for your interest! Unfortunately, we don't have a *{j}* position open right now. 📋",
                        'si': f"ඔබගේ ඇල්ම ගැන ස්තූතියි! අවාසනාවකට, දැනට *{j}* රැකියාවක් නොමැත. 📋",
                        'ta': f"உங்கள் ஆர்வத்திற்கு நன்றி! துரதிர்ஷ்டவசமாக, இப்போது *{j}* பதவி காலியில்லை. 📋",
                        'singlish': f"Oyagey interest gena thanks! But dang *{j}* job ekak naha. 📋",
                        'tanglish': f"Ungal aarvathukku nandri! Aanaa ippo *{j}* position kaali illa. 📋",
                    }
                    job_q = PromptTemplates.get_intake_question('job_interest', language)
                    reply = f"{no_match_note.get(language, no_match_note['en'])}\\n\\n{job_q}"
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
                    return reply

                ack = self._build_job_ack(job_interest_value, language)
                return self._country_buttons_payload(language, body_prefix=ack.strip())

            else:
                takeover_reply = await rag_engine.generate_global_takeover(
                    user_message=text,
                    current_state=state
                )
                return takeover_reply"""
content = job_pattern.sub(r"\1" + new_job.replace('\\n', '\n') + r"\3", content)

country_pattern = re.compile(r"(elif state == self\.STATE_AWAITING_COUNTRY:\n)(.*?)(\n\n\s*# \S+ AWAITING JOB SELECTION)", re.DOTALL)
new_country = """elif state == self.STATE_AWAITING_COUNTRY:
            entities = await rag_engine.extract_entities_multilingual(
                text=text,
                language=language,
                active_countries=vacancy_service.get_active_countries(),
                active_jobs=vacancy_service.get_active_job_titles()
            )
            target_data = entities.get("matched_crm_country") or entities.get("country")
            if not target_data:
                # Basic strict dictionary fallback
                text_norm = _normalize_text(text)
                for key, val in _COUNTRY_MASTER_MAP.items():
                    if key in text_norm:
                        target_data = val
                        break

            if target_data:
                extracted_country = str(target_data)
                self._save_intake(db, candidate, 'destination_country', extracted_country)
                self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_COUNTRY)
                
                _edata = candidate.extracted_data or {}
                _edata['confusion_streak'] = 0
                candidate.extracted_data = _edata

                data = candidate.extracted_data or {}
                job_interest = str(data.get('job_interest') or '').strip()
                matching_jobs = await vacancy_service.get_matching_jobs(
                    job_interest=job_interest,
                    country=str(extracted_country),
                    limit=3,
                )

                fallback_msg_str = ""

                if matching_jobs:
                    data['presented_jobs'] = [str(job.get('id') or '') for job in matching_jobs[:3] if str(job.get('id') or '').strip()]
                    data['presented_job_cards'] = matching_jobs[:3]
                    candidate.extracted_data = data
                    db.commit()

                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB_SELECTION)
                    ack = self._build_country_ack(str(extracted_country), language)
                    jobs_count = len(matching_jobs)

                    if extracted_country == 'ANY':
                        list_intro = {
                            'en': f"Great! Since you are flexible, I looked at all our global locations and found {jobs_count} vacancies for {job_interest or 'your role'}.",
                            'si': f"නියමයි! ඔබ ඕනෑම රටකට කැමති නිසා ලොව පුරා {job_interest or 'ඔබගේ රැකියා භූමිකාව'} සඳහා පුරප්පාඩු {jobs_count} ක් මට හමුවුණා.",
                            'ta': "சிறப்பு! நீங்கள் எந்த நாடானாலும் சரி என்று கூறியதால், உலகம் முழுவதும் " + (job_interest or 'உங்கள் வேலை') + f"-க்காக {jobs_count} வேலைவாய்ப்புகளை நாடியுள்ளோம்.",
                            'singlish': f"Niyamai! Oya flexible nisa mama loke wate balala {job_interest or 'oya balana role eka'} vacancies {jobs_count} k hoyagaththa.",
                            'tanglish': f"Super! Neenga flexible nu sonnadhala, global-a thedi {job_interest or 'neenga paakura role'} kku {jobs_count} vacancies kandu pudichiruken.",
                        }.get(language, f"Great! Since you are flexible, I looked at all our global locations and found {jobs_count} vacancies for {job_interest or 'your role'}.")
                    else:
                        list_intro = {
                            'en': f"Congratulations! 🎉 I found {jobs_count} vacancies for {job_interest or 'your role'} in {extracted_country}.",
                            'si': f"සුබ පැතුම්! 🎉 {extracted_country} හි {job_interest or 'ඔබගේ රැකියා භූමිකාව'} සඳහා පුරප්පාඩු {jobs_count} ක් මට හමුවුණා.",
                            'ta': f"வாழ்த்துக்கள்! 🎉 {extracted_country}-ல் {job_interest or 'உங்கள் வேலை பங்கு'} பணிக்கான {jobs_count} வேலைவாய்ப்புகள் உள்ளன.",
                            'singlish': f"Niyamai! 🎉 {extracted_country} wala {job_interest or 'oya balana role eka'} vacancies {jobs_count} k thiyenawa.",
                            'tanglish': f"Super! 🎉 {extracted_country}-la {job_interest or 'neenga paakura role'} kku {jobs_count} vacancies irukku.",
                        }.get(language, f"Congratulations! 🎉 I found {jobs_count} vacancies for {job_interest or 'your role'} in {extracted_country}.")
                    
                    rows = []
                    for i, job in enumerate(data.get('presented_job_cards', [])[:3]):
                        title = job.get('title') or 'Job'
                        location = str(job.get('country') or extracted_country)
                        salary = job.get('salary') or ''
                        row_title = f"{title} ({location})"[:24]
                        row_desc = (salary if salary else job.get('description', ''))[:72]
                        rows.append({
                            "id": f"job_{i}",
                            "title": row_title,
                            "description": row_desc
                        })

                    skip_title = {
                        'en': "Skip & Join Pool",
                        'si': "Skip කර Pool එකට යන්න",
                        'ta': "Skip செந்து Pool-ல் சேர்",
                        'singlish': "Skip - General Pool",
                        'tanglish': "Skip - General Pool"
                    }.get(language, "Skip & Join Pool")[:24]

                    rows.append({
                        "id": "skip",
                        "title": skip_title,
                        "description": "Don't select any specific job"[:72]
                    })

                    button_label = {
                        'en': "View Jobs",
                        'si': "රැකියා බලන්න",
                        'ta': "வேலைகளைப் பார்",
                        'singlish': "Jobs Balanna",
                        'tanglish': "Jobs Paarkavum"
                    }.get(language, "View Jobs")[:20]

                    return {
                        "type": "list",
                        "body_text": f"{fallback_msg_str}{list_intro}\\n\\n{ack}",
                        "button_label": button_label,
                        "sections": [
                            {
                                "title": "Available Vacancies"[:24],
                                "rows": rows
                            }
                        ]
                    }

                has_exp = candidate.experience_years or data.get('experience_years_stated')
                next_state = self.STATE_AWAITING_CV if has_exp else self.STATE_AWAITING_EXPERIENCE
                crud.update_candidate_state(db, candidate.id, next_state)

                pool_msg = {
                    'en': f"Currently, we don't have open positions for {job_interest or 'that role'} in {extracted_country}, but we frequently get new openings! Let's get your profile ready so we can contact you immediately when one opens up.",
                    'si': f"දැනට {extracted_country} හි {job_interest or 'එම රැකියා භූමිකාව'} සඳහා පුරප්පාඩු නොමැත, නමුත් අනාගතයේදී පැමිණිය හැක! ඔබගේ තොරතුරු ලබා දෙන්න.",
                    'ta': f"தற்போது {extracted_country}-ல் {job_interest or 'அந்த வேலை பங்கு'} வேலைகள் இல்லை, ஆனால் விரைவில் வரலாம்! உங்கள் விவரங்களை பதிவு செய்வோம்.",
                    'singlish': f"Danata {extracted_country} wala {job_interest or 'e role eka'} vacancies naha, eth aluth ewa enawa! Api profile eka hadala thiyagamu.",
                    'tanglish': f"Ippo {extracted_country}-la {job_interest or 'andha role'} vacancies illa, aana future-la varum! Profile-a ready pannuvom.",
                }

                if extracted_country == 'ANY':
                    pool_msg = {
                        'en': f"Currently, we don't have open positions for {job_interest or 'that role'} anywhere, but we frequently get new openings! Let's get your profile ready so we can contact you immediately when one opens up.",
                        'si': f"දැනට {job_interest or 'එම රැකියා භූමිකාව'} සඳහා ලොව පුරා පුරප්පාඩු නොමැත, නමුත් අනාගතයේදී පැමිණිය හැක! ඔබගේ තොරතුරු ලබා දෙන්න.",
                        'ta': f"தற்போது {job_interest or 'அந்த வேலை பங்கு'} எங்கும் இல்லை, ஆனால் விரைவில் வரலாம்! உங்கள் விவரங்களை பதிவு செய்வோம்.",
                        'singlish': f"Danata {job_interest or 'e role eka'} global vacancies naha, eth aluth ewa enawa! Api profile eka hadala thiyagamu.",
                        'tanglish': f"Ippo {job_interest or 'andha role'} global vacancies illa, aana future-la varum! Profile-a ready pannuvom.",
                    }

                next_q = PromptTemplates.get_intake_question('cv_upload' if has_exp else 'experience_years', language)
                reply_text = f"{pool_msg.get(language, pool_msg['en'])}\\n\\n{next_q}"
                if has_exp:
                    return f"{fallback_msg_str}{reply_text}"
                button_payload = self._experience_buttons_payload(language)
                button_payload["body_text"] = f"{fallback_msg_str}{pool_msg.get(language, pool_msg['en'])}\\n\\n{button_payload.get('body_text', '')}".strip()
                return button_payload

            else:
                takeover_reply = await rag_engine.generate_global_takeover(
                    user_message=text,
                    current_state=state
                )
                return takeover_reply"""
content = country_pattern.sub(r"\1" + new_country.replace('\\n', '\n') + r"\3", content)

experience_pattern = re.compile(r"(elif state == self\.STATE_AWAITING_EXPERIENCE:\n)(.*?)(\n\n\s*# \S+ COLLECTING SPECIFIC)", re.DOTALL)
new_experience = """elif state == self.STATE_AWAITING_EXPERIENCE:
            entities = await rag_engine.extract_entities_multilingual(
                text=text,
                language=language,
                active_countries=vacancy_service.get_active_countries(),
                active_jobs=vacancy_service.get_active_job_titles()
            )
            target_data = entities.get("experience_years")
            
            # fallback numeric extract
            if target_data is None:
                years = _extract_years(text)
                if years is not None:
                    target_data = years

            if target_data is not None:
                extracted_exp = target_data
                years = _extract_years(str(extracted_exp))
                value = str(years) if years is not None else str(extracted_exp)
                
                self._save_intake(db, candidate, 'experience_years_stated', value)
                self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_EXPERIENCE)
                
                _edata = candidate.extracted_data or {}
                _edata['confusion_streak'] = 0
                candidate.extracted_data = _edata
                if hasattr(candidate, "confusion_streak"):
                    candidate.confusion_streak = 0
                if years is not None:
                    candidate.experience_years = years
                    db.commit()

                ack = self._build_experience_ack(years, str(extracted_exp), language)
                
                reqs = (candidate.extracted_data or {}).get("job_requirements", {})
                specific_info = list(reqs.get("specific_info_to_ask", []))

                auto_fields = []
                if reqs.get("min_age") and "age" not in specific_info:
                    auto_fields.append("age")
                if reqs.get("min_height_cm") and "height_cm" not in specific_info:
                    auto_fields.append("height_cm")
                if reqs.get("licenses") and "licenses" not in specific_info:
                    auto_fields.append("licenses")
                if reqs.get("required_languages") and "languages_spoken" not in specific_info:
                    auto_fields.append("languages_spoken")
                specific_info = auto_fields + specific_info

                if not specific_info:
                    job_interest = (candidate.extracted_data or {}).get('job_interest', '')
                    job_category = ""
                    matched_id = (candidate.extracted_data or {}).get('matched_job_id', '')
                    if matched_id:
                        _cache = get_job_cache()
                        job_category = (_cache.get(str(matched_id), {}) or {}).get('category', '')
                    specific_info = self._get_default_role_questions(job_interest, job_category)
                
                if specific_info:
                    data = candidate.extracted_data or {}
                    data["pending_job_reqs"] = specific_info
                    data["collected_job_reqs"] = {}
                    crud.update_candidate(db, candidate.id, CandidateUpdate(extracted_data=data))
                    crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_JOB_REQS)
                    
                    first_req = specific_info[0]
                    q = await rag_engine.generate_missing_field_question_async(first_req, language)
                    return f"{ack}\\n\\n{q}"

                early_result = await self._process_early_cv(db, candidate, f"{ack}\\n\\n")
                if early_result:
                    return early_result
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
                cv_q = PromptTemplates.get_intake_question('cv_upload', language)
                return f"{ack}\\n\\n{cv_q}"

            else:
                takeover_reply = await rag_engine.generate_global_takeover(
                    user_message=text,
                    current_state=state
                )
                return takeover_reply"""
content = experience_pattern.sub(r"\1" + new_experience.replace('\\n', '\n') + r"\3", content)

with open(CHATBOT_PATH, "w", encoding="utf-8") as f:
    f.write(content)

if content == orig_content:
    print("NO CHANGES MADE. Regex mismatch.")
else:
    print("Patch applied successfully.")
