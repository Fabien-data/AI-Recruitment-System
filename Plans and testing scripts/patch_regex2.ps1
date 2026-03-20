# patch_regex2.ps1 — Replace _APPLY_RE and _QUESTION_RE in chatbot.py

$f = "d:\Dewan Project\Chatbot\whatsapp-recruitment-bot\app\chatbot.py"
$text = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)

$nl = "`r`n"

# Sinhala chars
$si_ow    = [char]0x0D94 + [char]0x0DC0 + [char]0x0DCA
$si_hari  = [char]0x0DC4 + [char]0x0DBB + [char]0x0DD2
$si_awa   = [char]0x0D86 + [char]0x0DC0
$si_apply = "apply " + [char]0x0D9A + [char]0x0DBB + [char]0x0DB1 + [char]0x0DCA
$si_kem   = [char]0x0D9A + [char]0x0DD0 + [char]0x0DB8 + [char]0x0DAD + [char]0x0DD2 + [char]0x0DBA + [char]0x0DD2
$si_one   = [char]0x0D95 + [char]0x0DB1 + [char]0x0DD1
$si_q1    = [char]0x0DB8 + [char]0x0DDC + [char]0x0D9A + [char]0x0DAF
$si_q2    = [char]0x0D9A + [char]0x0DDC + [char]0x0DC4 + [char]0x0DDC + [char]0x0DB8 + [char]0x0DAF
$si_q3    = [char]0x0D9C + [char]0x0DD0 + [char]0x0DB1

# Tamil chars
$ta_yes   = [char]0x0B86 + [char]0x0BAE + [char]0x0BCD
$ta_sari  = [char]0x0B9A + [char]0x0BB0 + [char]0x0BBF
$ta_apply = [char]0x0BB5 + [char]0x0BBF + [char]0x0BA3 + [char]0x0BCD + [char]0x0BA3 + [char]0x0BAA + [char]0x0BCD + [char]0x0BAA + [char]0x0BBF + [char]0x0B95 + [char]0x0BCD + [char]0x0B95
$ta_int   = [char]0x0B86 + [char]0x0BB0 + [char]0x0BCD + [char]0x0BB5 + [char]0x0BAE + [char]0x0BCD
$ta_q     = [char]0x0BAE + [char]0x0BCB + [char]0x0B95 + [char]0x0BA8

# ── _APPLY_RE ────────────────────────────────────────────────────────────────
$oldApply = "_APPLY_RE = re.compile(" + $nl +
"    r'\b(yes|yeah|yep|yup|sure|ok|okay|apply|want to apply|interested|'" + $nl +
"    r'ready|let\'?s go|start|begin|'" + $nl +
"    r'" + $si_ow + "|" + $si_hari + "|" + $si_awa + "|" + $si_apply + "|'" + $nl +
"    r'" + $ta_yes + "|" + $ta_sari + "|" + $ta_apply + "|" + $ta_int + ")\b'," + $nl +
"    re.IGNORECASE" + $nl +
")"

$newApply = "_APPLY_RE = re.compile(" + $nl +
"    r'\b(yes|yeah|yep|yup|sure|ok|okay|apply|want to apply|interested|'" + $nl +
"    r'ready|let\'?s go|start|begin|'" + $nl +
"    # Sinhala script" + $nl +
"    r'" + $si_ow + "|" + $si_hari + "|" + $si_awa + "|" + $si_apply + "|" + $si_kem + "|" + $si_one + "|'" + $nl +
"    # Tamil script" + $nl +
"    r'" + $ta_yes + "|" + $ta_sari + "|" + $ta_apply + "|" + $ta_int + "|'" + $nl +
"    # Singlish (romanized Sinhala) -- from word list" + $nl +
"    r'ow|hari|kemathi|honda|niyamai|puluwan|karanna|applay|'" + $nl +
"    r'apply karanna|wadeema hadanna|wadeema ganna|'" + $nl +
"    # Tanglish (romanized Tamil)" + $nl +
"    r'aama|seri|sari|aam|pannalaam|pogalam|pannuven|'" + $nl +
"    r'apply pannuren|apply panren|submit pannuren)\b'," + $nl +
"    re.IGNORECASE" + $nl +
")"

# ── _QUESTION_RE ─────────────────────────────────────────────────────────────
$oldQ = "_QUESTION_RE = re.compile(" + $nl +
"    r'\b(what|how|tell me|info|about|when|salary|visa|process|requirement|'" + $nl +
"    r'where|vacancy|job|position|benefit|" + $ta_q + "|'" + $nl +
"    r'" + $si_q1 + "|" + $si_q2 + "|" + $si_q3 + "|salary|visa)\b'," + $nl +
"    re.IGNORECASE" + $nl +
")"

$newQ = "_QUESTION_RE = re.compile(" + $nl +
"    r'\b(what|how|tell me|info|about|when|salary|visa|process|requirement|'" + $nl +
"    r'where|vacancy|job|position|benefit|'" + $nl +
"    # Tamil script" + $nl +
"    r'" + $ta_q + "|'" + $nl +
"    # Sinhala script" + $nl +
"    r'" + $si_q1 + "|" + $si_q2 + "|" + $si_q3 + "|'" + $nl +
"    # Singlish question words -- from word list" + $nl +
"    r'mokakda|mona|kohe|monawada|kohomada|kiyannada|'" + $nl +
"    # Tanglish question words" + $nl +
"    r'enna|yenna|epdi|eppo|evvalo|yaaru)\b'," + $nl +
"    re.IGNORECASE" + $nl +
")"

Write-Host "Apply match: $($text.Contains($oldApply))"
Write-Host "Q match:     $($text.Contains($oldQ))"

if ($text.Contains($oldApply)) {
    $text = $text.Replace($oldApply, $newApply)
    Write-Host "Replaced _APPLY_RE"
} else {
    Write-Host "WARNING: _APPLY_RE old block not found"
}

if ($text.Contains($oldQ)) {
    $text = $text.Replace($oldQ, $newQ)
    Write-Host "Replaced _QUESTION_RE"
} else {
    Write-Host "WARNING: _QUESTION_RE old block not found"
}

[System.IO.File]::WriteAllText($f, $text, [System.Text.Encoding]::UTF8)
Write-Host "Done."
