// Interview / scheduled date-time formatting.
//
// Interview datetimes are a *literal Asia/Colombo wall-clock* — the exact time the
// recruiter typed in the schedule panel — NOT a UTC instant. The API may hand them
// back as a naive string ("2026-06-10T14:30") or, because the column is a tz-naive
// TIMESTAMP that gets re-stamped with "Z" on the way out, as "2026-06-10T14:30:00.000Z".
// Either way the literal HH:mm IS the intended local time, so we must render those
// exact components and never let `new Date()` apply a browser-timezone shift (which
// pushed the dashboard +5:30 out of sync with what the candidate actually received).
//
// These helpers read Y/M/D/H/M straight off the value and format them in UTC so the
// numbers echo back unchanged. Use them for interview_datetime / scheduled_datetime /
// prescreening_datetime ONLY — genuine instants like created_at must keep normal
// local-timezone rendering.

function toWallClockDate(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  const m = String(value).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  if (m) {
    // Place literal components in the UTC slot; format in UTC echoes them back.
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

const FULL_OPTS = {
  weekday: 'short', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
}

const TIME_OPTS = { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }

const DATE_OPTS = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }

/** "Wed, Jun 10, 02:30 PM" — full interview date + time. */
export function formatInterviewDateTime(value, fallback = '—') {
  const d = toWallClockDate(value)
  if (!d) return fallback
  return d.toLocaleString('en-US', FULL_OPTS)
}

/** "2:30 PM" — time only. */
export function formatInterviewTime(value, fallback = '') {
  const d = toWallClockDate(value)
  if (!d) return fallback
  return d.toLocaleTimeString('en-US', TIME_OPTS)
}

const LONG_OPTS = {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
}

/** "Wednesday, June 10, 2026 at 02:30 PM" — long form for candidate-facing copy. */
export function formatInterviewLong(value, fallback = '') {
  const d = toWallClockDate(value)
  if (!d) return fallback
  return d.toLocaleString('en-US', LONG_OPTS)
}

/** "Wed, Jun 10" — date only. */
export function formatInterviewDate(value, fallback = '—') {
  const d = toWallClockDate(value)
  if (!d) return fallback
  return d.toLocaleDateString('en-US', DATE_OPTS)
}

// ── Business-day windows (Asia/Colombo, UTC+5:30, no DST) ────────────────────
// Engagement counts are reported per Sri-Lanka calendar day, NOT a rolling 24h
// window and NOT the viewer's browser timezone. These return the right values to
// hand the API as date_from / date_to so "Today" means the Colombo calendar day.
const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** UTC instant (ms) of the start of the Colombo calendar day containing `ts`. */
export function startOfColomboDay(ts = Date.now()) {
  const shifted = new Date(ts + COLOMBO_OFFSET_MS)
  const flooredColomboMidnight = Date.UTC(
    shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()
  )
  return flooredColomboMidnight - COLOMBO_OFFSET_MS
}

/** 'YYYY-MM-DD' key of the Colombo calendar day containing `ts`. */
export function colomboDayKey(ts = Date.now()) {
  return new Date(ts + COLOMBO_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * ISO bounds for a window of `days` Colombo calendar days ending *today*, plus
 * the equally-long window immediately before it (for trend deltas).
 * Returns { from, prevFrom }: current window = [from, now), previous = [prevFrom, from).
 */
export function colomboDayWindow(days = 1, now = Date.now()) {
  const start = startOfColomboDay(now) - (days - 1) * 86400000
  return {
    from: new Date(start).toISOString(),
    prevFrom: new Date(start - days * 86400000).toISOString(),
  }
}
