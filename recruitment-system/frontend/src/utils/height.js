// Height conversion helpers. The canonical stored value is always an integer
// number of centimetres (candidate.height_cm / metadata.height_cm). These let
// the UI accept and display either centimetres or feet/inches interchangeably.

const CM_PER_INCH = 2.54

/** cm → { feet, inches } (inches rounded to the nearest whole inch). Null when invalid/empty. */
export function cmToFeetInches(cm) {
  const n = Number(cm)
  if (!Number.isFinite(n) || n <= 0) return null
  const totalInches = Math.round(n / CM_PER_INCH)
  return { feet: Math.floor(totalInches / 12), inches: totalInches % 12 }
}

/** feet + inches → cm (rounded to nearest whole cm). Null when both are empty/zero. */
export function feetInchesToCm(feet, inches) {
  const f = Number(feet) || 0
  const i = Number(inches) || 0
  if (f <= 0 && i <= 0) return null
  return Math.round((f * 12 + i) * CM_PER_INCH)
}

/** cm → `5'7"` string. Null when invalid/empty. */
export function formatFeetInches(cm) {
  const r = cmToFeetInches(cm)
  return r ? `${r.feet}'${r.inches}"` : null
}

/** cm → `170 cm · 5'7"` for read-only display. Null when invalid/empty. */
export function formatHeight(cm) {
  const n = Number(cm)
  if (!Number.isFinite(n) || n <= 0) return null
  const fi = formatFeetInches(n)
  return fi ? `${n} cm · ${fi}` : `${n} cm`
}
