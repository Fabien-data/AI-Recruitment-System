// Unit tests for the date-specific interview helpers (services/interview-days.js).
// Pure module — no mocks needed. Covers back-compat (legacy single-location config
// → one synthetic day), capacity-aware distribution, and the wall-clock formatting
// that the candidate-facing day list relies on ([[interview-datetime-wallclock]]).

const {
    resolveInterviewDays,
    dayDatetime,
    shortWallClockDate,
    formatOtherDaysList,
    assignDaysRoundRobin,
} = require('../src/services/interview-days');

const TWO_DAYS = {
    what_to_bring: 'NIC',
    days: [
        { id: 'a', date: '2026-06-21', location: 'Kurunegala', time_start: '09:00', time_end: '13:00', capacity: 2 },
        { id: 'b', date: '2026-06-20', location: 'Colombo', time_start: '09:00', time_end: '17:00', capacity: 2 },
    ],
};

describe('resolveInterviewDays', () => {
    test('legacy single-location config → one undated day with shared defaults', () => {
        const days = resolveInterviewDays({ location: 'Colombo', per_day_limit: 8, what_to_bring: 'Passport' });
        expect(days).toHaveLength(1);
        expect(days[0]).toMatchObject({ date: null, location: 'Colombo', capacity: 8, what_to_bring: 'Passport' });
    });

    test('days[] are sorted by date and inherit shared what_to_bring when null', () => {
        const days = resolveInterviewDays(TWO_DAYS);
        expect(days.map((d) => d.date)).toEqual(['2026-06-20', '2026-06-21']);
        expect(days.every((d) => d.what_to_bring === 'NIC')).toBe(true);
    });

    test('drops day rows missing a date or location', () => {
        const days = resolveInterviewDays({ days: [{ id: 'x', date: '2026-07-01' }, { id: 'y', location: 'Galle' }] });
        expect(days).toHaveLength(0);
    });
});

describe('dayDatetime + shortWallClockDate', () => {
    test('dayDatetime is a naive wall-clock string', () => {
        expect(dayDatetime({ date: '2026-06-21', time_start: '09:30' })).toBe('2026-06-21T09:30');
    });
    test('shortWallClockDate formats without any timezone shift', () => {
        expect(shortWallClockDate('2026-06-21')).toBe('Sun 21 Jun');
        expect(shortWallClockDate('2026-06-20')).toBe('Sat 20 Jun');
    });
});

describe('formatOtherDaysList', () => {
    test('excludes the candidate current day and lists the rest with venues', () => {
        const days = resolveInterviewDays(TWO_DAYS);
        const out = formatOtherDaysList(days, '2026-06-20');
        expect(out).toContain('Sun 21 Jun — Kurunegala');
        expect(out).not.toContain('2026-06-20');
        expect(out).not.toContain('Colombo');
    });
    test('returns empty string when nothing else is available', () => {
        const days = resolveInterviewDays({ days: [{ id: 'a', date: '2026-06-20', location: 'Colombo' }] });
        expect(formatOtherDaysList(days, '2026-06-20')).toBe('');
    });
});

describe('assignDaysRoundRobin', () => {
    const days = resolveInterviewDays(TWO_DAYS); // [20 Jun cap2, 21 Jun cap2]

    test('sequential fill: day 1 to capacity, then day 2', () => {
        const { assignments, unplaced } = assignDaysRoundRobin({ days, count: 3 });
        expect(unplaced).toBe(0);
        expect(assignments.map((a) => a.location)).toEqual(['Colombo', 'Colombo', 'Kurunegala']);
    });

    test('honours already-booked counts (full day is skipped)', () => {
        const { assignments, unplaced } = assignDaysRoundRobin({ days, count: 3, bookedByDate: { '2026-06-20': 2 } });
        expect(assignments.map((a) => a.location)).toEqual(['Kurunegala', 'Kurunegala']);
        expect(unplaced).toBe(1); // only 2 seats left across both days
    });

    test('round_robin spreads one per day per pass', () => {
        const { assignments } = assignDaysRoundRobin({ days, count: 4, fill: 'round_robin' });
        expect(assignments.map((a) => a.location)).toEqual(['Colombo', 'Kurunegala', 'Colombo', 'Kurunegala']);
    });

    test('dayIds restricts the batch to chosen days', () => {
        const { assignments, unplaced } = assignDaysRoundRobin({ days, count: 5, dayIds: ['a'] });
        expect(assignments.every((a) => a.location === 'Kurunegala')).toBe(true);
        expect(assignments).toHaveLength(2); // capacity 2 on the single chosen day
        expect(unplaced).toBe(3);
    });

    test('uncapped day (capacity null) absorbs everyone', () => {
        const open = resolveInterviewDays({ days: [{ id: 'o', date: '2026-06-25', location: 'Negombo' }] });
        const { assignments, unplaced } = assignDaysRoundRobin({ days: open, count: 50 });
        expect(assignments).toHaveLength(50);
        expect(unplaced).toBe(0);
    });
});
