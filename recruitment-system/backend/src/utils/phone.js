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

module.exports = { normalizePhone };
