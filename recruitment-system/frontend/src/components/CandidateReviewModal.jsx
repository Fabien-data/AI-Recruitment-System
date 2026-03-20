import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  X, Phone, Mail, Globe, FileText, Download, Eye,
  Sparkles, AlertCircle, Loader2, User, Briefcase, FolderOpen,
} from 'lucide-react'
import { getCandidate, updateCandidate } from '../api'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

// ── Language helpers ───────────────────────────────────────────────────────

const LANG_LABELS = {
  en:       'English',
  si:       'Sinhala',
  ta:       'Tamil',
  singlish: 'Singlish',
  tanglish: 'Tanglish',
}

/** Returns the best language label for a candidate record. */
function langLabel(candidate) {
  // Prefer the precise register stored in metadata
  let register = null
  try {
    const meta = candidate.metadata
      ? (typeof candidate.metadata === 'string' ? JSON.parse(candidate.metadata) : candidate.metadata)
      : null
    register = meta?.language_register || null
  } catch (_) {}

  const code = register || candidate.preferred_language || 'en'
  return LANG_LABELS[code] || code.toUpperCase()
}

function langBadgeColor(candidate) {
  const meta = (() => {
    try {
      const m = candidate.metadata
      return m ? (typeof m === 'string' ? JSON.parse(m) : m) : {}
    } catch (_) { return {} }
  })()
  const code = meta?.language_register || candidate.preferred_language || 'en'
  return {
    en:       'bg-blue-100 text-blue-700',
    si:       'bg-orange-100 text-orange-700',
    ta:       'bg-green-100 text-green-700',
    singlish: 'bg-purple-100 text-purple-700',
    tanglish: 'bg-teal-100 text-teal-700',
  }[code] || 'bg-gray-100 text-gray-600'
}

