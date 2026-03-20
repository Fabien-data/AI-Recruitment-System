#!/usr/bin/env node
/**
 * Seed mock data into the database (development only)
 * Usage: from repo root -> node backend/scripts/seed-mock.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const db = require('../src/config/database');
const pool = db.pool || db;

// Load mock arrays exported by the mock-data router
const mockModule = require('../src/routes/mock-data');
const mockCandidates = mockModule.mockCandidates || [];
const mockProjects = mockModule.mockProjects || [];
const mockProjectsData = mockModule.mockProjectsData || [];

const SEED_CREATED_BY = process.env.SEED_CREATED_BY || null;

async function seed() {
    const results = { candidates: [], jobs: [], projects: [] };

    for (const candidate of mockCandidates) {
        try {
            const existing = await pool.query('SELECT id FROM candidates WHERE phone = $1', [candidate.phone]);
            if (existing.rows && existing.rows.length > 0) {
                results.candidates.push({ phone: candidate.phone, status: 'exists' });
                continue;
            }

            const candidateResult = await pool.query(
                `INSERT INTO candidates (name, phone, email, source, preferred_language, status, notes, tags, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING *`,
                [
                    candidate.name,
                    candidate.phone,
                    candidate.email,
                    candidate.source,
                    candidate.preferred_language,
                    candidate.status,
                    candidate.notes,
                    JSON.stringify(candidate.skills || []),
                    JSON.stringify({
                        height_cm: candidate.height_cm,
                        age: candidate.age,
                        experience_years: candidate.experience_years
                    })
                ]
            );

            const newCandidate = candidateResult.rows[0];

            await pool.query(
                `INSERT INTO cv_files (candidate_id, file_url, file_name, file_type, ocr_status, ocr_text, parsed_data, is_primary)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    newCandidate.id,
                    `/uploads/mock/${candidate.name.toLowerCase().replace(/\s/g, '_')}_cv.pdf`,
                    `${candidate.name}_CV.pdf`,
                    'pdf',
                    'completed',
                    candidate.cv_text,
                    JSON.stringify({
                        skills: candidate.skills,
                        experience_years: candidate.experience_years,
                        height_cm: candidate.height_cm,
                        age: candidate.age,
                        languages: (candidate.skills || []).filter(s => ['English', 'Arabic', 'Hindi', 'Sinhala', 'Tamil', 'French'].includes(s))
                    }),
                    true
                ]
            );

            results.candidates.push({ id: newCandidate.id, name: candidate.name, status: 'created' });
        } catch (err) {
            results.candidates.push({ name: candidate.name, status: 'error', message: err.message });
        }
    }

    for (const job of mockProjects) {
        try {
            const existing = await pool.query('SELECT id FROM jobs WHERE title = $1', [job.title]);
            if (existing.rows && existing.rows.length > 0) {
                results.jobs.push({ title: job.title, status: 'exists' });
                continue;
            }

            const jobResult = await pool.query(
                `INSERT INTO jobs (title, category, description, requirements, wiggle_room, positions_available, salary_range, location, status, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
                 RETURNING *`,
                [
                    job.title,
                    job.category,
                    job.description,
                    JSON.stringify(job.requirements || {}),
                    JSON.stringify(job.wiggle_room || {}),
                    job.positions_available || 1,
                    job.salary_range || '',
                    job.location || '',
                    SEED_CREATED_BY
                ]
            );

            results.jobs.push({ id: jobResult.rows[0].id, title: job.title, status: 'created' });
        } catch (err) {
            results.jobs.push({ title: job.title, status: 'error', message: err.message });
        }
    }

    // Insert mock projects
    for (const project of mockProjectsData) {
        try {
            const existing = await pool.query('SELECT id FROM projects WHERE title = $1 AND client_name = $2', [project.title, project.client_name]);
            if (existing.rows && existing.rows.length > 0) {
                results.projects.push({ title: project.title, client_name: project.client_name, status: 'exists' });
                continue;
            }

            const projectResult = await pool.query(
                `INSERT INTO projects (title, client_name, industry_type, description, countries, status, priority, 
                 total_positions, filled_positions, start_date, interview_date, end_date, benefits, salary_info, contact_info, 
                 requirements, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                 RETURNING *`,
                [
                    project.title,
                    project.client_name,
                    project.industry_type,
                    project.description,
                    JSON.stringify(project.countries),
                    project.status,
                    project.priority,
                    project.total_positions,
                    project.filled_positions,
                    project.start_date,
                    project.interview_date,
                    project.end_date,
                    JSON.stringify(project.benefits),
                    JSON.stringify(project.salary_info),
                    JSON.stringify(project.contact_info),
                    JSON.stringify(project.requirements),
                    SEED_CREATED_BY
                ]
            );

            results.projects.push({ id: projectResult.rows[0].id, title: project.title, client_name: project.client_name, status: 'created' });
        } catch (err) {
            results.projects.push({ title: project.title, client_name: project.client_name, status: 'error', message: err.message });
        }
    }

    console.log('Seeding finished:', JSON.stringify(results, null, 2));
}

seed()
    .then(() => {
        console.log('Done.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('Seeding error:', err);
        process.exit(1);
    });
