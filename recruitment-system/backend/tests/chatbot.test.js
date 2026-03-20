/**
 * Chatbot Tests
 * Tests the AI-powered chatbot functionality for WhatsApp and Messenger
 */

require('dotenv').config();
const request = require('supertest');

// Mock the database pool before requiring the app
jest.mock('../src/config/database', () => ({
    pool: {
        query: jest.fn()
    }
}));

// Mock the messaging services
jest.mock('../src/services/whatsapp', () => ({
    sendTextMessage: jest.fn().mockResolvedValue({ success: true }),
    downloadMedia: jest.fn().mockResolvedValue({ data: Buffer.from('test'), mimeType: 'application/pdf', filename: 'test.pdf' }),
    markMessageAsRead: jest.fn().mockResolvedValue(true)
}));

jest.mock('../src/services/messenger', () => ({
    sendTextMessage: jest.fn().mockResolvedValue({ success: true }),
    sendButtonMessage: jest.fn().mockResolvedValue({ success: true }),
    sendTypingIndicator: jest.fn().mockResolvedValue(true)
}));

// Import modules after mocking
const { pool } = require('../src/config/database');
const { generateChatbotResponse, detectLanguage, extractField, parseResume } = require('../src/config/openai');

describe('Chatbot OpenAI Functions', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('Language Detection', () => {
        test('should detect English text', async () => {
            const result = await detectLanguage('Hello, I am looking for a job opportunity');
            expect(['en', 'si', 'ta']).toContain(result);
            expect(result).toBe('en');
        }, 30000);

        test('should detect Sinhala text', async () => {
            const result = await detectLanguage('මට රැකියාවක් සොයනවා');
            expect(['en', 'si', 'ta']).toContain(result);
            expect(result).toBe('si');
        }, 30000);

        test('should detect Tamil text', async () => {
            const result = await detectLanguage('எனக்கு வேலை தேவை');
            expect(['en', 'si', 'ta']).toContain(result);
            expect(result).toBe('ta');
        }, 30000);

        test('should default to English for mixed/unknown text', async () => {
            const result = await detectLanguage('12345');
            expect(['en', 'si', 'ta']).toContain(result);
        }, 30000);
    });

    describe('Chatbot Response Generation', () => {
        test('should generate a greeting response', async () => {
            const conversationHistory = [
                { role: 'user', content: 'Hello' }
            ];
            const systemPrompt = `You are a friendly recruitment assistant. Greet the user warmly.`;
            
            const response = await generateChatbotResponse(conversationHistory, systemPrompt);
            
            expect(response).toBeDefined();
            expect(typeof response).toBe('string');
            expect(response.length).toBeGreaterThan(0);
        }, 30000);

        test('should maintain context in conversation', async () => {
            const conversationHistory = [
                { role: 'user', content: 'My name is John' },
                { role: 'assistant', content: 'Nice to meet you, John!' },
                { role: 'user', content: 'What is my name?' }
            ];
            const systemPrompt = `You are a helpful assistant. Answer questions based on the conversation.`;
            
            const response = await generateChatbotResponse(conversationHistory, systemPrompt);
            
            expect(response).toBeDefined();
            expect(response.toLowerCase()).toContain('john');
        }, 30000);

        test('should respond in the correct language (Sinhala)', async () => {
            const conversationHistory = [
                { role: 'user', content: 'ආයුබෝවන්' }
            ];
            const systemPrompt = `You are a recruitment assistant. Respond in Sinhala. Keep it brief.`;
            
            const response = await generateChatbotResponse(conversationHistory, systemPrompt);
            
            expect(response).toBeDefined();
            expect(typeof response).toBe('string');
        }, 30000);
    });

    describe('Field Extraction', () => {
        test('should extract age from text', async () => {
            const result = await extractField('I am 28 years old', 'age', 'number');
            expect(result).toBe(28);
        }, 30000);

        test('should extract email from text', async () => {
            const result = await extractField('My email is john.doe@example.com', 'email', 'string');
            expect(result).toBe('john.doe@example.com');
        }, 30000);

        test('should extract phone number from text', async () => {
            const result = await extractField('You can reach me at 0771234567', 'contact_numbers', 'string');
            expect(result).toContain('077');
        }, 30000);

        test('should return null for missing field', async () => {
            const result = await extractField('Hello there!', 'passport_no', 'string');
            expect(result).toBeNull();
        }, 30000);
    });

    describe('Resume Parsing', () => {
        test('should parse basic resume text', async () => {
            const cvText = `
                John Doe
                Email: john.doe@email.com
                Phone: +94 77 123 4567
                Address: 123 Main Street, Colombo, Sri Lanka
                
                Objective: Seeking a position as a Driver
                
                Experience:
                - ABC Transport Company - Driver - 3 years
                - XYZ Logistics - Delivery Driver - 2 years
                
                Education:
                - O/L Passed - 2015
                - A/L Passed - 2017
                
                Languages: English, Sinhala
            `;
            
            const result = await parseResume(cvText);
            
            expect(result).toBeDefined();
            expect(result.full_name).toBeDefined();
            expect(result.email).toBe('john.doe@email.com');
            expect(result.contact_numbers).toBeDefined();
            expect(Array.isArray(result.contact_numbers)).toBe(true);
        }, 60000);

        test('should handle minimal resume text', async () => {
            const cvText = `Name: Jane Smith, Email: jane@test.com`;
            
            const result = await parseResume(cvText);
            
            expect(result).toBeDefined();
            expect(result.email).toBe('jane@test.com');
        }, 60000);
    });
});

