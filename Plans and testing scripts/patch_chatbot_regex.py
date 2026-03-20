"""Patch chatbot.py -- update the three core intent regex patterns with Singlish/Tanglish vocabulary."""

with open('d:/Dewan Project/Chatbot/whatsapp-recruitment-bot/app/chatbot.py', encoding='utf-8') as f:
    content = f.read()

apply_start = content.find('_APPLY_RE = re.compile(')
q_end = content.find('\n)\n', content.find('_QUESTION_RE = re.compile(')) + 3

new_block = (
    "_APPLY_RE = re.compile(\n"
    "    r'\\b(yes|yeah|yep|yup|sure|ok|okay|apply|want to apply|interested|'\n"
    "    r'ready|let\\'?s go|start|begin|'\n"
    "    # Sinhala script\n"
    "    r'\u0d94\u0dc0\u0dca|\u0dc4\u0dbb\u0dd2|\u0d86\u0dc0|apply \u0d9a\u0dbb\u0db1\u0dca|\u0d9a\u0dd0\u0db8\u0dad\u0dd2\u0dba\u0dd2|\u0d95\u0db1\u0dd1|'\n"
    "    # Tamil script\n"
    "    r'\u0b86\u0bae\u0bcd|\u0b9a\u0bb0\u0bbf|\u0bb5\u0bbf\u0ba3\u0bcd\u0ba3\u0baa\u0bcd\u0baa\u0bbf\u0b95\u0bcd\u0b95|\u0b86\u0bb0\u0bcd\u0bb5\u0bae\u0bcd|'\n"
    "    # Singlish (romanized Sinhala) -- from word list\n"
    "    r'ow|hari|kemathi|honda|niyamai|puluwan|karanna|applay|'\n"
    "    r'apply karanna|wadeema hadanna|wadeema ganna|'\n"
    "    # Tanglish (romanized Tamil)\n"
    "    r'aama|seri|sari|aam|pannalaam|pogalam|pannuven|'\n"
    "    r'apply pannuren|apply panren|submit pannuren)\\b',\n"
    "    re.IGNORECASE\n"
    ")\n"
    "\n"
    "_NO_RE = re.compile(\n"
    "    r'\\b(no|nope|not now|later|maybe later|'\n"
    "    # Sinhala script\n"
    "    r'\u0db1\u0dd1|\u0d92 \u0db1\u0dd1|\u0d91\u0db4\u0dcf|'\n"
    "    # Tamil script\n"
    "    r'\u0b87\u0bb2\u0bcd\u0bb2\u0bc8|\u0bb5\u0bc7\u0ba3\u0bcd\u0b9f\u0bbe\u0bae\u0bcd|'\n"
    "    # Singlish\n"
    "    r'nehe|neha|epa|epaa|naha|behe|'\n"
    "    # Tanglish\n"
    "    r'illai|illada|illa|ille|venaam|vendaam|venam)\\b',\n"
    "    re.IGNORECASE\n"
    ")\n"
    "\n"
    "_QUESTION_RE = re.compile(\n"
    "    r'\\b(what|how|tell me|info|about|when|salary|visa|process|requirement|'\n"
    "    r'where|vacancy|job|position|benefit|'\n"
    "    # Tamil script\n"
    "    r'\u0bae\u0bcb\u0b95\u0ba8|'\n"
    "    # Sinhala script\n"
    "    r'\u0db8\u0ddc\u0d9a\u0daf|\u0d9a\u0ddc\u0dc4\u0ddc\u0db8\u0daf|\u0d9c\u0dd0\u0db1|'\n"
    "    # Singlish question words -- from word list\n"
    "    r'mokakda|mona|kohe|monawada|kohomada|kiyannada|'\n"
    "    # Tanglish question words\n"
    "    r'enna|yenna|epdi|eppo|evvalo|yaaru)\\b',\n"
    "    re.IGNORECASE\n"
    ")\n"
)

content = content[:apply_start] + new_block + content[q_end:]

with open('d:/Dewan Project/Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'w', encoding='utf-8') as f:
    f.write(content)

print("Done. Replaced regex blocks.")
print(f"apply_start={apply_start}, q_end={q_end}")
