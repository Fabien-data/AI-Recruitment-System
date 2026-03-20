const { OpenAI } = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Create a chat completion
 */
async function createChatCompletion(messages, options = {}) {
    // MOCK MODE: Return simulated response if ENABLE_MOCK_AI is true or on error
    if (process.env.ENABLE_MOCK_AI === 'true') {
        console.log('Returning MOCK AI response');
        return getMockResponse(messages);
    }

    try {
        const completion = await openai.chat.completions.create({
            model: options.model || DEFAULT_MODEL,
            messages,
            temperature: options.temperature || 0.7,
            max_tokens: options.max_tokens || 1000,
            response_format: options.response_format || { type: 'text' }
        });
        return completion.choices[0].message.content;
    } catch (error) {
        console.error('OpenAI API Error:', error.message);
        
        // Fallback to mock if quota exceeded
        if (error.status === 429 || error.code === 'insufficient_quota') {
            console.warn('⚠️ OpenAI Quota Exceeded. Switching to MOCK response.');
            return getMockResponse(messages, options.response_format);
        }
        throw error;
    }
}

/**
 * Generate a mock response based on input
 */
function getMockResponse(messages, format) {
    const lastUserMessage = messages.slice().reverse().find(m => m.role === 'user')?.content.toLowerCase() || '';

    // If JSON format is requested (for parsing/extraction)
    if (format && format.type === 'json_object') {
        if (lastUserMessage.includes('extract') || lastUserMessage.includes('field')) {
            return JSON.stringify({ value: "Simulated Value" });
        }
        if (lastUserMessage.includes('match score')) {
            return JSON.stringify({ score: 0.85, reasons: ["Mock match reason"], concerns: [] });
        }
        // Resume parsing mock
        return JSON.stringify({
            full_name: "Mock Candidate",
            email: "mock@example.com",
            contact_numbers: ["0771234567"],
            experience: [{ company: "Mock Co", position: "Driver", years: 2 }],
            position_applied_for: "Driver"
        });
    }

    // Standard Chatbot Responses
    if (lastUserMessage.includes('detect the language')) return 'en';
    if (lastUserMessage.includes('salary')) return "The salary depends on the specific job role and your experience. Typically it ranges from 1500-2500 AED.";
    if (lastUserMessage.includes('cv') || lastUserMessage.includes('upload')) return "Please upload your CV (PDF or Image) here so we can review your application.";
    
    return "Hello! I am the Dewan Recruitment Assistant (Mock Mode). Please upload your CV to apply.";
}


/**
 * Parse resume using GPT-4o-mini
 */
async function parseResume(cvText) {
    const systemPrompt = `Extract structured data from this CV/resume for a recruitment application form.
Return JSON with these exact fields:
{
  "full_name": "",
  "address": "",
  "contact_numbers": [], 
  "passport_no": "",
  "nic_no": "",
  "email": "",
  "dob": "YYYY-MM-DD",
  "age": null,
  "gender": "", 
  "marital_status": "",
  "position_applied_for": "", 
  "secondary_position": "",
  "education": {
    "ol": false, 
    "al": false, 
    "diploma": false, 
    "degree": false,
    "details": [] 
  },
  "experience": [
    { "company": "", "position": "", "years": 0 }
  ],
  "languages": []
}

Rules:
- If field is not found, use null (or false for boolean education fields).
- "contact_numbers" should be an array of strings (up to 3).
- "education" booleans (ol, al, diploma, degree) should be true if the candidate has passed or possesses them.
- "position_applied_for" can be inferred from the objective or title.
- "experience" should be an array of objects with company, position, and number of years (convert to number if possible).
- Do not invent data.`;

    try {
        const content = await createChatCompletion(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: cvText }
            ],
            { response_format: { type: 'json_object' } }
        );
        
        return JSON.parse(content);
    } catch (error) {
        console.error('Resume parsing error:', error);
        throw error;
    }
}

/**
 * Generate chatbot response
 */
async function generateChatbotResponse(conversationHistory, systemPrompt) {
    return createChatCompletion([
        { role: 'system', content: systemPrompt },
        ...conversationHistory
    ]);
}

/**
 * Detect language from text
 */
async function detectLanguage(text) {
    try {
        const content = await createChatCompletion(
            [
                {
                    role: 'system',
                    content: 'Detect the language of the following text. Respond with only: "en", "si", or "ta"'
                },
                { role: 'user', content: text }
            ],
            { temperature: 0, max_tokens: 10 }
        );
        
        const language = content.trim().toLowerCase();
        return ['en', 'si', 'ta'].includes(language) ? language : 'en';
    } catch (error) {
        console.error('Language detection error:', error);
        return 'en';
    }
}

/**
 * Calculate match score between candidate and job
 */
async function calculateMatchScore(candidateParsedData, jobRequirements) {
    const systemPrompt = `You are a recruitment matching expert. 
Analyze the candidate data against job requirements and return a match score between 0.0 and 1.0.
Also provide reasons for the score.

Return JSON in this format:
{
  "score": 0.85,
  "reasons": ["Meets height requirement", "Has required license", "Good English level"],
  "concerns": ["Less than desired experience"]
}`;

    try {
        const content = await createChatCompletion(
            [
                { role: 'system', content: systemPrompt },
                { 
                    role: 'user', 
                    content: `Candidate Data: ${JSON.stringify(candidateParsedData)}\n\nJob Requirements: ${JSON.stringify(jobRequirements)}`
                }
            ],
            { response_format: { type: 'json_object' } }
        );
        
        return JSON.parse(content);
    } catch (error) {
        console.error('Match score calculation error:', error);
        throw error;
    }
}

/**
 * Extract specific field from text
 */
async function extractField(text, fieldName, fieldType = 'string') {
    const systemPrompt = `Extract the value for field "${fieldName}" from the user's message.
Return JSON format: { "value": extracted_value }
If the user is not providing the information or the value is invalid, return { "value": null }.
Target type: ${fieldType}.
Example:
Field: age, Text: "I am 25 years old", Result: { "value": 25 }`;

    try {
        const content = await createChatCompletion(
            [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            { response_format: { type: 'json_object' } }
        );
        
        return JSON.parse(content).value;
    } catch (error) {
        console.error('Field extraction error:', error);
        return null;
    }
}

module.exports = {
    openai,
    createChatCompletion,
    parseResume,
    generateChatbotResponse,
    detectLanguage,
    calculateMatchScore,
    extractField
};
