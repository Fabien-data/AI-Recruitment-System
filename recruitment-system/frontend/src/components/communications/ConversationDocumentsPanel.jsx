import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, formatDistanceToNow } from 'date-fns'
import {
  FileText, Image as ImageIcon, Eye, Download, ChevronDown, ChevronRight,
  Paperclip, Clock, AlertTriangle,
} from 'lucide-react'
import { getCandidate } from '../../api'
import { getDocumentCategory, resolveDocumentUrl, isImageDocument, PENDING_URL } from '../../utils/documents'

// Documents & CVs panel that sits in the Communications right sidebar.
// Lists every CV the candidate has uploaded plus any additional documents
// (IDs, certificates, photos), so a project handler can grab files without
// scrolling the transcript or jumping out to CV Manager.
//
// The Candidates GET endpoint already enriches each cv_files row with
// resolved_file_url + document_category, so no new API is needed.
export function ConversationDocumentsPanel({ candidateId, defaultExpanded = true }) {
  const { data: candidate, isLoading } = useQuery({
    queryKey: ['candidate', candidateId],
    queryFn: () => getCandidate(candidateId),
    enabled: !!candidateId,
  })

  const cvs = candidate?.cvs || []
  const cvList = cvs.filter((cv) => getDocumentCategory(cv) === 'cv')
    .sort((a, b) => new Date(b.uploaded_at || 0) - new Date(a.uploaded_at || 0))
  // Everything non-CV (passport / certificate / photo / other) is a supporting doc.
  const extraList = cvs.filter((cv) => getDocumentCategory(cv) !== 'cv')
    .sort((a, b) => new Date(b.uploaded_at || 0) - new Date(a.uploaded_at || 0))

  const totalCount = cvList.length + extraList.length
  const [expanded, setExpanded] = useState(defaultExpanded && totalCount > 0)

  if (!candidateId) return null

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-t-2xl hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <ChevronDown size={16} className="text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
          ) : (
            <ChevronRight size={16} className="text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
          )}
          <Paperclip size={15} className="text-primary-600 dark:text-primary-400 flex-shrink-0" />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Documents &amp; CVs</h3>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">
          {totalCount}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-zinc-100 dark:border-zinc-800/60 pt-3">
          {isLoading ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-3">Loading documents…</p>
          ) : totalCount === 0 ? (
            <div className="text-center py-6">
              <Paperclip size={28} className="mx-auto text-zinc-300 dark:text-zinc-700 mb-1.5" />
              <p className="text-xs text-zinc-500 dark:text-zinc-400">No documents uploaded yet in this conversation.</p>
            </div>
          ) : (
            <>
              {cvList.length > 0 && (
                <DocumentGroup title="CVs" count={cvList.length}>
                  {cvList.map((cv) => <DocumentRow key={cv.id} cv={cv} />)}
                </DocumentGroup>
              )}
              {extraList.length > 0 && (
                <DocumentGroup title="Additional documents" count={extraList.length}>
                  {extraList.map((cv) => <DocumentRow key={cv.id} cv={cv} />)}
                </DocumentGroup>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function DocumentGroup({ title, count, children }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5 px-1">
        {title} <span className="ml-1 font-normal text-zinc-400">({count})</span>
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function DocumentRow({ cv }) {
  const isImage = isImageDocument(cv)
  const url = resolveDocumentUrl(cv)
  const pending = url === PENDING_URL || !url
  const name = cv.file_name || (isImage ? 'image' : 'document')
  const uploadedAt = cv.uploaded_at ? new Date(cv.uploaded_at) : null
  const Icon = isImage ? ImageIcon : FileText

  return (
    <div className="group flex items-start gap-2.5 rounded-xl border border-zinc-100 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40 hover:bg-white dark:hover:bg-zinc-800/60 transition-colors p-2.5">
      <div className={`rounded-lg p-1.5 flex-shrink-0 ${isImage ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'}`}>
        <Icon size={14} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate" title={name}>{name}</p>
        <p className="text-[10px] text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1 mt-0.5">
          <Clock size={9} />
          {uploadedAt ? (
            <span title={format(uploadedAt, 'PPpp')}>{formatDistanceToNow(uploadedAt, { addSuffix: true })}</span>
          ) : (
            <span>unknown date</span>
          )}
          {cv.is_primary && (
            <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[9px] font-semibold">
              PRIMARY
            </span>
          )}
        </p>
        {pending && (
          <p className="text-[10px] text-amber-700 dark:text-amber-400 inline-flex items-center gap-1 mt-1">
            <AlertTriangle size={9} />
            Upload still processing — try again in a moment
          </p>
        )}
      </div>
      {!pending && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center rounded-md w-7 h-7 text-zinc-600 dark:text-zinc-400 hover:bg-primary-50 hover:text-primary-700 dark:hover:bg-primary-950/40 dark:hover:text-primary-300 transition-colors"
            title="Open in new tab"
          >
            <Eye size={13} />
          </a>
          <a
            href={url}
            download={name}
            className="inline-flex items-center justify-center rounded-md w-7 h-7 text-zinc-600 dark:text-zinc-400 hover:bg-primary-50 hover:text-primary-700 dark:hover:bg-primary-950/40 dark:hover:text-primary-300 transition-colors"
            title="Download"
          >
            <Download size={13} />
          </a>
        </div>
      )}
    </div>
  )
}
