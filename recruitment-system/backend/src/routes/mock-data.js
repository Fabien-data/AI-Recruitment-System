/**
 * Mock Data Route for Development/Testing
 * This route provides mock CVs and candidates for testing the system
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth');

// Mock candidate data with CVs
const mockCandidates = [
    {
        name: 'Ahmed Al-Rashid',
        phone: '+94771234501',
        email: 'ahmed.rashid@example.com',
        source: 'whatsapp',
        preferred_language: 'en',
        status: 'screening',
        notes: 'Strong candidate with security background',
        skills: ['Security', 'First Aid', 'English', 'Arabic'],
        experience_years: 5,
        height_cm: 178,
        age: 28,
        cv_text: 'Ahmed Al-Rashid - Security Professional with 5 years experience in UAE. Fluent in English and Arabic. Height: 178cm. Security License holder.'
    },
    {
        name: 'Priya Sharma',
        phone: '+94772345602',
        email: 'priya.sharma@example.com',
        source: 'email',
        preferred_language: 'en',
        status: 'new',
        notes: '',
        skills: ['Hospitality', 'Customer Service', 'English', 'Hindi'],
        experience_years: 3,
        height_cm: 165,
        age: 26,
        cv_text: 'Priya Sharma - Hospitality professional with 3 years experience in 5-star hotels. Excellent customer service skills. Height: 165cm.'
    },
    {
        name: 'Mohamed Fathik',
        phone: '+94773456703',
        email: 'mohamed.fathik@example.com',
        source: 'walkin',
        preferred_language: 'si',
        status: 'interview',
        notes: 'Scheduled for final interview',
        skills: ['Manufacturing', 'Machine Operation', 'English', 'Sinhala'],
        experience_years: 7,
        height_cm: 172,
        age: 35,
        cv_text: 'Mohamed Fathik - Factory supervisor with 7 years experience. Machine operation certified. Can communicate in English and Sinhala.'
    },
    {
        name: 'Nimal Perera',
        phone: '+94774567804',
        email: 'nimal.perera@example.com',
        source: 'messenger',
        preferred_language: 'si',
        status: 'new',
        notes: '',
        skills: ['Security', 'Driving', 'English', 'Sinhala'],
        experience_years: 4,
        height_cm: 175,
        age: 30,
        cv_text: 'Nimal Perera - Former military personnel with security training. Valid driving license. Height: 175cm.'
    },
    {
        name: 'Kumari Jayawardena',
        phone: '+94775678905',
        email: 'kumari.j@example.com',
        source: 'email',
        preferred_language: 'en',
        status: 'screening',
        notes: 'Excellent English skills, recommended for hospitality',
        skills: ['Hospitality', 'English', 'French', 'Customer Service'],
        experience_years: 5,
        height_cm: 162,
        age: 29,
        cv_text: 'Kumari Jayawardena - International hospitality experience including 2 years in Dubai. Fluent in English and French.'
    },
    {
        name: 'Rajesh Kumar',
        phone: '+94776789006',
        email: 'rajesh.kumar@example.com',
        source: 'whatsapp',
        preferred_language: 'ta',
        status: 'new',
        notes: '',
        skills: ['Manufacturing', 'Welding', 'Tamil', 'English'],
        experience_years: 8,
        height_cm: 170,
        age: 38,
        cv_text: 'Rajesh Kumar - Certified welder with 8 years factory experience. ISO certified welding skills.'
    },
    {
        name: 'Saman Wickramasinghe',
        phone: '+94777890107',
        email: 'saman.w@example.com',
        source: 'walkin',
        preferred_language: 'si',
        status: 'future_pool',
        notes: 'Good candidate but height is below requirement. Keep for future opportunities.',
        skills: ['Security', 'First Aid', 'English', 'Sinhala'],
        experience_years: 6,
        height_cm: 168,
        age: 32,
        cv_text: 'Saman Wickramasinghe - Ex-police officer with security experience. First aid certified. Height: 168cm.'
    },
    {
        name: 'Fatima Hassan',
        phone: '+94778901208',
        email: 'fatima.h@example.com',
        source: 'email',
        preferred_language: 'en',
        status: 'screening',
        notes: 'Bilingual Arabic/English - perfect for Gulf positions',
        skills: ['Hospitality', 'Arabic', 'English', 'Reception'],
        experience_years: 4,
        height_cm: 160,
        age: 27,
        cv_text: 'Fatima Hassan - Hotel receptionist with 4 years experience. Fluent Arabic and English. Gulf experience preferred.'
    },
    {
        name: 'Dinesh Rathnayake',
        phone: '+94779012309',
        email: 'dinesh.r@example.com',
        source: 'messenger',
        preferred_language: 'si',
        status: 'new',
        notes: '',
        skills: ['Manufacturing', 'Forklift', 'English', 'Sinhala'],
        experience_years: 5,
        height_cm: 173,
        age: 33,
        cv_text: 'Dinesh Rathnayake - Warehouse supervisor with forklift license. 5 years logistics experience.'
    },
    {
        name: 'Lakshmi Thanabalasingham',
        phone: '+94770123410',
        email: 'lakshmi.t@example.com',
        source: 'whatsapp',
        preferred_language: 'ta',
        status: 'interview',
        notes: 'Interview scheduled for next week',
        skills: ['Hospitality', 'Cooking', 'Tamil', 'English'],
        experience_years: 6,
        height_cm: 158,
        age: 31,
        cv_text: 'Lakshmi Thanabalasingham - Experienced chef specializing in international cuisine. 6 years in hospitality industry.'
    }
];

// Mock projects/jobs for assignment
const mockProjects = [
    {
        title: 'Security Guard - Dubai Mall',
        category: 'security',
        description: 'Security positions at Dubai Mall requiring professional guards',
        requirements: {
            min_height_cm: 170,
            max_height_cm: 190,
            required_languages: ['English', 'Arabic'],
            min_age: 21,
            max_age: 45,
            licenses: ['security_license']
        },
        wiggle_room: { height_tolerance_cm: 5, age_tolerance_years: 2 },
        positions_available: 15,
        salary_range: '$800-1200/month',
        location: 'Dubai, UAE'
    },
    {
        title: 'Hotel Staff - Qatar World Cup Legacy',
        category: 'hospitality',
        description: 'Hospitality staff for luxury hotels in Qatar',
        requirements: {
            min_height_cm: 160,
            required_languages: ['English'],
            min_age: 21,
            max_age: 40,
            experience_years: 2
        },
        wiggle_room: { height_tolerance_cm: 3, experience_tolerance_years: 1 },
        positions_available: 25,
        salary_range: '$600-900/month',
        location: 'Doha, Qatar'
    },
    {
        title: 'Factory Worker - Saudi Vision 2030',
        category: 'manufacturing',
        description: 'Manufacturing positions for new industrial facilities',
        requirements: {
            required_languages: ['English'],
            min_age: 21,
            max_age: 45
        },
        wiggle_room: { age_tolerance_years: 3 },
        positions_available: 50,
        salary_range: '$500-700/month',
        location: 'Riyadh, Saudi Arabia'
    },
    {
        title: 'Executive Protection - Abu Dhabi',
        category: 'security',
        description: 'High-level security for VIP clients',
        requirements: {
            min_height_cm: 175,
            max_height_cm: 195,
            required_languages: ['English', 'Arabic'],
            min_age: 25,
            max_age: 40,
            licenses: ['security_license', 'firearms'],
            experience_years: 5
        },
        wiggle_room: { height_tolerance_cm: 3, age_tolerance_years: 1 },
        positions_available: 5,
        salary_range: '$1500-2500/month',
        location: 'Abu Dhabi, UAE'
    },
    {
        title: 'Restaurant Crew - Kuwait',
        category: 'hospitality',
        description: 'Restaurant and catering staff positions',
        requirements: {
            required_languages: ['English'],
            min_age: 20,
            max_age: 35,
            experience_years: 1
        },
        wiggle_room: { experience_tolerance_years: 1 },
        positions_available: 30,
        salary_range: '$450-600/month',
        location: 'Kuwait City, Kuwait'
    }
];

// Mock projects data for the projects table
const mockProjectsData = [
    {
        title: 'Dubai Mall Security Operations',
        client_name: 'Emaar Properties',
        industry_type: 'Security Services',
        description: 'Comprehensive security services for Dubai Mall including patrol, surveillance, and customer assistance. Requires professional guards with excellent communication skills and experience in high-traffic commercial environments.',
        countries: ['United Arab Emirates'],
        status: 'active',
        priority: 'high',
        total_positions: 25,
        filled_positions: 8,
        start_date: '2024-03-15',
        interview_date: '2024-02-28',
        end_date: '2025-03-15',
        benefits: {
            health_insurance: true,
            accommodation: true,
            transportation: 'company_bus',
            annual_leave: '30_days',
            bonus: 'performance_based'
        },
        salary_info: {
            base_salary: 3200,
            currency: 'AED',
            payment_frequency: 'monthly',
            overtime_rate: 1.5,
            allowances: ['food_allowance', 'uniform_allowance']
        },
        contact_info: {
            primary_contact: 'Ahmed Al-Mansouri',
            email: 'ahmed.mansouri@emaar.com',
            phone: '+971-4-362-7777',
            department: 'Security Operations',
            address: 'Dubai Mall, Downtown Dubai, UAE'
        },
        requirements: {
            min_height: 170,
            max_height: 190,
            required_languages: ['English', 'Arabic'],
            min_age: 21,
            max_age: 45,
            experience_years: 2,
            certifications: ['Security License', 'First Aid'],
            education: 'High School',
            skills: ['Customer Service', 'Surveillance', 'Emergency Response']
        }
    },
    {
        title: 'Qatar Luxury Hotel Operations',
        client_name: 'Marriott International Qatar',
        industry_type: 'Hospitality',
        description: 'Hospitality staff positions for 5-star hotel including front desk, housekeeping, food & beverage service, and guest relations. Focus on delivering exceptional customer experience.',
        countries: ['Qatar'],
        status: 'active',
        priority: 'high',
        total_positions: 40,
        filled_positions: 15,
        start_date: '2024-04-01',
        interview_date: '2024-03-10',
        end_date: '2025-04-01',
        benefits: {
            health_insurance: true,
            accommodation: true,
            meals: 'provided',
            annual_leave: '28_days',
            training: 'continuous'
        },
        salary_info: {
            base_salary: 2800,
            currency: 'QAR',
            payment_frequency: 'monthly',
            tips_included: true,
            service_charge: 10
        },
        contact_info: {
            primary_contact: 'Sarah Johnson',
            email: 'sarah.johnson@marriott.com',
            phone: '+974-4000-8000',
            department: 'Human Resources',
            address: 'West Bay, Doha, Qatar'
        },
        requirements: {
            min_height: 160,
            required_languages: ['English'],
            min_age: 21,
            max_age: 40,
            experience_years: 1,
            education: 'High School',
            skills: ['Customer Service', 'Multilingual Capability', 'Professional Appearance']
        }
    },
    {
        title: 'Saudi Vision 2030 Manufacturing',
        client_name: 'SABIC Industrial Solutions',
        industry_type: 'Manufacturing',
        description: 'Manufacturing and production line positions for petrochemical facility. Includes machine operators, quality control inspectors, and production supervisors.',
        countries: ['Saudi Arabia'],
        status: 'active',
        priority: 'medium',
        total_positions: 60,
        filled_positions: 22,
        start_date: '2024-05-01',
        interview_date: '2024-04-15',
        end_date: '2026-05-01',
        benefits: {
            health_insurance: true,
            accommodation: true,
            transportation: 'company_transport',
            annual_leave: '30_days',
            pension: true
        },
        salary_info: {
            base_salary: 2500,
            currency: 'SAR',
            payment_frequency: 'monthly',
            shift_allowance: 500,
            hazard_pay: 300
        },
        contact_info: {
            primary_contact: 'Mohammad Al-Rashid',
            email: 'mohammad.rashid@sabic.com',
            phone: '+966-13-321-0000',
            department: 'Industrial Operations',
            address: 'Jubail Industrial City, Saudi Arabia'
        },
        requirements: {
            required_languages: ['English'],
            min_age: 21,
            max_age: 45,
            experience_years: 1,
            certifications: ['Safety Training', 'Machine Operation'],
            education: 'Technical Diploma',
            physical_requirements: 'Good health, ability to work in industrial environment'
        }
    },
    {
        title: 'Kuwait Healthcare Support Services',
        client_name: 'Al-Sabah Medical District',
        industry_type: 'Healthcare',
        description: 'Healthcare support positions including patient care assistants, medical equipment technicians, and facility maintenance staff.',
        countries: ['Kuwait'],
        status: 'pending',
        priority: 'high',
        total_positions: 35,
        filled_positions: 0,
        start_date: '2024-06-01',
        interview_date: '2024-05-15',
        end_date: '2025-06-01',
        benefits: {
            health_insurance: true,
            accommodation: true,
            meals: 'subsidized',
            annual_leave: '35_days',
            medical_allowance: true
        },
        salary_info: {
            base_salary: 400,
            currency: 'KWD',
            payment_frequency: 'monthly',
            night_shift_allowance: 50,
            medical_allowance: 30
        },
        contact_info: {
            primary_contact: 'Dr. Fatima Al-Zahra',
            email: 'fatima.alzahra@sabahmedical.kw',
            phone: '+965-2481-7777',
            department: 'Medical Administration',
            address: 'Sabah Medical District, Kuwait City'
        },
        requirements: {
            required_languages: ['English', 'Arabic'],
            min_age: 22,
            max_age: 50,
            experience_years: 1,
            certifications: ['Basic Life Support', 'Healthcare Training'],
            education: 'Diploma in Healthcare or equivalent',
            background_check: 'required'
        }
    },
    {
        title: 'Oman Tourism & Hospitality Development',
        client_name: 'Omran Group',
        industry_type: 'Tourism',
        description: 'Tourism and hospitality positions for new resort development including tour guides, hotel staff, restaurant service, and guest experience coordinators.',
        countries: ['Oman'],
        status: 'planning',
        priority: 'medium',
        total_positions: 45,
        filled_positions: 0,
        start_date: '2024-07-01',
        interview_date: '2024-06-10',
        end_date: '2026-07-01',
        benefits: {
            health_insurance: true,
            accommodation: true,
            meals: 'provided',
            annual_leave: '30_days',
            training_programs: true
        },
        salary_info: {
            base_salary: 500,
            currency: 'OMR',
            payment_frequency: 'monthly',
            tips_permitted: true,
            annual_bonus: 'performance_based'
        },
        contact_info: {
            primary_contact: 'Hassan Al-Baluchi',
            email: 'hassan.baluchi@omran.om',
            phone: '+968-24-123456',
            department: 'Tourism Development',
            address: 'Muscat Hills, Muscat, Oman'
        },
        requirements: {
            required_languages: ['English'],
            preferred_languages: ['Arabic'],
            min_age: 21,
            max_age: 40,
            experience_years: 1,
            skills: ['Customer Service', 'Cultural Awareness', 'Communication'],
            personality_traits: ['Friendly', 'Professional', 'Adaptable']
        }
    },
    {
        title: 'Bahrain Financial District Operations',
        client_name: 'Bahrain World Trade Center',
        industry_type: 'Corporate Services',
        description: 'Corporate support services including office administration, security, cleaning, and maintenance for premium office buildings in Bahrain Financial Harbor.',
        countries: ['Bahrain'],
        status: 'active',
        priority: 'low',
        total_positions: 30,
        filled_positions: 18,
        start_date: '2024-03-01',
        interview_date: '2024-02-15',
        end_date: '2025-03-01',
        benefits: {
            health_insurance: true,
            transportation: 'allowance',
            annual_leave: '25_days',
            training: 'provided'
        },
        salary_info: {
            base_salary: 350,
            currency: 'BHD',
            payment_frequency: 'monthly',
            overtime_available: true,
            annual_increment: 5
        },
        contact_info: {
            primary_contact: 'Amira Al-Khalifa',
            email: 'amira.khalifa@bwtc.bh',
            phone: '+973-1721-1111',
            department: 'Facilities Management',
            address: 'Manama, Bahrain'
        },
        requirements: {
            required_languages: ['English'],
            min_age: 21,
            max_age: 45,
            education: 'High School',
            skills: ['Professional Demeanor', 'Reliability', 'Basic Computer Skills']
        }
    }
];

/**
 * Seed mock data
 */
