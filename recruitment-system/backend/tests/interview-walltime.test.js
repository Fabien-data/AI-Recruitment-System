// Guards the interview-time regression ([[interview-datetime-wallclock]]): the
// candidate must receive the EXACT wall-clock time that was scheduled, with no
// server-timezone shift. notifications.js pulls in several side-effectful modules
// at load, so we mock them; formatInterviewWallClock itself is pure.

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/query-adapter', () => ({ adaptQuery: (s) => s }));
jest.mock('../src/services/whatsapp', () => ({}));
jest.mock('../src/services/sms', () => ({ sendSMS: jest.fn() }));
jest.mock('../src/services/chatbotNotifier', () => ({ pushCandidateStatus: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }));

const { formatInterviewWallClock } = require('../src/services/notifications');

describe('formatInterviewWallClock', () => {
    test('preserves the literal time from a naive "YYYY-MM-DDTHH:mm" (what bulk-schedule sends)', () => {
        const out = formatInterviewWallClock('2026-06-09T14:30');
        // 2:30 PM must NOT shift to 9:00 AM (the old UTC-conversion bug).
        expect(out).toContain('02:30 PM');
        expect(out).toContain('June 9, 2026');
        expect(out).toContain('Tuesday');
    });

    test('preserves the time from a "YYYY-MM-DD HH:mm:ss" string', () => {
        const out = formatInterviewWallClock('2026-06-09 09:05:00');
        expect(out).toContain('09:05 AM');
        expect(out).toContain('June 9, 2026');
    });

    test('handles a Date whose UTC fields hold the stored wall-clock (Cloud Run UTC host)', () => {
        const d = new Date(Date.UTC(2026, 5, 9, 14, 30));
        const out = formatInterviewWallClock(d);
        expect(out).toContain('02:30 PM');
    });

    test('empty input yields empty string (collapses cleanly in the template)', () => {
        expect(formatInterviewWallClock('')).toBe('');
        expect(formatInterviewWallClock(null)).toBe('');
        expect(formatInterviewWallClock(undefined)).toBe('');
    });
});
