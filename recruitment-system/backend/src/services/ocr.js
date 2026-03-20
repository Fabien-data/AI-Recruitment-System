const tesseract = require('tesseract.js');
const vision = require('@google-cloud/vision');
const fs = require('fs').promises;

const GOOGLE_VISION_ENABLED = process.env.GOOGLE_VISION_ENABLED === 'true';

// Initialize Google Vision client if credentials are provided
let visionClient;
if (GOOGLE_VISION_ENABLED && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    visionClient = new vision.ImageAnnotatorClient();
}

/**
 * Extract text from image/PDF using OCR
 */
async function extractTextFromImage(filePath) {
    try {
        // Try Google Vision first (better quality)
        if (visionClient) {
            return await extractWithGoogleVision(filePath);
        }
        
        // Fallback to Tesseract (free but lower quality)
        return await extractWithTesseract(filePath);
    } catch (error) {
        console.error('OCR extraction error:', error);
        throw error;
    }
}

/**
 * Extract text using Google Vision API
 */
async function extractWithGoogleVision(filePath) {
    try {
        const [result] = await visionClient.textDetection(filePath);
        const detections = result.textAnnotations;
        
        if (detections && detections.length > 0) {
            return detections[0].description;
        }
        
        return '';
    } catch (error) {
        console.error('Google Vision error:', error);
        // Fallback to Tesseract if Google Vision fails
        return await extractWithTesseract(filePath);
    }
}

/**
 * Extract text using Tesseract.js
 */
async function extractWithTesseract(filePath) {
    try {
        const { data: { text } } = await tesseract.recognize(
            filePath,
            'eng+sin+tam', // English + Sinhala + Tamil
            {
                logger: m => console.log(m) // Optional: log progress
            }
        );
        
        return text;
    } catch (error) {
        console.error('Tesseract error:', error);
        throw error;
    }
}

/**
 * Extract text from PDF
 */
async function extractTextFromPDF(filePath) {
    // For PDF text extraction, we can use pdf-parse library
    // This is a placeholder - implement based on your needs
    const pdfParse = require('pdf-parse');
    
    try {
        const dataBuffer = await fs.readFile(filePath);
        const data = await pdfParse(dataBuffer);
        return data.text;
    } catch (error) {
        console.error('PDF text extraction error:', error);
        // If PDF text extraction fails, try OCR on PDF pages
        return await extractTextFromImage(filePath);
    }
}

/**
 * Main function to extract text from any file type
 */
async function extractText(filePath, fileType) {
    if (fileType === 'pdf') {
        return await extractTextFromPDF(filePath);
    } else if (['jpg', 'jpeg', 'png', 'gif', 'bmp'].includes(fileType)) {
        return await extractTextFromImage(filePath);
    } else {
        throw new Error(`Unsupported file type: ${fileType}`);
    }
}

module.exports = {
    extractText,
    extractTextFromImage,
    extractTextFromPDF
};
