filepath = r'd:\Dewan Project\Chatbot\whatsapp-recruitment-bot\app\chatbot.py'
with open(filepath, encoding='utf-8') as f:
    content = f.read()

# Find _default_response
idx = content.find('    def _default_response(self, language: str) -> str:')
if idx == -1:
    # try new signature already applied
    idx = content.find('    def _default_response(self, db: Session, candidate) -> str:')
    if idx == -1:
        print('NOT FOUND - searching for any _default_response')
        idx2 = content.find('def _default_response')
        print(repr(content[idx2:idx2+200]))
        exit()
    else:
        print('Already has new signature, only adding _handle_confused_message if missing')

# Check if _handle_confused_message already exists
if '_handle_confused_message' in content:
    print('_handle_confused_message already in file')
    # Still need to fix _default_response signature if old
    if 'def _default_response(self, language: str)' in content:
        idx = content.find('    def _default_response(self, language: str) -> str:')

# Find end of _default_response method (next method at same indent)
end_idx = content.find('\n    def _error_response', idx)
if end_idx == -1:
    end_idx = content.find('\n    async def _error_response', idx)
if end_idx == -1:
    print('Could not find end of _default_response')
    # Print what's there
    print(repr(content[idx:idx+500]))
    exit()

old_method = content[idx:end_idx]
print('OLD method (first 300 chars):', repr(old_method[:300]))

