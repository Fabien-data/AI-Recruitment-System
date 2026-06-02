import { Eye, Download, FileText, Image as ImageIcon, Clock } from 'lucide-react'
import { resolveDocumentUrl, isImageDocument, PENDING_URL } from '../../utils/documents'

/**
 * Shared inline document preview (CV / ID / certificate / photo).
 *
 * Renders images as <img> and PDFs/docs in an <iframe>, and degrades to a
 * "processing" (chatbot upload still syncing) or "no document" state. Reused by
 * CV Manager, the General Pool modal and the Communications documents panel so
 * image CVs preview identically everywhere instead of each page assuming PDF
 * (B001/B002/B004/B014).
 *
 * Pass either a `cv` row (file_url / resolved_file_url / file_name / file_type)
 * or an explicit `url` + `isImage`.
 */
export function DocumentPreview({ cv, url: urlProp, isImage: isImageProp, fileName, className = 'h-96' }) {
  const url = urlProp !== undefined ? urlProp : resolveDocumentUrl(cv)
  const isImage = isImageProp !== undefined ? isImageProp : isImageDocument(cv)
  const name = fileName || cv?.file_name || (isImage ? 'image' : 'document')

  if (url === PENDING_URL) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-amber-300 dark:border-amber-700/60 bg-amber-50/60 dark:bg-amber-900/10 text-amber-700 dark:text-amber-400 ${className}`}>
        <Clock size={26} />
        <p className="text-sm font-medium">Upload still processing</p>
        <p className="text-xs text-center px-4">The document is syncing from the chatbot — try again in a moment.</p>
      </div>
    )
  }

  if (!url) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/60 text-zinc-500 dark:text-zinc-400 ${className}`}>
        <FileText size={26} />
        <p className="text-sm font-medium">No document available</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden bg-white dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/80">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 min-w-0">
          {isImage ? <ImageIcon size={13} className="shrink-0" /> : <FileText size={13} className="shrink-0" />}
          <span className="truncate" title={name}>{name}</span>
        </span>
        <span className="flex items-center gap-1 shrink-0">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new tab"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-primary-50 hover:text-primary-700 dark:hover:bg-primary-950/40 dark:hover:text-primary-300 transition-colors"
          >
            <Eye size={13} /> Open
          </a>
          <a
            href={url}
            download={name}
            title="Download"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300 hover:bg-primary-50 hover:text-primary-700 dark:hover:bg-primary-950/40 dark:hover:text-primary-300 transition-colors"
          >
            <Download size={13} /> Download
          </a>
        </span>
      </div>
      <div className={className}>
        {isImage ? (
          <img src={url} alt={name} className="w-full h-full object-contain bg-zinc-100 dark:bg-zinc-950" />
        ) : (
          <iframe src={`${url}#toolbar=0`} className="w-full h-full" title={name} />
        )}
      </div>
    </div>
  )
}
