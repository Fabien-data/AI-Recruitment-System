import ast
with open('app/chatbot.py', 'r', encoding='utf-8') as f:
    code = f.read()
tree = ast.parse(code)
chatbot_class = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'RecruitmentChatbot')
method = next(n for n in chatbot_class.body if isinstance(n, ast.AsyncFunctionDef) and n.name == '_handle_cv_upload')
lines = code.split('\n')
print('\n'.join(lines[method.end_lineno-20:method.end_lineno+1]))
