filepath = r"c:\Users\Tiran's PC\Documents\GitHub\AI-Recruitment-System\Chatbot\whatsapp-recruitment-bot\app\llm\prompt_templates.py"

with open(filepath, 'r', encoding='utf-8') as f:
    lines = f.readlines()

changed = 0
for i, line in enumerate(lines):
    if '\U0001f44d' in line and ('job_confirmed' not in line):
        # Replace the thumbs-up emoji with checkmark in-place
        new_line = line.replace('\U0001f44d', '\u2705')
        if new_line != line:
            print(f"  Line {i+1}: {line.rstrip()!r}")
            print(f"       -> {new_line.rstrip()!r}")
            lines[i] = new_line
            changed += 1

with open(filepath, 'w', encoding='utf-8') as f:
    f.writelines(lines)

print(f"\nDone — {changed} lines patched.")
