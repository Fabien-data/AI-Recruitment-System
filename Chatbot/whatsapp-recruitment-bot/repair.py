import re

files = [
    "app/llm/rag_engine.py",
    "app/services/vacancy_service.py"
]

pattern = re.compile(
r'([ \t]+)import json\n[ \t]+content = response\.choices\[0\]\.message\.content\.strip\(\)\n[ \t]+if content\.startswith\("```json"\): content = content\[7:\]\n[ \t]+elif content\.startswith\("```"\): content = content\[3:\]\n[ \t]+if content\.endswith\("```"\): content = content\[:-3\]\n[ \t]+content = content\.strip\(\)\n[ \t]+(return json\.loads\(content\)|result = json\.loads\(content\)|data = json\.loads\(content\))'
)

for fpath in files:
    with open(fpath, "r", encoding="utf-8") as f:
        code = f.read()

    def repl(m):
        ind = m.group(1)
        var = m.group(2)
        return (f"{ind}import json\n"
                f"{ind}content = response.choices[0].message.content.strip()\n"
                f"{ind}if content.startswith('```json'): content = content[7:]\n"
                f"{ind}elif content.startswith('```'): content = content[3:]\n"
                f"{ind}if content.endswith('```'): content = content[:-3]\n"
                f"{ind}content = content.strip()\n"
                f"{ind}{var}")

    new_code = pattern.sub(repl, code)
    
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(new_code)
print("Repaired!")
