import os
import re

files = [
    "app/services/vacancy_service.py",
    "app/llm/rag_engine.py",
    "app/cv_parser/ocr_engine.py",
    "app/cv_parser/intelligent_extractor.py"
]

pattern = re.compile(r'^[ \t]*temperature=\d+(?:\.\d+)?,?[ \t]*(?:#.*)?\n', re.MULTILINE)

for fpath in files:
    with open(fpath, "r", encoding="utf-8") as f:
        content = f.read()
    
    new_content = pattern.sub('', content)
    
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(new_content)
    
    print(f"Cleaned {fpath}")