router.post('/seed', authenticate, async (req, res, next) => {
    try {
        const results = {
            candidates: [],
            jobs: [],
            applications: []
        };

        // Insert mock candidates and their CVs
        for (const candidate of mockCandidates) {
            try {
                // Check if candidate already exists
                const existing = await pool.query(
                    'SELECT id FROM candidates WHERE phone = $1',
                    [candidate.phone]
                );

                if (existing.rows.length > 0) {
                    results.candidates.push({ phone: candidate.phone, status: 'exists' });
                    continue;
                }

                // Insert candidate
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
                        candidate.skills,
                        JSON.stringify({
                            height_cm: candidate.height_cm,
                            age: candidate.age,
                            experience_years: candidate.experience_years
                        })
                    ]
                );

                const newCandidate = candidateResult.rows[0];

                // Insert CV
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
                            languages: candidate.skills.filter(s => ['English', 'Arabic', 'Hindi', 'Sinhala', 'Tamil', 'French'].includes(s))
                        }),
                        true
                    ]
                );

                results.candidates.push({ id: newCandidate.id, name: candidate.name, status: 'created' });
            } catch (error) {
                results.candidates.push({ name: candidate.name, status: 'error', message: error.message });
            }
        }

        // Insert mock projects/jobs
        for (const job of mockProjects) {
            try {
                const existing = await pool.query(
                    'SELECT id FROM jobs WHERE title = $1',
                    [job.title]
                );

                if (existing.rows.length > 0) {
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
                        JSON.stringify(job.requirements),
                        JSON.stringify(job.wiggle_room),
                        job.positions_available,
                        job.salary_range,
                        job.location,
                        req.user.id
                    ]
                );

                results.jobs.push({ id: jobResult.rows[0].id, title: job.title, status: 'created' });
            } catch (error) {
                results.jobs.push({ title: job.title, status: 'error', message: error.message });
            }
        }

        res.json({
            message: 'Mock data seeded successfully',
            results
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Get mock candidates for testing
 */
router.get('/candidates', authenticate, async (req, res) => {
    res.json({
        data: mockCandidates,
        total: mockCandidates.length
    });
});

/**
 * Get mock projects for testing
 */
router.get('/projects', authenticate, async (req, res) => {
    res.json({
        data: mockProjects,
        total: mockProjects.length
    });
});

/**
 * Clear all mock data (be careful!)
 */
router.delete('/clear', authenticate, async (req, res, next) => {
    try {
        // Delete applications first (foreign key)
        await pool.query('DELETE FROM applications WHERE candidate_id IN (SELECT id FROM candidates WHERE phone LIKE $1)', ['+9477%']);

        // Delete cv_files
        await pool.query('DELETE FROM cv_files WHERE candidate_id IN (SELECT id FROM candidates WHERE phone LIKE $1)', ['+9477%']);

        // Delete communications
        await pool.query('DELETE FROM communications WHERE candidate_id IN (SELECT id FROM candidates WHERE phone LIKE $1)', ['+9477%']);

        // Delete mock candidates
        const result = await pool.query('DELETE FROM candidates WHERE phone LIKE $1', ['+9477%']);

        res.json({
            message: 'Mock data cleared',
            deleted_count: result.rowCount
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;

// Export mock arrays for testing purposes
module.exports.mockCandidates = mockCandidates;
module.exports.mockProjects = mockProjects;
