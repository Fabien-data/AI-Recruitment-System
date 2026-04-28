filepath = r"c:\Users\Tiran's PC\Documents\GitHub\AI-Recruitment-System\Chatbot\whatsapp-recruitment-bot\app\llm\prompt_templates.py"

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

replacements = [
    ('"Great choice! \U0001f44d "',          '"Great choice! \u2705 "'),
    ('"Good choice da! \U0001f44d "',         '"Good choice! \u2705 "'),
    ('"Nalla choice da! \U0001f44d "',        '"Nalla choice! \u2705 "'),
    ('"\u0d89\u0dad\u0dcf \u0dc4\u0ddc\u0daf \u0dad\u0dda\u0dbb\u0dd3\u0db8\u0d9a\u0dca! \U0001f44d "',   '"\u0d89\u0dad\u0dcf \u0dc4\u0ddc\u0daf \u0dad\u0dda\u0dbb\u0dd3\u0db8\u0d9a\u0dca! \u2705 "'),
    ('"\u0b9a\u0bbf\u0bb1\u0ba8\u0bcd\u0ba4 \u0ba4\u0bc7\u0bb0\u0bcd\u0bb5\u0bc1! \U0001f44d "',           '"\u0b9a\u0bbf\u0bb1\u0ba8\u0bcd\u0ba4 \u0ba4\u0bc7\u0bb0\u0bcd\u0bb5\u0bc1! \u2705 "'),
    ('"Excellent \u2014 employers will like that! \U0001f44d "', '"Excellent \u2014 employers will value that! \u2705 "'),
    ('"\u0dc0\u0dd2\u0dc1\u0dd2\u0dc2\u0dca\u0da7\u0dba\u0dd2 \u2014 \u0dc3\u0dda\u0dc0\u0dcf \u0dba\u0ddc\u0da1\u0d9a\u0dba\u0dd2\u0db1\u0dca \u0db8\u0dd3\u0da7 \u0db6\u0ddc\u0dc4\u0ddd \u0d9a\u0dd0\u0db8\u0dad\u0dd2 \u0dc0\u0dda\u0dc0\u0dd2! \U0001f44d "',
     '"\u0dc0\u0dd2\u0dc1\u0dd2\u0dc2\u0dca\u0da7\u0dba\u0dd2 \u2014 \u0dc3\u0dda\u0dc0\u0dcf \u0dba\u0ddc\u0da1\u0d9a\u0dba\u0dd2\u0db1\u0dca \u0d94\u0db6\u0dda \u0db4\u0dbd\u0db4\u0dd4\u0dbb\u0dd4\u0daf\u0dca\u0daf \u0d89\u0dc4\u0dbd\u0dcf \u0d85\u0d9c\u0dba \u0d9a\u0dbb\u0db1\u0dd4 \u0d87\u0dad\u0dca! \u2705 "'),
    ('"\u0b85\u0bb0\u0bc1\u0bae\u0bc8 \u2014 \u0ba8\u0bbf\u0bb1\u0bc1\u0bb5\u0ba9\u0b99\u0bcd\u0b95\u0bb3\u0bcd \u0b87\u0ba4\u0ba9\u0bc8 \u0bae\u0bbf\u0b95\u0bb5\u0bc1\u0bae\u0bcd \u0bb5\u0bbf\u0bb0\u0bc1\u0bae\u0bcd\u0baa\u0bc1\u0bb5\u0bbe\u0bb0\u0bcd\u0b95\u0bb3\u0bcd! \U0001f44d "',
     '"\u0b85\u0bb0\u0bc1\u0bae\u0bc8 \u2014 \u0ba8\u0bbf\u0bb1\u0bc1\u0bb5\u0ba9\u0b99\u0bcd\u0b95\u0bb3\u0bcd \u0b89\u0b99\u0bcd\u0b95\u0bb3\u0bcd \u0b85\u0ba9\u0bc1\u0baa\u0bb5\u0ba4\u0bcd\u0ba4\u0bc8 \u0bae\u0ba4\u0bbf\u0baa\u0bcd\u0baa\u0bbf\u0b9f\u0bc1\u0bb5\u0bbe\u0bb0\u0bcd\u0b95\u0bb3\u0bcd! \u2705 "'),
    ('"Employers will love that da! \U0001f44d "', '"Employers will value that! \u2705 "'),
    ('"Companies-ku romba pudikkum \u2014 great! \U0001f44d "', '"Companies-ku romba pudikkum \u2014 excellent! \u2705 "'),
]

count = 0
for old, new in replacements:
    if old in content:
        content = content.replace(old, new, 1)
        count += 1
        print(f"  REPLACED: {repr(old[:50])}")
    else:
        print(f"  NOT FOUND: {repr(old[:50])}")

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\nDone — {count}/{len(replacements)} replacements applied.")
