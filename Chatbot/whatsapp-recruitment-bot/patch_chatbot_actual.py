import re
import sys

def replace_block(content, start_marker, end_marker, replacement):
    start_idx = content.find(start_marker)
    if start_idx == -1: 
        print(f"Warning: {start_marker} not found")
        return content
    end_idx = content.find(end_marker, start_idx)
    if end_idx == -1: 
        print(f"Warning: {end_marker} not found")
        return content
    return content[:start_idx] + replacement + content[end_idx:]

with open('app/chatbot.py', 'r', encoding='utf-8') as f:
    content = f.read()

job_start = '        # ── AWAITING JOB INTEREST'
country_start = '        # ── AWAITING DESTINATION COUNTRY'
exp_start = '        # ── AWAITING EXPERIENCE'
cv_start = '        # ── AWAITING CV'
info_start = '        # ── COLLECTING MISSING INFO'

job_replacement = """        # ── AWAITING JOB INTEREST ─────────────────────────────────────────────
        elif state == self.STATE_AWAITING_JOB:
            # 1. Attempt Data Extraction
            active_countries_list = vacancy_service.get_active_countries()
            active_jobs_list = vacancy_service.get_active_job_titles()
            entities = await rag_engine.extract_entities_multilingual(
                text=text, language=language, active_countries=active_countries_list, active_jobs=active_jobs_list
            )
            target_data = entities.get("matched_crm_job") or entities.get("job_role")
            
            # 2. The Happy Path
            if target_data and len(target_data.strip()) >= 2:
                matched = self._match_job_from_text(target_data)
                job_interest_value = target_data
                if matched:
                    job_interest_value = (matched[1].get("title") or target_data)[:200]

                self._save_intake(db, candidate, 'job_interest', job_interest_value)
                
                _edata = candidate.extracted_data or {}
                if matched:
                    _edata["matched_job_id"] = matched[0]
                    _edata["job_requirements"] = dict(matched[1].get("requirements", {}))
                    _edata.pop("future_pool", None)
                candidate.extracted_data = _edata
                db.commit()

                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)

                ack = self._build_job_ack(job_interest_value, language)
                return self._country_buttons_payload(language, body_prefix=ack.strip())

            # 3. The Universal Catch-All
            else:
                takeover_reply = await rag_engine.generate_global_takeover(
                    user_message=text, 
                    current_state=candidate.conversation_state
                )
                if phone_number:
                    await meta_client.send_text(phone_number, takeover_reply)
                return ""

"""

country_replacement = """        # ── AWAITING DESTINATION COUNTRY ──────────────────────────────────────
        elif state == self.STATE_AWAITING_COUNTRY:
            # 1. Attempt Data Extraction
            entities = await rag_engine.extract_entities_multilingual(
                text=text, language=language, 
                active_countries=vacancy_service.get_active_countries(), 
                active_jobs=vacancy_service.get_active_job_titles()
            )
            target_data = entities.get("matched_crm_country") or entities.get("country")
            
            # 2. The Happy Path
            if target_data and len(target_data.strip()) >= 2:
                self._save_intake(db, candidate, 'destination_country', str(target_data))
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
                return self._experience_buttons_payload(language)

            # 3. The Universal Catch-All
            else:
                takeover_reply = await rag_engine.generate_global_takeover(
                    user_message=text, 
                    current_state=candidate.conversation_state
                )
                if phone_number:
                    await meta_client.send_text(phone_number, takeover_reply)
                return ""

"""

exp_replacement = """        # ── AWAITING EXPERIENCE ───────────────────────────────────────────────
        elif state == self.STATE_AWAITING_EXPERIENCE:
            # 1. Attempt Data Extraction
            entities = await rag_engine.extract_entities_multilingual(text=text, language=language)
            target_data = entities.get("experience_years")
            
            if not target_data:
                import re
                yrs = re.search(r'\d+', text)
                if yrs:
                    target_data = yrs.group()

            # 2. The Happy Path
            if target_data:
                self._save_intake(db, candidate, 'experience_years_stated', str(target_data))
                
                data = candidate.extracted_data or {}
                job_reqs = data.get("job_requirements", {})
                fields_to_ask = self._get_missing_req_fields(db, candidate, job_reqs)
                
                if fields_to_ask:
                    crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_JOB_REQS)
                    return self._get_next_intake_question(candidate, language)
                else:
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
                    return PromptTemplates.get_awaiting_cv_message(language, self.company_name)

            # 3. The Universal Catch-All
            else:
                takeover_reply = await rag_engine.generate_global_takeover(
                    user_message=text, 
                    current_state=candidate.conversation_state
                )
                if phone_number:
                    await meta_client.send_text(phone_number, takeover_reply)
                return ""

"""

# Handle AWAITING_CV. Wait, AWAITING_CV has other things like `_is_no_cv_message`, we will replace the `else` inside it.
# Actually I'm only modifying the 3 main ones as strictly ordered in the spec, or the fallback in CV if text.
# Let's replace only JOB, COUNTRY, EXP to strictly match the request and not break other flows.

content = replace_block(content, job_start, country_start, job_replacement)
content = replace_block(content, country_start, exp_start, country_replacement)
content = replace_block(content, exp_start, cv_start, exp_replacement)


# Write out the modified content
with open('app/chatbot.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("Patch applied successfully.")
