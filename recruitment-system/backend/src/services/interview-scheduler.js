/**
 * Interview Scheduler (pure allocator)
 * ====================================
 * Deterministic, dependency-free slot allocation for the "smart" bulk-schedule
 * mode. Given a list of applications, one or more interviewers, a start date,
 * a per-interviewer/day cap and a slot length, it assigns each candidate to the
 * next available slot — round-robining across interviewers and AUTO-SHIFTING to
 * the next working day when the day's cap is reached.
 *
 * Pure (no DB / I/O / clock): the caller seeds `existingByInterviewerDay` with
 * already-booked counts so the cap reflects real load. All datetimes are emitted
 * as wall-clock strings 'YYYY-MM-DDTHH:mm' to match the contract the rest of the
 * code inserts (`${date}T${time}`) and that notifications.sendInterviewNotification
 * re-parses — no timezone conversion is performed.
 */

const DEFAULT_PER_DAY_LIMIT = Number(process.env.INTERVIEW_PER_DAY_LIMIT) || 8;
const DEFAULT_SLOT_MINUTES = 30;
const DEFAULT_WORKDAY_START = 9;  // 09:00
const DEFAULT_WORKDAY_END = 17;   // 17:00
const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5]; // Mon–Fri (0 = Sunday)

const pad2 = (n) => String(n).padStart(2, '0');

// Date math on a {y,m,d} tuple via UTC parts only — avoids DST / local-offset
// drift (we never read local time, only UTC components).
const parseISODate = (s) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return { y, m, d };
};
const toUTC = (dt) => new Date(Date.UTC(dt.y, dt.m - 1, dt.d));
const fromUTC = (date) => ({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() });
const addDays = (dt, n) => {
    const u = toUTC(dt);
    u.setUTCDate(u.getUTCDate() + n);
    return fromUTC(u);
};
const weekday = (dt) => toUTC(dt).getUTCDay(); // 0=Sun … 6=Sat
const fmtDate = (dt) => `${dt.y}-${pad2(dt.m)}-${pad2(dt.d)}`;
const fmtTime = (min) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

const isWorkingDay = (dt, workingDays, skipSet) =>
    workingDays.includes(weekday(dt)) && !skipSet.has(fmtDate(dt));

const nextWorkingDay = (dt, workingDays, skipSet) => {
    let cur = dt;
    let guard = 0;
    while (!isWorkingDay(cur, workingDays, skipSet) && guard < 3650) {
        cur = addDays(cur, 1);
        guard += 1;
    }
    return cur;
};

/**
 * Allocate interview slots.
 * @param {object} opts
 * @returns {{assignments: Array, byDay: Array, unallocated: Array,
 *            effective_slots_per_day: number, physical_slots_per_day: number}}
 */
function allocateInterviewSlots(opts = {}) {
    const {
        applications = [],
        interviewerIds = [],
        startDate,
        perDayLimit = DEFAULT_PER_DAY_LIMIT,
        slotMinutes = DEFAULT_SLOT_MINUTES,
        workdayStartHour = DEFAULT_WORKDAY_START,
        workdayEndHour = DEFAULT_WORKDAY_END,
        workingDays = DEFAULT_WORKING_DAYS,
        skipDates = [],
        existingByInterviewerDay = {},
    } = opts;

    if (!startDate) throw new Error('startDate (YYYY-MM-DD) is required');

    // At least one lane; null = "no specific interviewer".
    const lanes = (interviewerIds && interviewerIds.length) ? interviewerIds.slice() : [null];
    const skipSet = new Set(skipDates);

    // Accept either ids or objects with id/application_id.
    const appIds = applications.map((a) =>
        (a && typeof a === 'object') ? (a.id || a.application_id) : a
    );

    // The cap is bounded by the physical number of slots in the working window.
    const physicalSlots = Math.max(0, Math.floor(((workdayEndHour - workdayStartHour) * 60) / slotMinutes));
    const slotsPerDay = Math.max(1, Math.min(perDayLimit, physicalSlots || perDayLimit));

    const assignments = [];
    const byDayMap = new Map(); // `${date}|${interviewer}` -> bucket

    let day = nextWorkingDay(parseISODate(startDate), workingDays, skipSet);
    let dayIndex = 0;

    // Per-lane usage for the current day, seeded with already-booked counts.
    const seedCounts = () => {
        const dateKey = fmtDate(day);
        return lanes.map((id) => (existingByInterviewerDay[id] && existingByInterviewerDay[id][dateKey]) || 0);
    };
    let counts = seedCounts();

    for (const appId of appIds) {
        let placed = false;
        let attempts = 0;
        while (!placed && attempts < 3650) {
            const dateKey = fmtDate(day);
            // Round-robin: pick the least-loaded lane still under the cap.
            let laneIdx = -1;
            let minCount = Infinity;
            for (let i = 0; i < lanes.length; i += 1) {
                if (counts[i] < slotsPerDay && counts[i] < minCount) {
                    minCount = counts[i];
                    laneIdx = i;
                }
            }
            if (laneIdx === -1) {
                // Every lane is full today → auto-shift to the next working day.
                day = nextWorkingDay(addDays(day, 1), workingDays, skipSet);
                dayIndex += 1;
                counts = seedCounts();
                attempts += 1;
                continue;
            }
            const slotIndex = counts[laneIdx];
            const minutes = workdayStartHour * 60 + slotIndex * slotMinutes;
            const interviewerId = lanes[laneIdx];
            const scheduled = `${dateKey}T${fmtTime(minutes)}`;

            assignments.push({
                application_id: appId,
                interviewer_id: interviewerId,
                scheduled_datetime: scheduled,
                day_index: dayIndex,
            });
            counts[laneIdx] += 1;

            const bkey = `${dateKey}|${interviewerId}`;
            if (!byDayMap.has(bkey)) {
                byDayMap.set(bkey, { date: dateKey, interviewer_id: interviewerId, count: 0, items: [] });
            }
            const bucket = byDayMap.get(bkey);
            bucket.count += 1;
            bucket.items.push({ application_id: appId, scheduled_datetime: scheduled });
            placed = true;
        }
    }

    // Defensive: no two assignments may share an (interviewer, datetime).
    const seen = new Set();
    for (const a of assignments) {
        const k = `${a.interviewer_id}|${a.scheduled_datetime}`;
        if (seen.has(k)) {
            throw new Error(`Double-booking detected: interviewer ${a.interviewer_id} at ${a.scheduled_datetime}`);
        }
        seen.add(k);
    }

    const byDay = Array.from(byDayMap.values()).sort((x, y) =>
        x.date === y.date ? String(x.interviewer_id).localeCompare(String(y.interviewer_id)) : x.date.localeCompare(y.date)
    );

    return {
        assignments,
        byDay,
        unallocated: [],
        effective_slots_per_day: slotsPerDay,
        physical_slots_per_day: physicalSlots,
    };
}

module.exports = {
    allocateInterviewSlots,
    DEFAULT_PER_DAY_LIMIT,
    DEFAULT_SLOT_MINUTES,
    DEFAULT_WORKDAY_START,
    DEFAULT_WORKDAY_END,
    DEFAULT_WORKING_DAYS,
};
