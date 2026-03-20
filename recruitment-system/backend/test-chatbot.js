/**
 * Manual Chatbot Test Script
 * Run with: node test-chatbot.js
 * 
 * This script tests the chatbot's AI capabilities without needing
 * actual WhatsApp/Messenger connections.
 */

require('dotenv').config();
const { 
    generateChatbotResponse, 
    detectLanguage, 
    extractField, 
    parseResume 
} = require('./src/config/openai');

const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testLanguageDetection() {
    log('\n========================================', 'cyan');
    log('TEST 1: Language Detection', 'cyan');
    log('========================================\n', 'cyan');

    const tests = [
        { text: 'Hello, I am looking for a job', expected: 'en', label: 'English' },
        { text: 'මට රැකියාවක් සොයනවා', expected: 'si', label: 'Sinhala' },
        { text: 'வேலை வேண்டும்', expected: 'ta', label: 'Tamil' }
    ];

    for (const test of tests) {
        try {
            const result = await detectLanguage(test.text);
            const passed = result === test.expected;
            log(`${passed ? '✓' : '✗'} ${test.label}: "${test.text.substring(0, 30)}..." => ${result}`, passed ? 'green' : 'red');
        } catch (error) {
            log(`✗ ${test.label}: Error - ${error.message}`, 'red');
        }
    }
}

async function testChatbotResponses() {
    log('\n========================================', 'cyan');
    log('TEST 2: Chatbot Responses', 'cyan');
    log('========================================\n', 'cyan');

    const systemPrompt = `You are a friendly recruitment assistant for a Sri Lankan recruitment agency.
You help candidates apply for overseas jobs.
The candidate has NOT uploaded their CV yet.
Your goals:
1. Greet them warmly
2. Answer basic questions about jobs
3. Ask them to upload their CV to proceed

Keep responses concise (2-3 sentences).`;

    const conversations = [
        { user: 'Hello', description: 'Initial greeting' },
        { user: 'I saw your ad for drivers in Dubai', description: 'Job inquiry' },
        { user: 'What is the salary?', description: 'Salary question' },
        { user: 'How do I apply?', description: 'Application process' }
    ];

    let history = [];
    
    for (const conv of conversations) {
        history.push({ role: 'user', content: conv.user });
        
        log(`\n[${conv.description}]`, 'yellow');
        log(`User: ${conv.user}`, 'blue');
        
        try {
            const response = await generateChatbotResponse(history, systemPrompt);
            log(`Bot: ${response}`, 'green');
            history.push({ role: 'assistant', content: response });
        } catch (error) {
            log(`Error: ${error.message}`, 'red');
        }
    }
}

async function testFieldExtraction() {
    log('\n========================================', 'cyan');
    log('TEST 3: Field Extraction', 'cyan');
    log('========================================\n', 'cyan');

    const tests = [
        { text: 'I am 28 years old', field: 'age', type: 'number' },
        { text: 'My email is john@example.com', field: 'email', type: 'string' },
        { text: 'You can call me at 0771234567', field: 'contact_numbers', type: 'string' },
        { text: 'My passport number is N1234567', field: 'passport_no', type: 'string' },
        { text: 'I am married', field: 'marital_status', type: 'string' },
        { text: 'Hello there', field: 'age', type: 'number' } // Should return null
    ];

    for (const test of tests) {
        try {
            const result = await extractField(test.text, test.field, test.type);
            const hasResult = result !== null;
            log(`${hasResult ? '✓' : '○'} "${test.text}" => ${test.field}: ${result}`, hasResult ? 'green' : 'yellow');
        } catch (error) {
            log(`✗ "${test.text}": Error - ${error.message}`, 'red');
        }
    }
}

