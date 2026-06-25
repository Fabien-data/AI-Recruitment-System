/**
 * Auto-assign scoring tests.
 *
 * Covers the matching-integrity fixes:
 *   - B012: a candidate with no CV must never score 100% (hard CV gate +
 *     experience credit only when the job actually requires experience).
 *   - B013: a gendered vacancy must never match the wrong gender (hard filter),
 *     while unknown candidate gender is allowed through but flagged.
 *
 * calculateMatchScore is a pure function exported from the route module, so we
 * test it directly without spinning up the DB.
 */
require('dotenv').config();

// auto-assign.js pulls in ../config/database at import time; mock it so the
// unit test never opens a real connection.
jest.mock('../src/config/database', () => ({
    pool: { query: jest.fn() },
    withTransaction: jest.fn(),
}));

const { calculateMatchScore } = require('../src/routes/auto-assign');

describe('calculateMatchScore', () => {
    test('is exported for unit testing', () => {
        expect(typeof calculateMatchScore).toBe('function');
    });

    describe('B012 — no CV must never score 100%', () => {
        test('no CV + no parsed signal → score 0, not qualified', () => {
            const candidate = { cv_uploaded: false, tags: [], metadata: {} };
            const job = { requirements: JSON.stringify({}) };
            const r = calculateMatchScore(candidate, job);
            expect(r.score).toBe(0);
            expect(r.is_qualified).toBe(false);
            expect(r.no_cv).toBe(true);
        });

        test('no CV is gated even when the job "requires" 0 years (old phantom-100% path)', () => {
            const candidate = { cv_uploaded: false, tags: [], metadata: {} };
            const job = { requirements: JSON.stringify({ min_experience_years: 0 }) };
            const r = calculateMatchScore(candidate, job);
            expect(r.score).toBe(0);
            expect(r.no_cv).toBe(true);
        });

        test('requirement-less job yields 0, not 100%, even with a CV', () => {
            const candidate = { cv_uploaded: true, tags: ['security'], metadata: {} };
            const job = { requirements: JSON.stringify({}) };
            const r = calculateMatchScore(candidate, job);
            expect(r.score).toBe(0);
            expect(r.insufficient_criteria).toBe(true);
        });

        test('CV present but unknown experience is not given free experience credit', () => {
            // skills don't match (security vs driving) and experience isn't
            // required, so nothing should inflate the score to 100.
            const candidate = { cv_uploaded: true, tags: ['security'], metadata: {} };
            const job = { requirements: JSON.stringify({ required_skills: ['driving'] }) };
            const r = calculateMatchScore(candidate, job);
            expect(r.score).toBeLessThan(100);
        });
    });

    describe('B013 — gender hard filter', () => {
        const femaleSecurityJob = { requirements: JSON.stringify({ required_skills: ['security'], gender: 'female' }) };

        test('male candidate must not match a female vacancy', () => {
            const candidate = { cv_uploaded: true, tags: ['security'], metadata: { gender: 'male' } };
            const r = calculateMatchScore(candidate, femaleSecurityJob);
            expect(r.score).toBe(0);
            expect(r.gender_mismatch).toBe(true);
        });

        test('matching gender does not trigger the filter', () => {
            const candidate = { cv_uploaded: true, tags: ['security'], metadata: { gender: 'female' } };
            const r = calculateMatchScore(candidate, femaleSecurityJob);
            expect(r.gender_mismatch).toBeUndefined();
            expect(r.score).toBeGreaterThan(0);
        });

        test('unknown candidate gender is allowed through but flagged for manual review', () => {
            const candidate = { cv_uploaded: true, tags: ['security'], metadata: {} };
            const r = calculateMatchScore(candidate, femaleSecurityJob);
            expect(r.gender_mismatch).toBeUndefined();
            const genderFactor = r.factors.find(f => f.factor === 'gender');
            expect(genderFactor).toBeDefined();
            expect(String(genderFactor.detail)).toMatch(/unknown/i);
        });
    });

    describe('happy path still scores', () => {
        test('matching skills + met experience requirement → 100%', () => {
            const candidate = { cv_uploaded: true, tags: ['security'], metadata: { experience_years: 5 } };
            const job = { requirements: JSON.stringify({ required_skills: ['security'], min_experience_years: 2 }) };
            const r = calculateMatchScore(candidate, job);
            expect(r.score).toBe(100);
            expect(r.is_qualified).toBe(true);
        });
    });
});