new_method = (
    '    def _default_response(self, db, candidate) -> str:\n'
    '        """Response when there is no text and no media (empty/unsupported payload)."""\n'
    '        language = getattr(candidate.language_preference, "value", "en") if candidate.language_preference else "en"\n'
    "        opts = {\n"
    "            'en':       \"Sorry, I didn't get that. Could you send a text message or your CV? \U0001f60a\",\n"
    "            'si':       \"\u0db8\u0da7 \u0d91\u0d9a\u0dca \u0d9c\u0dad \u0db1\u0ddc\u0dc4\u0dd0\u0d9a\u0dd2 \u0dc0\u0dd4\u0dab\u0dcf. Text message \u0d91\u0d9a\u0d9a\u0dca CV \u0d91\u0d9a\u0d9a\u0dcf \u0dc2\u0dd9\u0dba\u0dcf\u0dbb\u0dca \u0d9a\u0dbb\u0db1\u0dca\u0db1 \u0db4\u0dd4\u0dbd\u0dd4\u0dc0\u0db1\u0dca\u0daf? \U0001f60a\",\n"
    "            'ta':       \"\u0baa\u0bc1\u0bb0\u0bbf\u0baf\u0bb5\u0bbf\u0bb2\u0bcd\u0bb2\u0bc8. Text message \u0b85\u0bb2\u0bcd\u0bb2\u0ba4\u0bc1 CV \u0b85\u0ba9\u0bc1\u0baa\u0bcd\u0baa\u0bb5\u0bc1\u0bae\u0bcd \U0001f60a\",\n"
    "            'singlish': \"Sorry da, didn't catch that. Can you send text message or your CV? \U0001f60a\",\n"
    "            'tanglish': \"Puriyala da, text message or CV anuppenga \U0001f60a\",\n"
    "        }\n"
    "        return opts.get(language, opts['en'])\n"
    "\n"
    "    async def _handle_confused_message(\n"
    "        self, db, candidate, text: str, language: str\n"
    "    ) -> str:\n"
    '        """\n'
    "        Tracks confusion_streak in extracted_data.\n"
    "        1st: RAG response only.\n"
    "        2nd: RAG + restart/redirect options.\n"
    "        3rd+: Hotline (last resort), then reset streak.\n"
    '        """\n'
    "        if text.strip().upper() in ('RESTART', 'RESET', 'START', 'START OVER'):\n"
    "            data = candidate.extracted_data or {}\n"
    "            data['confusion_streak'] = 0\n"
    "            candidate.extracted_data = data\n"
    "            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_LANGUAGE_SELECTION)\n"
    "            try:\n"
    "                db.commit()\n"
    "            except Exception:\n"
    "                pass\n"
    "            welcome = PromptTemplates.get_greeting('welcome', language, self.company_name)\n"
    "            lang_sel = PromptTemplates.get_language_selection()\n"
    "            return f\"{welcome}\\n\\n{lang_sel}\"\n"
    "\n"
    "        rag_resp = await self._generate_contextual_response(db, candidate, text, language)\n"
    "\n"
    "        data = candidate.extracted_data or {}\n"
    "        streak = int(data.get('confusion_streak', 0)) + 1\n"
    "        data['confusion_streak'] = streak\n"
    "        candidate.extracted_data = data\n"
    "        try:\n"
    "            db.commit()\n"
    "        except Exception:\n"
    "            pass\n"
    "\n"
    "        if streak <= 1:\n"
    "            return rag_resp\n"
    "\n"
    "        if streak == 2:\n"
    "            redirect = {\n"
    "                'en': (\n"
    "                    \"\\n\\n\U0001f4a1 *Not sure what to do?*\\n\"\n"
    "                    \"1\ufe0f\u20e3 Type *RESTART* for a fresh start\\n\"\n"
    "                    \"2\ufe0f\u20e3 Ask about job vacancies\\n\"\n"
    "                    \"3\ufe0f\u20e3 Just tell me a job role!\"\n"
    "                ),\n"
    "                'si': (\n"
    "                    \"\\n\\n\U0001f4a1 *\u0d9a\u0dd2\u0dc4\u0dd2\u0db4 \u0dc0\u0dd6\u0db1\u0dcf\u0daf?*\\n\"\n"
    "                    \"1\ufe0f\u20e3 *RESTART* \u2014 \u0db1\u0dc0\u0dad\u0dca \u0d86\u0dbb\u0db8\u0dca\u0db7\\n\"\n"
    "                    \"2\ufe0f\u20e3 \u0dbb\u0dd0\u0d9a\u0dd2\u0dba\u0dcf \u0d9c\u0dd9\u0db1 \u0d86\u0dbb\u0dca\u0da5\\n\"\n"
    "                    \"3\ufe0f\u20e3 \u0dbb\u0dd0\u0d9a\u0dd2\u0dba\u0dcf \u0db1\u0db8\u0d9a\u0dca!\"\n"
    "                ),\n"
    "                'ta': (\n"
    "                    \"\\n\\n\U0001f4a1 *\u0ba4\u0bc6\u0bb0\u0bbf\u0baf\u0bb5\u0bbf\u0bb2\u0bcd\u0bb2\u0bc8?*\\n\"\n"
    "                    \"1\ufe0f\u20e3 *RESTART* \u2014 \u0bae\u0bc1\u0ba4\u0bb2\u0bbf\u0bb2\u0bbf\u0bb0\u0bc1\\n\"\n"
    "                    \"2\ufe0f\u20e3 \u0bb5\u0bc7\u0bb2\u0bc8 \u0baa\u0bbe\u0bb0\u0bcd\\n\"\n"
    "                    \"3\ufe0f\u20e3 \u0baa\u0ba3\u0bbf\u0baf\u0bbf\u0ba9\u0bcd \u0baa\u0bc6\u0baf\u0bb0\u0bcd!\"\n"
    "                ),\n"
    "                'singlish': (\n"
    "                    \"\\n\\n\U0001f4a1 *Not sure da?*\\n\"\n"
    "                    \"1\ufe0f\u20e3 Type *RESTART* la\\n\"\n"
    "                    \"2\ufe0f\u20e3 Ask about vacancies\\n\"\n"
    "                    \"3\ufe0f\u20e3 Just say a job title!\"\n"
    "                ),\n"
    "                'tanglish': (\n"
    "                    \"\\n\\n\U0001f4a1 *Theriyala da?*\\n\"\n"
    "                    \"1\ufe0f\u20e3 *RESTART* type pannu\\n\"\n"
    "                    \"2\ufe0f\u20e3 Jobs paaru\\n\"\n"
    "                    \"3\ufe0f\u20e3 Enna job venumnnu sollu!\"\n"
    "                ),\n"
    "            }\n"
    "            return rag_resp + redirect.get(language, redirect['en'])\n"
    "\n"
    "        # streak >= 3: last resort hotline, reset streak\n"
    "        data['confusion_streak'] = 0\n"
    "        candidate.extracted_data = data\n"
    "        try:\n"
    "            db.commit()\n"
    "        except Exception:\n"
    "            pass\n"
    "        hotline = {\n"
    "            'en': (\n"
    "                \"I'm sorry I haven't been able to help. \U0001f64f\\n\"\n"
    "                \"Please reach our team directly:\\n\"\n"
    "                \"\U0001f4de *+94 11 234 5678* (Hotline)\\n\\n\"\n"
    "                \"Or type *RESTART* to try again!\"\n"
    "            ),\n"
    "            'si': (\n"
    "                \"\u0d9a\u0dc3\u0dca\u0dad\u0dd2\u0dba \u0dc3\u0db8\u0dcf\u0dc0\u0dd9\u0db1\u0dca. \U0001f64f\\n\"\n"
    "                \"\u0d85\u0db4\u0dda \u0d9a\u0dbb\u0dca\u0dba\u0dcf\u0dbd: \U0001f4de *+94 11 234 5678*\\n\\n\"\n"
    "                \"*RESTART* type \u0d9a\u0dbb\u0db1\u0dca\u0db1!\"\n"
    "            ),\n"
    "            'ta': (\n"
    "                \"\u0bae\u0ba9\u0bcd\u0ba9\u0bbf\u0b95\u0bcd\u0b95\u0bb5\u0bc1\u0bae\u0bcd. \U0001f64f\\n\"\n"
    "                \"\u0b8e\u0b99\u0bcd\u0b95\u0bb3\u0bcd \u0b95\u0bc1\u0bb4\u0bc1: \U0001f4de *+94 11 234 5678*\\n\\n\"\n"
    "                \"*RESTART* type \u0b9a\u0bc6\u0baf\u0bcd\u0ba4\u0bc1!\"\n"
    "            ),\n"
    "            'singlish': (\n"
    "                \"Sorry da. \U0001f64f\\n\"\n"
    "                \"Call our team: \U0001f4de *+94 11 234 5678*\\n\\n\"\n"
    "                \"Or type *RESTART* la!\"\n"
    "            ),\n"
    "            'tanglish': (\n"
    "                \"Sorry da. \U0001f64f\\n\"\n"
    "                \"Engal team: \U0001f4de *+94 11 234 5678*\\n\\n\"\n"
    "                \"Illa *RESTART* type panni!\"\n"
    "            ),\n"
    "        }\n"
    "        return hotline.get(language, hotline['en'])\n"
)

content = content[:idx] + new_method + content[end_idx:]
with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)
print('SUCCESS')