async function testResumeParsing() {
    log('\n========================================', 'cyan');
    log('TEST 4: Resume Parsing', 'cyan');
    log('========================================\n', 'cyan');

    const sampleCV = `
CURRICULUM VITAE

Name: Kamal Perera
Address: 45/2, Temple Road, Nugegoda, Sri Lanka
Phone: +94 77 123 4567
Email: kamal.perera@email.com
NIC: 199012345678
Passport: N1234567
Date of Birth: 1990-05-15
Age: 35
Gender: Male
Marital Status: Married

OBJECTIVE
Seeking a position as a Heavy Vehicle Driver in the Middle East

WORK EXPERIENCE
1. ABC Transport (Pvt) Ltd - Heavy Vehicle Driver
   Duration: 2015-2020 (5 years)
   
2. XYZ Logistics - Truck Driver  
   Duration: 2020-Present (3 years)

EDUCATION
- G.C.E O/L - Passed (2006)
- G.C.E A/L - Passed (2009)
- Heavy Vehicle License Training Certificate

LANGUAGES
- Sinhala (Native)
- English (Good)
- Arabic (Basic)
    `;

    log('Parsing sample CV...', 'yellow');
    
    try {
        const result = await parseResume(sampleCV);
        log('\nExtracted Data:', 'green');
        log(JSON.stringify(result, null, 2), 'reset');
        
        // Validate key fields
        const checks = [
            { field: 'full_name', value: result.full_name },
            { field: 'email', value: result.email },
            { field: 'phone', value: result.contact_numbers },
            { field: 'experience', value: result.experience }
        ];
        
        log('\nValidation:', 'yellow');
        for (const check of checks) {
            const hasValue = check.value && (Array.isArray(check.value) ? check.value.length > 0 : true);
            log(`  ${hasValue ? '✓' : '✗'} ${check.field}: ${hasValue ? 'Found' : 'Missing'}`, hasValue ? 'green' : 'red');
        }
    } catch (error) {
        log(`Error parsing CV: ${error.message}`, 'red');
    }
}

async function testMultilingualConversation() {
    log('\n========================================', 'cyan');
    log('TEST 5: Multilingual Conversation', 'cyan');
    log('========================================\n', 'cyan');

    const tests = [
        {
            language: 'English',
            userMessage: 'Hello, I want to apply for the driver job',
            systemPrompt: 'You are a recruitment assistant. Respond briefly in English.'
        },
        {
            language: 'Sinhala',
            userMessage: 'ආයුබෝවන්, මට රැකියාවට අයදුම් කරන්න ඕනේ',
            systemPrompt: 'You are a recruitment assistant. Respond briefly in Sinhala.'
        }
    ];

    for (const test of tests) {
        log(`\n[${test.language} Test]`, 'yellow');
        log(`User: ${test.userMessage}`, 'blue');
        
        try {
            const response = await generateChatbotResponse(
                [{ role: 'user', content: test.userMessage }],
                test.systemPrompt
            );
            log(`Bot: ${response}`, 'green');
        } catch (error) {
            log(`Error: ${error.message}`, 'red');
        }
    }
}

async function runAllTests() {
    log('\n╔════════════════════════════════════════╗', 'cyan');
    log('║     RECRUITMENT CHATBOT TEST SUITE     ║', 'cyan');
    log('╚════════════════════════════════════════╝', 'cyan');

    if (!process.env.OPENAI_API_KEY) {
        log('\n✗ ERROR: OPENAI_API_KEY not found in .env file', 'red');
        process.exit(1);
    }

    log('\nOpenAI Model: ' + (process.env.OPENAI_MODEL || 'gpt-4o-mini'), 'yellow');
    
    try {
        await testLanguageDetection();
        await testChatbotResponses();
        await testFieldExtraction();
        await testResumeParsing();
        await testMultilingualConversation();

        log('\n========================================', 'cyan');
        log('All tests completed!', 'green');
        log('========================================\n', 'cyan');
    } catch (error) {
        log(`\nTest suite error: ${error.message}`, 'red');
        console.error(error);
    }
}

// Run tests
runAllTests();
