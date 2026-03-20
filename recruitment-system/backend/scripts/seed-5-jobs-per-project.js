#!/usr/bin/env node
/**
 * Ensure every project has exactly 5 jobs (for demo).
 * Adds jobs only; does not remove existing jobs.
 * Usage: node backend/scripts/seed-5-jobs-per-project.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const db = require('../src/config/database');
const query = db.query.bind(db);
const generateUUID = db.generateUUID || (() => require('crypto').randomUUID());
const { isMySQL } = require('../src/utils/query-adapter');
const { syncJobAsync } = require('../src/routes/chatbot-sync');

const JOBS_PER_PROJECT = 5;

// Five job templates with realistic requirements for chatbot tailoring
const JOB_TEMPLATES = [
    {
        title: 'Security Operator',
        category: 'security',
        description: 'Security guard position for site patrol and access control.',
        requirements: {
            min_height_cm: 170,
            max_height_cm: 190,
            required_languages: ['English'],
            min_age: 21,
            max_age: 45,
            experience_years: 1,
            licenses: ['security_license'],
            specific_info_to_ask: ["Height", "Age", "Arms Handling Experience"]
        },
        wiggle_room: { height_tolerance_cm: 5, age_tolerance_years: 2 },
        positions_available: 5,
        salary_range: '800-1200 AED/month',
        location: 'GCC'
    },
    {
        title: 'CCTV Operator',
        category: 'security',
        description: 'CCTV operator for surveillance and monitoring.',
        requirements: {
            required_languages: ['English'],
            min_age: 21,
            max_age: 40,
            experience_years: 2,
            specific_info_to_ask: ["CCTV License or Certification", "Age", "Surveillance Software Experience"]
        },
        wiggle_room: { experience_tolerance_years: 1 },
        positions_available: 3,
        salary_range: '900-1400 AED/month',
        location: 'GCC'
    },
    {
        title: 'Hospitality Assistant',
        category: 'hospitality',
        description: 'Hotel or restaurant staff: front desk, housekeeping, or F&B.',
        requirements: {
            required_languages: ['English'],
            min_age: 21,
            max_age: 45,
            experience_years: 0,
            specific_info_to_ask: ["Height", "Age", "Hospitality Training Level"]
        },
        wiggle_room: { age_tolerance_years: 3 },
        positions_available: 10,
        salary_range: '600-900 AED/month',
        location: 'GCC'
    },
    {
        title: 'VIP Bodyguard',
        category: 'security',
        description: 'Close protection operative for VIP physical security.',
        requirements: {
            required_languages: ['English', 'Arabic'],
            min_age: 25,
            max_age: 50,
            experience_years: 3,
            licenses: ['firearms_license'],
            specific_info_to_ask: ["Height", "Age", "Martial Arts Expertise", "Arms Handling Experience"]
        },
        wiggle_room: { experience_tolerance_years: 1, age_tolerance_years: 2 },
        positions_available: 5,
        salary_range: '2500-4000 AED/month',
        location: 'GCC'
    },
    {
        title: 'Duty Patrol Driver',
        category: 'logistics',
        description: 'Patrol driver role for security rounds.',
        requirements: {
            required_languages: ['English'],
            min_age: 23,
            max_age: 45,
            experience_years: 2,
            licenses: ['driving_license'],
            specific_info_to_ask: ["Driving License Type", "Years of GCC Driving Experience", "Age"]
        },
        wiggle_room: { age_tolerance_years: 2 },
        positions_available: 3,
        salary_range: '1000-1500 AED/month',
        location: 'GCC'
    }
];

async function run() {
    const projectsResult = await query('SELECT id, title FROM projects', []);
    const projects = projectsResult.rows || [];

    if (projects.length === 0) {
        console.log('No projects found. Create projects first (e.g. run seed-mock.js or add via UI).');
        return;
    }

    console.log(`Found ${projects.length} project(s). Ensuring each has ${JOBS_PER_PROJECT} jobs.`);

    for (const project of projects) {
        const countResult = await query('SELECT COUNT(*) AS cnt FROM jobs WHERE project_id = $1', [project.id]);
        const currentCount = parseInt((countResult.rows && countResult.rows[0] && countResult.rows[0].cnt) || 0, 10);
        const toAdd = 5; // Force adding our 5 new templates

        console.log(`  Project "${project.title}" (${project.id}): has ${currentCount} jobs, adding ${toAdd} new templates.`);

        for (let i = 0; i < toAdd; i++) {
            const template = JOB_TEMPLATES[i % JOB_TEMPLATES.length];
            const title = `${template.title} - ${project.title}`.slice(0, 200);
            const jobId = generateUUID();

            const insertSql = isMySQL
                ? `INSERT INTO jobs (id, title, category, description, requirements, wiggle_room, positions_available, salary_range, location, project_id, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`
                : `INSERT INTO jobs (id, title, category, description, requirements, wiggle_room, positions_available, salary_range, location, project_id, status)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')`;

            const params = [
                jobId,
                title,
                template.category,
                template.description,
                JSON.stringify(template.requirements),
                JSON.stringify(template.wiggle_room),
                template.positions_available,
                template.salary_range,
                template.location,
                project.id
            ];

            await query(insertSql, params);
            console.log(`    Added job: ${title}`);
            // Sync to chatbot
            await syncJobAsync(jobId);
        }
    }

    console.log('Done. Each project now has up to 5 jobs.');
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Seed error:', err);
        process.exit(1);
    });