function getInitials(name = '') {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

const AVATAR_COLORS = [
  'bg-indigo-600', 'bg-violet-600', 'bg-sky-600',
  'bg-emerald-600', 'bg-rose-600', 'bg-amber-600',
]

function avatarColor(name = '') {
  const code = [...name].reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[code % AVATAR_COLORS.length]
}

function parseSkills(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
}

function cvUrl(cv) {
  const base = import.meta.env.VITE_API_URL || ''
  const url = cv.resolved_file_url || cv.file_url || ''
  if (!url || url.startsWith('chatbot://')) return null
  return url.startsWith('http') ? url : `${base}${url}`
}

function documentCategory(cv) {
  if (cv?.document_category) return cv.document_category
  try {
    const parsed = typeof cv?.parsed_data === 'string'
      ? JSON.parse(cv.parsed_data)
      : cv?.parsed_data
    return parsed?.__document_category === 'additional' ? 'additional' : 'cv'
  } catch (_) {
    return 'cv'
  }
}

// ── Stat card ───────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon }) {
  return (
    <div className="flex flex-col gap-1 bg-gray-50 rounded-xl px-4 py-3 min-w-0">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider">
        {Icon && <Icon size={13} />} {label}
      </span>
      <span className="text-sm font-bold text-gray-900 truncate">
        {value ?? <span className="text-gray-400 font-normal">—</span>}
      </span>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

const TABS = ['Overview', 'Remarks & Notes', 'Projects', 'Assign Project']

export function CandidateReviewModal({ candidateId, open, onClose }) {
  const [activeTab, setActiveTab] = useState('Overview')
  const [quickNote, setQuickNote] = useState('')
  const [noteDirty, setNoteDirty] = useState(false)
  const [expandedCVs, setExpandedCVs] = useState({})
  const queryClient = useQueryClient()

  const toggleCV = (id) => {
    setExpandedCVs(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const safeParseJSON = (str) => {
    if (!str) return null;
    if (typeof str === 'object') return str;
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  // Reset tab when a new candidate is opened
  useEffect(() => {
    if (open) {
      setActiveTab('Overview')
      setNoteDirty(false)
      setExpandedCVs({})
    }
  }, [open, candidateId])

  const { data: candidate, isLoading, error } = useQuery({
    queryKey: ['candidate', candidateId],
    queryFn: () => getCandidate(candidateId),
    enabled: open && !!candidateId,
    staleTime: 30_000,
  })

  // Sync quick note with fetched data
  useEffect(() => {
    if (candidate) {
      setQuickNote(candidate.notes || '')
      setNoteDirty(false)
    }
  }, [candidate?.id, candidate?.notes])

  const saveNotes = useMutation({
    mutationFn: () => updateCandidate(candidateId, { notes: quickNote }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate', candidateId] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setNoteDirty(false)
      toast.success('Notes saved')
    },
    onError: () => toast.error('Failed to save notes'),
  })

  if (!open) return null

  // ── Derived values ─────────────────────────────────────────────────────
  const skills = parseSkills(candidate?.skills)
  const allDocuments = candidate?.cvs || []
  const cvs = allDocuments.filter((doc) => documentCategory(doc) === 'cv')
  const additionalDocuments = allDocuments.filter((doc) => documentCategory(doc) === 'additional')
  const applications = candidate?.applications || []
  const uniqueProjects = [
    ...new Map(
      applications
        .filter((a) => a.project_id)
        .map((a) => [a.project_id, { id: a.project_id, title: a.project_title }])
    ).values(),
  ]

  const heightDisplay = candidate?.height_cm ? `${candidate.height_cm} cm` : null
  const ageDisplay = candidate?.age ? `${candidate.age} years` : null
  const expDisplay = candidate?.experience_years ? `${candidate.experience_years} years` : null

  const tabLabel = (t) => {
    if (t === 'Projects' && uniqueProjects.length > 0) return `Projects (${uniqueProjects.length})`
    return t
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Candidate review"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

      {/* Panel */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-xl flex flex-col"
        style={{ maxHeight: 'calc(100vh - 3rem)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-lg font-semibold text-gray-900 truncate">
            Review{candidate?.name ? `: ${candidate.name}` : ''}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-6 shrink-0 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === t
                  ? 'border-indigo-600 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {tabLabel(t)}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {isLoading && (
            <div className="flex items-center justify-center py-20 text-gray-400">
              <Loader2 className="animate-spin mr-2" size={22} />
              Loading…
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 px-6 py-8 text-red-600">
              <AlertCircle size={20} />
              <span>Could not load candidate data.</span>
            </div>
          )}

          {!isLoading && !error && candidate && (
            <>
              {/* ── OVERVIEW TAB ─────────────────────────────────────── */}
              {activeTab === 'Overview' && (
                <div className="px-6 py-5 space-y-5">
                  {/* Identity card */}
                  <div className="bg-indigo-50 rounded-2xl p-4 flex items-start gap-4">
                    <div
                      className={`${avatarColor(candidate.name)} w-14 h-14 rounded-full flex items-center justify-center text-white text-xl font-bold shrink-0`}
                    >
                      {getInitials(candidate.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <h3 className="text-base font-bold text-gray-900 truncate">
                          {candidate.name}
                        </h3>
                        <Badge status={candidate.status} className="capitalize text-xs shrink-0" />
                      </div>
                      <div className="flex flex-wrap gap-3 mt-1.5 text-sm text-gray-600">
                        <span className="flex items-center gap-1">
                          <Phone size={14} className="text-indigo-500" />
                          {candidate.phone}
                        </span>
                        {candidate.email && (
                          <span className="flex items-center gap-1">
                            <Mail size={14} className="text-indigo-500" />
                            {candidate.email}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Globe size={14} className="text-indigo-500" />
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${langBadgeColor(candidate)}`}>
                            {langLabel(candidate)}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Stat cards row */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <StatCard label="Source" value={candidate.source} icon={User} />
                    <StatCard label="Height" value={heightDisplay} />
                    <StatCard label="Age" value={ageDisplay} />
                    <StatCard label="Experience" value={expDisplay} icon={Briefcase} />
                  </div>

                  {/* Skills & Tags */}
                  {skills.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                        Skills &amp; Tags
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {skills.map((s) => (
                          <span
                            key={s}
                            className="px-3 py-1 bg-indigo-100 text-indigo-700 text-sm font-medium rounded-full"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {candidate.tags && (() => {
                    let tags = []
                    try { tags = Array.isArray(candidate.tags) ? candidate.tags : JSON.parse(candidate.tags) } catch (_) {}
                    return tags.length > 0 ? (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                          Tags
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {tags.map((t) => (
                            <span key={t} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null
                  })()}

                  {/* CV */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      CV
                    </h4>
                    {cvs.length === 0 ? (
                      <p className="text-sm text-gray-400 italic">No CV uploaded yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {cvs.map((cv) => {
                          const url = cvUrl(cv)
                          const parsedInsights = safeParseJSON(cv.parsed_data)
                          return (
                            <div
                              key={cv.id}
                              className="flex flex-col border border-gray-200 rounded-xl bg-white overflow-hidden"
                            >
                              <div className="flex items-center gap-3 px-4 py-3">
                                <FileText size={20} className="text-indigo-500 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-gray-900 truncate">
                                    {cv.file_name || 'CV Document'}
                                  </p>
                                  <p className="text-xs text-gray-400">
                                    {cv.uploaded_at
                                      ? `Uploaded on ${format(new Date(cv.uploaded_at), 'M/d/yyyy')}`
                                      : 'Uploaded'}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium transition-colors"
                                    onClick={() => toggleCV(cv.id)}
                                    disabled={!parsedInsights}
                                    title={parsedInsights ? 'Show AI insights' : 'AI insights not available'}
                                  >
                                    <Sparkles size={13} className={parsedInsights ? "text-indigo-500" : "text-gray-400"} />
                                    {expandedCVs[cv.id] ? 'Hide Insights' : 'AI Insights'}
                                  </button>
                                  {url ? (
                                    <>
                                      <a
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium transition-colors"
                                      >
                                        <Eye size={13} />
                                        View
                                      </a>
                                      <a
                                        href={url}
                                        download={cv.file_name || 'cv.pdf'}
                                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium transition-colors"
                                      >
                                        <Download size={13} />
                                        Download
                                      </a>
                                    </>
                                  ) : (
                                    <span className="text-xs text-gray-400 italic">No file link</span>
                                  )}
                                </div>
                              </div>
                              
                              {/* AI Insights Expansion */}
                              {expandedCVs[cv.id] && parsedInsights && (
                                <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-sm">
                                  <h5 className="font-semibold text-gray-900 mb-2 flex items-center gap-1">
                                    <Sparkles size={14} className="text-indigo-500" /> AI Extracted Details
                                  </h5>
                                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                    {Object.entries(parsedInsights).map(([key, val]) => {
                                      if (val == null || val === '' || key === 'raw_text' || key === 'language_register' || key.startsWith('__')) return null;
                                      if (Array.isArray(val)) {
                                        if (val.length === 0) return null;
                                        const formattedKey = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                                        return (
                                          <div key={key} className="col-span-2">
                                            <dt className="text-gray-500 text-xs">{formattedKey}</dt>
                                            <dd className="font-medium text-gray-900">{val.join(', ')}</dd>
                                          </div>
                                        )
                                      }
                                      if (typeof val === 'object') return null;
                                      const formattedKey = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                                      return (
                                        <div key={key}>
                                          <dt className="text-gray-500 text-xs">{formattedKey}</dt>
                                          <dd className="font-medium text-gray-900 break-words">{String(val)}</dd>
                                        </div>
                                      )
                                    })}
                                  </dl>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Additional Documents */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Additional Documents
                    </h4>
                    {additionalDocuments.length === 0 ? (
                      <p className="text-sm text-gray-400 italic">No additional documents uploaded yet.</p>
                    ) : (
                      <div className="space-y-2">
                        {additionalDocuments.map((doc) => {
                          const url = cvUrl(doc)
                          const parsedInsights = safeParseJSON(doc.parsed_data)
                          return (
                            <div
                              key={doc.id}
                              className="flex flex-col border border-gray-200 rounded-xl bg-white overflow-hidden"
                            >
                              <div className="flex items-center gap-3 px-4 py-3">
                                <FileText size={20} className="text-indigo-500 shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-gray-900 truncate">
                                    {doc.file_name || 'Additional Document'}
                                  </p>
                                  <p className="text-xs text-gray-400">
                                    {doc.uploaded_at
                                      ? `Uploaded on ${format(new Date(doc.uploaded_at), 'M/d/yyyy')}`
                                      : 'Uploaded'}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  <button
                                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium transition-colors"
                                    onClick={() => toggleCV(doc.id)}
                                    disabled={!parsedInsights}
                                    title={parsedInsights ? 'Show AI insights' : 'AI insights not available'}
                                  >
                                    <Sparkles size={13} className={parsedInsights ? "text-indigo-500" : "text-gray-400"} />
                                    {expandedCVs[doc.id] ? 'Hide Insights' : 'AI Insights'}
                                  </button>
                                  {url ? (
                                    <>
                                      <a
                                        href={url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium transition-colors"
                                      >
                                        <Eye size={13} />
                                        View
                                      </a>
                                      <a
                                        href={url}
                                        download={doc.file_name || 'document'}
                                        className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium transition-colors"
                                      >
                                        <Download size={13} />
                                        Download
                                      </a>
                                    </>
                                  ) : (
                                    <span className="text-xs text-gray-400 italic">No file link</span>
                                  )}
                                </div>
                              </div>

                              {/* AI Insights Expansion */}
                              {expandedCVs[doc.id] && parsedInsights && (
                                <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 text-sm">
                                  <h5 className="font-semibold text-gray-900 mb-2 flex items-center gap-1">
                                    <Sparkles size={14} className="text-indigo-500" /> AI Extracted Details
                                  </h5>
                                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                                    {Object.entries(parsedInsights).map(([key, val]) => {
                                      if (val == null || val === '' || key === 'raw_text' || key === 'language_register' || key.startsWith('__')) return null;
                                      if (Array.isArray(val)) {
                                        if (val.length === 0) return null;
                                        const formattedKey = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                                        return (
                                          <div key={key} className="col-span-2">
                                            <dt className="text-gray-500 text-xs">{formattedKey}</dt>
                                            <dd className="font-medium text-gray-900">{val.join(', ')}</dd>
                                          </div>
                                        )
                                      }
                                      if (typeof val === 'object') return null;
                                      const formattedKey = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                                      return (
                                        <div key={key}>
                                          <dt className="text-gray-500 text-xs">{formattedKey}</dt>
                                          <dd className="font-medium text-gray-900 break-words">{String(val)}</dd>
                                        </div>
                                      )
                                    })}
                                  </dl>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>

                  {/* Quick Notes */}
                  <div>
                    <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                      Quick Notes
                    </h4>
                    <textarea
                      rows={3}
                      value={quickNote}
                      onChange={(e) => { setQuickNote(e.target.value); setNoteDirty(true) }}
                      placeholder="Add a quick note about this candidate…"
                      className="w-full rounded-xl border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-gray-800 placeholder-yellow-400 focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none"
                    />
                    {noteDirty && (
                      <div className="flex justify-end mt-1.5">
                        <Button
                          variant="primary"
                          className="text-xs py-1.5 px-3"
                          loading={saveNotes.isPending}
                          onClick={() => saveNotes.mutate()}
                        >
                          Save Notes
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── REMARKS & NOTES TAB ─────────────────────────────── */}
              {activeTab === 'Remarks & Notes' && (
                <div className="px-6 py-5 space-y-4">
                  <h4 className="text-sm font-semibold text-gray-700">Recent Communications</h4>
                  {(candidate.communications || []).length === 0 ? (
                    <p className="text-sm text-gray-400 italic">No communication history yet.</p>
                  ) : (
                    <ul className="space-y-2 max-h-72 overflow-y-auto">
                      {candidate.communications.slice(0, 15).map((c) => (
                        <li key={c.id} className="bg-gray-50 rounded-xl px-4 py-3 text-sm">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-semibold uppercase text-gray-400">
                              {c.channel} · {c.direction}
                            </span>
                            {c.sent_at && (
                              <span className="text-xs text-gray-400">
                                {format(new Date(c.sent_at), 'MMM d, HH:mm')}
                              </span>
                            )}
                          </div>
                          <p className="text-gray-700">{c.content || '(no content)'}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="pt-2">
                    <h4 className="text-sm font-semibold text-gray-700 mb-2">Notes</h4>
                    <textarea
                      rows={4}
                      value={quickNote}
                      onChange={(e) => { setQuickNote(e.target.value); setNoteDirty(true) }}
                      placeholder="Add notes about this candidate…"
                      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
                    />
                    {noteDirty && (
                      <div className="flex justify-end mt-1.5">
                        <Button
                          variant="primary"
                          className="text-xs py-1.5 px-3"
                          loading={saveNotes.isPending}
                          onClick={() => saveNotes.mutate()}
                        >
                          Save Notes
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── PROJECTS TAB ──────────────────────────────────────── */}
              {activeTab === 'Projects' && (
                <div className="px-6 py-5">
                  {uniqueProjects.length === 0 && applications.length === 0 && (
                    <p className="text-sm text-gray-400 italic">Not assigned to any projects yet.</p>
                  )}
                  {applications.length > 0 && (
                    <div className="space-y-3">
                      {uniqueProjects.length === 0 ? (
                        // Fallback: show applications without project info
                        applications.map((app) => (
                          <div key={app.id} className="bg-gray-50 rounded-xl px-4 py-3">
                            <p className="text-sm font-semibold text-gray-900">{app.job_title}</p>
                            <p className="text-xs text-gray-500 capitalize mt-0.5">{app.job_category}</p>
                            <Badge status={app.status} className="mt-2 text-xs" />
                          </div>
                        ))
                      ) : (
                        uniqueProjects.map((proj) => {
                          const projApps = applications.filter((a) => a.project_id === proj.id)
                          return (
                            <div key={proj.id} className="bg-gray-50 rounded-xl px-4 py-3">
                              <div className="flex items-center gap-2 mb-2">
                                <FolderOpen size={16} className="text-indigo-500" />
                                <p className="text-sm font-semibold text-gray-900">{proj.title}</p>
                              </div>
                              <ul className="space-y-1 pl-6">
                                {projApps.map((a) => (
                                  <li key={a.id} className="flex items-center gap-2 text-sm text-gray-700">
                                    <span className="truncate">{a.job_title}</span>
                                    <Badge status={a.status} className="text-xs shrink-0" />
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── ASSIGN PROJECT TAB ────────────────────────────────── */}
              {activeTab === 'Assign Project' && (
                <div className="px-6 py-5">
                  <p className="text-sm text-gray-500 italic">
                    Use the Applications section to assign this candidate to a job within a project.
                  </p>
                  <div className="mt-4">
                    <Button variant="secondary" onClick={() => window.open(`/candidates/${candidateId}`, '_blank')}>
                      Open Full Profile
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