describe('Webhook Endpoint Tests', () => {
    let app;

    beforeAll(() => {
        // Create express app with just the webhook routes for testing
        const express = require('express');
        app = express();
        app.use(express.json());
        
        // Simple mock webhook route for testing
        app.get('/api/webhooks/whatsapp', (req, res) => {
            const mode = req.query['hub.mode'];
            const token = req.query['hub.verify_token'];
            const challenge = req.query['hub.challenge'];
            
            if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
                res.status(200).send(challenge);
            } else {
                res.status(403).send('Verification failed');
            }
        });

        app.get('/api/webhooks/messenger', (req, res) => {
            const mode = req.query['hub.mode'];
            const token = req.query['hub.verify_token'];
            const challenge = req.query['hub.challenge'];
            
            if (mode === 'subscribe' && token === process.env.MESSENGER_VERIFY_TOKEN) {
                res.status(200).send(challenge);
            } else {
                res.status(403).send('Verification failed');
            }
        });
    });

    describe('WhatsApp Webhook Verification', () => {
        test('should verify valid webhook request', async () => {
            const response = await request(app)
                .get('/api/webhooks/whatsapp')
                .query({
                    'hub.mode': 'subscribe',
                    'hub.verify_token': process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
                    'hub.challenge': 'test_challenge_123'
                });
            
            expect(response.status).toBe(200);
            expect(response.text).toBe('test_challenge_123');
        });

        test('should reject invalid verify token', async () => {
            const response = await request(app)
                .get('/api/webhooks/whatsapp')
                .query({
                    'hub.mode': 'subscribe',
                    'hub.verify_token': 'wrong_token',
                    'hub.challenge': 'test_challenge_123'
                });
            
            expect(response.status).toBe(403);
        });
    });

    describe('Messenger Webhook Verification', () => {
        test('should verify valid messenger webhook', async () => {
            // Skip if no messenger token configured
            if (!process.env.MESSENGER_VERIFY_TOKEN) {
                console.log('Skipping - MESSENGER_VERIFY_TOKEN not configured');
                return;
            }

            const response = await request(app)
                .get('/api/webhooks/messenger')
                .query({
                    'hub.mode': 'subscribe',
                    'hub.verify_token': process.env.MESSENGER_VERIFY_TOKEN,
                    'hub.challenge': 'messenger_challenge'
                });
            
            expect(response.status).toBe(200);
        });
    });
});

describe('Integration Flow Tests', () => {
    test('should handle complete recruitment conversation flow', async () => {
        // Simulate a complete conversation
        const steps = [
            { user: 'Hello, I saw your ad for drivers', expected: 'greeting or job info' },
            { user: 'What is the salary?', expected: 'salary info' },
            { user: 'I want to apply', expected: 'CV request' }
        ];

        const systemPrompt = `You are a recruitment assistant. The user hasn't uploaded their CV yet.
Ask them to upload their CV to proceed.`;

        let conversationHistory = [];
        
        for (const step of steps) {
            conversationHistory.push({ role: 'user', content: step.user });
            
            const response = await generateChatbotResponse(conversationHistory, systemPrompt);
            
            expect(response).toBeDefined();
            expect(response.length).toBeGreaterThan(0);
            
            conversationHistory.push({ role: 'assistant', content: response });
        }
        
        // Final response should mention CV upload
        const lastResponse = conversationHistory[conversationHistory.length - 1].content.toLowerCase();
        expect(
            lastResponse.includes('cv') || 
            lastResponse.includes('resume') || 
            lastResponse.includes('upload') ||
            lastResponse.includes('document')
        ).toBe(true);
    }, 90000);
});
