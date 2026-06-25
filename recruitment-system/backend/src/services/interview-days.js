/**
 * Interview Days (pure helpers)
 * =============================
 * Date-specific interview support. A project's `interview_config` may carry a
 * `days[]` array — each entry a physical interview session on a specific date,
 * at its own venue, with its own time window and (optional) capacity:
 *
 *   days: [
 *     { id, date: 'YYYY-MM-DD', location, time_start: 'HH:mm', time_end: 'HH:mm',
 *       capacity: number|null, what_to_bring|null, dress_code|null, notes|null }
 *   ]
 *
 * Shared project-level fields (location, what_to_bring, dress_code, extra_notes,
 * slot_minutes, per_day_limit, …) stay on the blob and act as defaults.
 *
 * Everything here is pure (no DB / I/O / clock) and timezone-safe: all datetimes
 * are emitted as naive wall-clock strings 'YYYY-MM-DDTHH:mm' to match the contract
 * the rest of the code inserts and that notifications.formatInterviewWallClock
 * re-parses. We never convert to/from UTC or read the local clock.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Normalise a project's interview_config into a list of interview days.
 * - When `cfg.days[]` exists, returns those (dropping blank rows), with per-day
 *   what_to_bring/dress_code/notes defaulted from the shared project fields.
 * - Otherwise synthesizes ONE legacy day with no specific date, so the old
 *   single-location config keeps working with the date-specific code paths.
 *
 * @param {object} cfg projects.interview_config (may be null)
 * @returns {Array<{id, date, location, time_start, time_end, capacity,
 *                  what_to_bring, dress_code, notes}>}
 */
function resolveInterviewDays(cfg) {
    const c = cfg || {};
    const shared = {
        location: c.location || null,
        what_to_bring: c.what_to_bring || null,
        dress_code: c.dress_code || null,
        notes: c.extra_notes || null,
    };

    if (Array.isArray(c.days) && c.days.length) {
        return c.days
            .filter((d) => d && d.date && d.location)
            .map((d) => ({
                id: d.id || null,
                date: String(d.date),
                location: String(d.location),
                time_start: d.time_start || '09:00',
                time_end: d.time_end || '17:00',
                capacity: d.capacity == null || d.capacity === '' ? null : Number(d.capacity),
                what_to_bring: d.what_to_bring || shared.what_to_bring,
                dress_code: d.dress_code || shared.dress_code,
                notes: d.notes || shared.notes,
            }))
            .sort((a, b) => a.date.localeCompare(b.date));
    }

    // Legacy single-location config → one undated day. `date:null` means "no
    // specific date": bulk-schedule still needs an explicit datetime (fixed mode)
    // and the reschedule picker falls back to the auto-slot allocator.
    return [{
        id: 'legacy',
        date: null,
        location: shared.location,
        time_start: '09:00',
        time_end: '17:00',
        capacity: c.per_day_limit == null ? null : Number(c.per_day_limit),
        what_to_bring: shared.what_to_bring,
        dress_code: shared.dress_code,
        notes: shared.notes,
    }];
}

/** Naive wall-clock datetime string for a day, e.g. '2026-06-21T09:00'. */
function dayDatetime(day) {
    return `${day.date}T${day.time_start || '09:00'}`;
}

/**
 * 'YYYY-MM-DD' → 'Sun 21 Jun' (UTC-naive; never reads the local clock). Returns
 * the input unchanged if it isn't a parseable date.
 */
function shortWallClockDate(date) {
    const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(date || '');
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return `${WEEKDAYS[d.getUTCDay()]} ${+m[3]} ${MONTHS[+m[2] - 1]}`;
}

/**
 * Build the candidate-facing "other available days" list, excluding the day they
 * are already booked on. Returns '' when there is nothing else to offer.
 *
 *   "Other available days:\n• Sun 21 Jun — Kurunegala\n• Wed 24 Jun — Colombo"
 */
function formatOtherDaysList(days, currentDate) {
    const others = (days || []).filter((d) => d.date && d.date !== currentDate);
    if (!others.length) return '';
    const lines = others.map((d) => `• ${shortWallClockDate(d.date)} — ${d.location}`);
    return `Other available days:\n${lines.join('\n')}`;
}

/**
 * Assign `count` candidates across the configured interview days, honouring each
 * day's remaining capacity (capacity − already-booked). Pure and deterministic.
 *
 * @param {object} opts
 * @param {Array} opts.days resolved days (must have a real `date`)
 * @param {number} opts.count number of candidates to place
 * @param {Object<string,number>} [opts.bookedByDate] date → already-booked count
 * @param {'sequential'|'round_robin'} [opts.fill='sequential']
 * @param {string[]} [opts.dayIds] restrict to these day ids (default: all days)
 * @returns {{assignments: Array<{scheduled_datetime, location, day}>, unplaced: number}}
 */
function assignDaysRoundRobin({ days, count, bookedByDate = {}, fill = 'sequential', dayIds = null } = {}) {
    let pool = (days || []).filter((d) => d.date && d.location);
    if (Array.isArray(dayIds) && dayIds.length) {
        const want = new Set(dayIds);
        pool = pool.filter((d) => want.has(d.id));
    }
    pool = pool.slice().sort((a, b) => a.date.localeCompare(b.date));

    // Remaining capacity per day (Infinity when uncapped).
    const remaining = pool.map((d) =>
        d.capacity == null ? Infinity : Math.max(0, Number(d.capacity) - (bookedByDate[d.date] || 0))
    );

    const assignments = [];
    const place = (i) => {
        remaining[i] -= 1;
        assignments.push({ scheduled_datetime: dayDatetime(pool[i]), location: pool[i].location, day: pool[i] });
    };

    if (fill === 'round_robin') {
        let guard = 0;
        while (assignments.length < count && guard < count + pool.length) {
            let placedThisPass = false;
            for (let i = 0; i < pool.length && assignments.length < count; i += 1) {
                if (remaining[i] > 0) { place(i); placedThisPass = true; }
            }
            if (!placedThisPass) break; // every day full
            guard += 1;
        }
    } else {
        // sequential: fill each day to capacity before moving on
        for (let i = 0; i < pool.length && assignments.length < count; i += 1) {
            while (remaining[i] > 0 && assignments.length < count) place(i);
        }
    }

    return { assignments, unplaced: Math.max(0, count - assignments.length) };
}

module.exports = {
    resolveInterviewDays,
    dayDatetime,
    shortWallClockDate,
    formatOtherDaysList,
    assignDaysRoundRobin,
};
