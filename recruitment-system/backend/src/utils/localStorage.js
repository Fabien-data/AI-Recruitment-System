const path = require('path');
const fs = require('fs').promises;

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
const CV_SUBDIR = 'cv';

/**
 * Ensure upload directory exists (e.g. uploads/cv)
 */
async function ensureUploadDir(subdir = '') {
    const dir = subdir ? path.join(UPLOAD_DIR, subdir) : UPLOAD_DIR;
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

/**
 * Save a file buffer to local storage and return a URL path for storage in DB.
 * @param {Buffer} buffer - File content
 * @param {string} candidateId - Candidate UUID
 * @param {string} originalFilename - Original file name (for extension)
 * @param {string} mimeType - MIME type (optional)
 * @returns {Promise<string>} - Relative URL path e.g. /uploads/cv/abc123_1234567890.pdf
 */
async function saveCVFile(buffer, candidateId, originalFilename, mimeType) {
    const ext = path.extname(originalFilename) || '.pdf';
    const safeExt = ext.toLowerCase().replace(/[^a-z0-9.]/g, '');
    const fileName = `cv_${candidateId}_${Date.now()}${safeExt || '.bin'}`;
    const dir = await ensureUploadDir(CV_SUBDIR);
    const filePath = path.join(dir, fileName);
    await fs.writeFile(filePath, buffer);
    return `/uploads/${CV_SUBDIR}/${fileName}`;
}

module.exports = {
    ensureUploadDir,
    saveCVFile,
    UPLOAD_DIR
};
