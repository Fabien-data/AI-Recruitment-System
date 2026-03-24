import re

files = ["app/llm/rag_engine.py", "app/services/vacancy_service.py"]
for f in files:
    with open(f, "r", encoding="utf-8") as file:
        lines = file.readlines()
    
    in_block = False
    for i in range(len(lines)):
        # Check if this line is the start of our injected block
        if "import json" in lines[i] and i+1 < len(lines) and "content = response.choices" in lines[i+1]:
            # Find the previous non-empty line
            prev_line_idx = i - 1
            while prev_line_idx >= 0 and not lines[prev_line_idx].strip():
                prev_line_idx -= 1
            
            if prev_line_idx >= 0:
                # Find the correct indentation
                correct_indent = len(lines[prev_line_idx]) - len(lines[prev_line_idx].lstrip())
                
                # Apply correct indentation to the next 7 lines (the whole block)
                for j in range(i, min(i+7, len(lines))):
                    if lines[j].strip():  # Don't indent completely empty lines
                        lines[j] = " " * correct_indent + lines[j].lstrip()
    
    with open(f, "w", encoding="utf-8") as file:
        file.writelines(lines)

print("Indentation perfectly aligned!")
