import re
import os

files = [
    "app/llm/rag_engine.py",
    "app/services/vacancy_service.py"
]

helper = """            import json
            content = response.choices[0].message.content.strip()
            if content.startswith("```json"): content = content[7:]
            elif content.startswith("```"): content = content[3:]
            if content.endswith("```"): content = content[:-3]
            content = content.strip()"""

pattern1 = r'import json\s+result = json\.loads\(response\.choices\[0\]\.message\.content\)'
repl1 = helper + '\n            result = json.loads(content)'

pattern2 = r'import json\s+data = json\.loads\(response\.choices\[0\]\.message\.content\)'
repl2 = helper + '\n            data = json.loads(content)'

pattern3 = r'import json\s+return json\.loads\(response\.choices\[0\]\.message\.content\)'
repl3 = helper + '\n            return json.loads(content)'

for fpath in files:
    with open(fpath, "r", encoding="utf-8") as f:
        code = f.read()
    
    code = re.sub(pattern1, repl1, code)
    code = re.sub(pattern2, repl2, code)
    code = re.sub(pattern3, repl3, code)
    
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(code)
        
print("JSON extraction fixed!")
