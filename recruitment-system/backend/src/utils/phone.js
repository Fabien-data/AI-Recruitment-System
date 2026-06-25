/**
 * Normalise any phone number to E.164 format (+XXXXXXXXXXX).
 * Returns null if the input cannot be reliably normalised.
 *
 * Handles:
 *   Sri Lanka: 0XXXXXXXXX (10 digits) → +94XXXXXXXXX
 *              94XXXXXXXXX (11 digits) → +94XXXXXXXXX
 *   Gulf + international: any number already in full E.164 format
 */
function normalizePhone(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');

    if (!digits) return null;

    // Sri Lanka local format: 0XXXXXXXXX (10 digits)
    if (digits.startsWith('0') && digits.length === 10) {
        return '+94' + digits.slice(1);
    }

    // Sri Lanka with country code: 94XXXXXXXXX (11 digits)
    if (digits.startsWith('94') && digits.length === 11) {
        return '+' + digits;
    }

    // Already has a leading +: return as-is
    if (String(raw).trim().startsWith('+') && digits.length >= 10 && digits.length <= 15) {
        return '+' + digits;
    }

    // Gulf / other international: 10–15 digit number without a leading zero
    if (!digits.startsWith('0') && digits.length >= 10 && digits.length <= 15) {
        return '+' + digits;
    }

    return null;
}

/**
 * Every equivalent STORED form of a number, most-canonical first, so a lookup
 * still matches rows written before normalisation existed:
 *   +94775774171  (E.164, canonical)
 *   94775774171   (no leading +, e.g. legacy wa_id-derived rows)
 *   0775774171    (Sri Lanka local form)
 * Derived from the NORMALISED number so a normalised "+94…" lookup still finds a
 * legacy "94…"/"0…" row. Returns [] when the input can't be normalised.
 */
function phoneVariants(raw) {
    const out = [];
    const add = (v) => { if (v && !out.includes(v)) out.push(v); };
    const norm = normalizePhone(raw);
    if (norm) {
        add(norm);
        add(norm.replace(/^\+/, ''));
        if (norm.startsWith('+94') && norm.length === 12) add('0' + norm.slice(3));
    }
    if (raw != null && String(raw).trim()) add(String(raw).trim());
    return out;
}

/**
 * Tolerant normaliser for messy spreadsheet/CSV cells (same intent as the
 * bulk-import parser): splits a cell that holds several numbers ("0771234567 /
 * 0712345678"), and re-adds a leading zero dropped by Excel number formatting on
 * 9-digit Sri Lankan mobiles ("766379024" → "0766379024"). Returns the first
 * segment that normalises to E.164, else null. The strict normalizePhone keeps
 * its contract for WhatsApp intake; this is only for bulk CSV ingestion.
 */
function parseLoosePhone(raw) {
    if (raw == null) return null;
    const segments = String(raw).split(/[/,;|\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
        const direct = normalizePhone(seg);
        if (direct) return direct;
        const d = seg.replace(/\D/g, '');
        if (d.length === 9) {
            const withZero = normalizePhone('0' + d);
            if (withZero) return withZero;
        }
    }
    return null;
}

module.exports = { normalizePhone, phoneVariants, parseLoosePhone };
