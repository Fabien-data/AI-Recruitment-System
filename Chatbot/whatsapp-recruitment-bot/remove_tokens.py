import os
import re

files = [
    "app/services/vacancy_service.py",
    "app/llm/rag_engine.py",
    "app/cv_parser/ocr_engine.py",
    "app/cv_parser/intelligent_extractor.py"
]

# Match max_completion_tokens=XX, optionally followed by a comma, spaces, comments, and newline
# Or maybe it's just `max_completion_tokens=XX` at the end of the line
pattern = re.compile(r'^[ \t]*max_completion_tokens=\d+(?: if [^,]+ else \d+)?,?[ \t]*(?:#.*)?\n', re.MULTILINE)

# Some lines have: `max_completion_tokens=150 if language not in ('en',) else 100,`
# Let's use a more robust regex that just kills lines starting with max_completion_tokens
pattern2 = re.compile(r'^[ \t]*max_completion_tokens=.*?\n', re.MULTILINE)

for fpath in files:
    with open(fpath, "r", encoding="utf-8") as f:
        content = f.read()
    
    new_content = pattern2.sub('', content)
    
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(new_content)
    
    print(f"Cleaned {fpath}")

