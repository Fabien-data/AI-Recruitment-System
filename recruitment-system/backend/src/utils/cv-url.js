const fs = require('fs');
const path = require('path');

function sanitizeFileName(fileName) {
    if (!fileName) return null;
    return path.basename(String(fileName).trim());
}

function isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
}

function normalizeGcsLikeUrl(rawValue, bucketName) {
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!value) return null;

    const configuredBucket = String(bucketName || process.env.GCS_BUCKET_NAME || 'dewan-recruitment-cvs').trim();

    const gsMatch = value.match(/^gs:\/\/([^\/]+)\/(.+)$/i);
    if (gsMatch) {
        return `https://storage.googleapis.com/${gsMatch[1]}/${gsMatch[2]}`;
    }

    const gcsMatch = value.match(/^gcs:\/\/([^\/]+)\/(.+)$/i);
    if (gcsMatch) {
        return `https://storage.googleapis.com/${gcsMatch[1]}/${gcsMatch[2]}`;
    }

    const bucketPrefixedMatch = value.match(/^([a-z0-9._-]+)\/(.+)$/i);
    if (bucketPrefixedMatch) {
        const maybeBucket = bucketPrefixedMatch[1];
        const objectPath = bucketPrefixedMatch[2];
        if (maybeBucket === configuredBucket) {
            return `https://storage.googleapis.com/${maybeBucket}/${objectPath}`;
        }
    }

    if (/^(cvs|whatsapp|gmail)\//i.test(value)) {
        return `https://storage.googleapis.com/${configuredBucket}/${value}`;
    }

    return null;
}

function normalizeIncomingCvUrl(rawUrl, candidateId) {
    const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!value) return `chatbot://candidate/${candidateId}`;
    if (value.startsWith('chatbot://candidate/')) return value;
    if (isHttpUrl(value)) return value;
    if (value.startsWith('/')) return value;
    if (value.startsWith('uploads/')) return `/${value}`;

    const normalizedGcsUrl = normalizeGcsLikeUrl(value);
    if (normalizedGcsUrl) return normalizedGcsUrl;

    return `chatbot://candidate/${candidateId}`;
}

function resolveCvAccessUrl(cv, options = {}) {
    const bucketName = options.bucketName || process.env.GCS_BUCKET_NAME || 'dewan-recruitment-cvs';
    const uploadDir = options.uploadDir || path.join(__dirname, '../../uploads/cvs');
    const checkLocal = options.checkLocal !== false;

    const rawUrl = typeof cv?.file_url === 'string' ? cv.file_url.trim() : '';
    const fileName = sanitizeFileName(cv?.file_name);
    const candidateId = cv?.candidate_id || null;

    if (!rawUrl) {
        return { url: null, status: 'missing_url', source: 'none' };
    }

    if (isHttpUrl(rawUrl)) {
        return { url: rawUrl, status: 'ready', source: 'direct' };
    }

    if (rawUrl.startsWith('/')) {
        return { url: rawUrl, status: 'ready', source: 'relative' };
    }

    if (rawUrl.startsWith('uploads/')) {
        return { url: `/${rawUrl}`, status: 'ready', source: 'relative' };
    }

    const normalizedGcsUrl = normalizeGcsLikeUrl(rawUrl, bucketName);
    if (normalizedGcsUrl) {
        return { url: normalizedGcsUrl, status: 'ready', source: 'resolved_gcs_path' };
    }

    if (rawUrl.startsWith('chatbot://candidate/')) {
        if (fileName && checkLocal) {
            const localPath = path.join(uploadDir, fileName);
            if (fs.existsSync(localPath)) {
                return {
                    url: `/uploads/cvs/${fileName}`,
                    status: 'ready',
                    source: 'resolved_local'
                };
            }

            if (candidateId) {
                const candidateScopedLocalPath = path.join(uploadDir, candidateId, fileName);
                if (fs.existsSync(candidateScopedLocalPath)) {
                    return {
                        url: `/uploads/cvs/${candidateId}/${fileName}`,
                        status: 'ready',
                        source: 'resolved_local_candidate_scope'
                    };
                }
            }
        }

        const hasStableStoredName = Boolean(fileName && /^\d{10,}[_-]/.test(fileName));
        if (hasStableStoredName && candidateId) {
            return {
                url: `https://storage.googleapis.com/${bucketName}/cvs/${candidateId}/${fileName}`,
                status: 'ready',
                source: 'resolved_gcs'
            };
        }

        return { url: null, status: 'placeholder_unresolved', source: 'placeholder' };
    }

    return { url: null, status: 'unsupported_format', source: 'unknown' };
}

module.exports = {
    sanitizeFileName,
    normalizeIncomingCvUrl,
    resolveCvAccessUrl,
};