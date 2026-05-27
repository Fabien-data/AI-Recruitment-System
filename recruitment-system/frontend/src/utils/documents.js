// Shared helpers for rendering candidate documents (CVs + additional files).
// Originally duplicated in CandidateDetail.jsx; extracted so the
// Communications page's ConversationDocumentsPanel can stay consistent.

// 'cv' for primary CVs, 'additional' for IDs/certificates/photos. Tolerates
// either a `document_category` set by the backend or the legacy marker in
// parsed_data.__document_category.
export function getDocumentCategory(cv) {
  if (cv?.document_category) return cv.document_category
  try {
    const parsed = typeof cv?.parsed_data === 'string' ? JSON.parse(cv.parsed_data) : cv?.parsed_data
    return parsed?.__document_category === 'additional' ? 'additional' : 'cv'
  } catch {
    return 'cv'
  }
}

// Sentinel returned by resolveDocumentUrl when the upload is still in transit
// (chatbot has the file but hasn't uploaded to GCS yet). UI should render a
// "Processing" pill instead of View/Download buttons.
export const PENDING_URL = '__pending__'

export function resolveDocumentUrl(cv) {
  const raw = cv?.resolved_file_url || cv?.file_url || ''
  if (!raw) return null
  if (raw.startsWith('chatbot://')) return PENDING_URL
  if (raw.startsWith('http')) return raw
  return `${import.meta.env.VITE_API_URL || ''}${raw}`
}

// Whether the document is renderable as an image preview.
export function isImageDocument(cv) {
  const ext = String(cv?.file_name || '').toLowerCase().split('.').pop()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return true
  const t = String(cv?.file_type || '').toLowerCase()
  return t === 'image' || t.startsWith('image/')
}
