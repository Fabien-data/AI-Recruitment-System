/**
 * Google Cloud Storage – CV Upload Utility
 * =========================================
 * Uploads CV files to a GCS bucket and returns the public URL.
 * Falls back to local disk storage when GCS is unavailable or not configured.
 *
 * Bucket: dewan-recruitment-cvs (us-central1, public read)
 * Public URL pattern: https://storage.googleapis.com/dewan-recruitment-cvs/<filename>
 */

const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'dewan-recruitment-cvs';
const GCS_ENABLED = process.env.GCS_ENABLED !== 'false'; // enabled unless explicitly disabled

let storageClient = null;
let bucket = null;

// Lazy-init GCS client so the server still starts if the SDK isn't installed yet
function getGCSBucket() {
    if (bucket) return bucket;
    try {
        const { Storage } = require('@google-cloud/storage');
        storageClient = new Storage();
        bucket = storageClient.bucket(GCS_BUCKET_NAME);
        logger.info(`GCS: initialised bucket "${GCS_BUCKET_NAME}"`);
        return bucket;
    } catch (err) {
        logger.warn(`GCS: Failed to initialise Storage client — ${err.message}. Will fall back to local disk.`);
        return null;
    }
}

/**
 * Upload a Buffer (or base64 string) to GCS.
 *
 * @param {Buffer|string} data        - File content as Buffer or base64 string
 * @param {string}        destName    - Destination filename inside the bucket (e.g. "cvs/uuid_file.pdf")
 * @param {string}        [mimeType]  - MIME type, defaults to "application/pdf"
 * @returns {Promise<string|null>}    - Public GCS URL or null on failure
 */
async function uploadToGCS(data, destName, mimeType = 'application/pdf') {
    if (!GCS_ENABLED) return null;

    const b = getGCSBucket();
    if (!b) return null;

    try {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');
        const file = b.file(destName);

        await file.save(buffer, {
            contentType: mimeType,
            metadata: { cacheControl: 'public, max-age=31536000' },
        });

        const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${destName}`;
        logger.info(`GCS: uploaded "${destName}" → ${publicUrl}`);
        return publicUrl;
    } catch (err) {
        logger.error(`GCS: upload failed for "${destName}" — ${err.message}`);
        return null;
    }
}

/**
 * Save a CV file: tries GCS first, falls back to local disk.
 *
 * @param {string} base64Data     - Base64-encoded file content
 * @param {string} originalName   - Original filename (e.g. "Driver_CV.pdf")
 * @param {string} candidateId    - UUID of the candidate (used in dest path)
 * @param {string} [uploadDir]    - Local base upload directory (fallback)
 * @returns {Promise<{url: string, name: string}>}
 */
async function saveCVFile(base64Data, originalName, candidateId, uploadDir) {
    const ts = Date.now();
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueName = `${ts}_${safeName}`;
    const destPath = `cvs/${candidateId}/${uniqueName}`;

    // Try GCS
    const gcsUrl = await uploadToGCS(base64Data, destPath);
    if (gcsUrl) {
        return { url: gcsUrl, name: uniqueName };
    }

    if (GCS_ENABLED) {
        // Force error if GCS is supposedly enabled but failed, instead of silent fallback
        const errorMsg = `GCS Upload failed for ${uniqueName}`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Fallback: local disk (only if GCS_ENABLED is explicitly false)
    try {
        const baseDir = uploadDir || path.join(__dirname, '../../uploads');
        const cvsDir = path.join(baseDir, 'cvs');
        if (!fs.existsSync(cvsDir)) fs.mkdirSync(cvsDir, { recursive: true });

        const localPath = path.join(cvsDir, uniqueName);
        fs.writeFileSync(localPath, Buffer.from(base64Data, 'base64'));
        logger.info(`Saved CV to local disk at ${localPath} (GCS disabled)`);
        return { url: `/uploads/cvs/${uniqueName}`, name: uniqueName };
    } catch (err) {
        logger.error(`Local disk save failed — ${err.message}`);
        return { url: null, name: uniqueName };
    }
}

module.exports = { uploadToGCS, saveCVFile };
