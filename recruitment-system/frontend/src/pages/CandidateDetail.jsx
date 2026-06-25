import { useParams, Link } from 'react-router-dom'
import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getCandidate, uploadCandidatePhoto } from '../api'
import { ArrowLeft, User, Mail, Phone, FileText, Briefcase, MessageSquare, ClipboardList, CheckSquare, Square, Download, Camera, FolderKanban, Globe, Pencil } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { EditCandidateModal } from '../components/EditCandidateModal'
import { CandidateOnboardingChecklist } from '../components/CandidateOnboardingChecklist'
import { CallRemarksPanel } from '../components/communications/CallRemarksPanel'
import { useRole } from '../stores/authStore'
import { format } from 'date-fns'
import { getDocumentCategory, resolveDocumentUrl, PENDING_URL } from '../utils/documents'
import { normalizeStatus } from '../constants/lifecycle'

const LANGUAGE_LABELS = {
  en: 'English',
  si: 'Sinhala',
  ta: 'Tamil',
  singlish: 'Singlish',
  tanglish: 'Tanglish',
}

// Canonical vocabulary: the only inactive application status is 'rejected'
// (the backend never emits withdrawn/dropped/archived). Legacy 'transferred'
// folds to 'rejected' via normalizeStatus, so it's treated as inactive too.
const INACTIVE_APPLICATION_STATUSES = new Set(['rejected'])

function parseCandidateMetadata(metadata) {
  if (!metadata) return {}
  if (typeof metadata === 'object') return metadata
  try {
    return JSON.parse(metadata)
  } catch {
    return {}
  }
}

function getCandidateLanguageLabel(candidate, metadata) {
  const code = metadata?.language_register || candidate?.preferred_language || 'en'
  return LANGUAGE_LABELS[code] || String(code).toUpperCase()
}

function getPrimaryApplication(applications) {
  return applications.find((application) => !INACTIVE_APPLICATION_STATUSES.has(normalizeStatus(String(application?.status || '').toLowerCase()))) || applications[0] || null
}

export default function CandidateDetail() {
  const { id } = useParams()
  const qc = useQueryClient()
  const { canEdit } = useRole()
  const photoInputRef = useRef(null)
  const [editOpen, setEditOpen] = useState(false)

  const { data: candidate, isLoading, error } = useQuery({
    queryKey: ['candidate', id],
    queryFn: () => getCandidate(id),
    enabled: !!id,
  })

  const photoMutation = useMutation({
    mutationFn: (formData) => uploadCandidatePhoto(id, formData),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['candidate', id] }),
  })

  function handlePhotoChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const fd = new FormData()
    fd.append('photo', file)
    photoMutation.mutate(fd)
  }

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Skeleton className="h-4 w-32 mb-6" />
        <Skeleton className="h-10 w-64 mb-2" />
        <Skeleton className="h-4 w-48 mb-8" />
        <Card>
          <Skeleton className="h-5 w-1/3 mb-4" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-full" />
        </Card>
      </div>
    )
  }

  if (error || !candidate) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Link to="/candidates" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6">
          <ArrowLeft size={20} /> Back to Candidates
        </Link>
        <div className="card text-center py-12">
          <p className="text-zinc-600 dark:text-zinc-400 font-medium">Candidate not found</p>
          <Link to="/candidates">
            <Button variant="primary" className="mt-4">Back to Candidates</Button>
          </Link>
        </div>
      </div>
    )
  }

  const metadata = parseCandidateMetadata(candidate.metadata)
  const documents = candidate.cvs || []
  const cvs = documents.filter((doc) => getDocumentCategory(doc) === 'cv')
  const additionalDocuments = documents.filter((doc) => getDocumentCategory(doc) === 'additional')
  const applications = candidate.applications || []
  const communications = candidate.communications || []
  const applicationForm = metadata.application_form || {}
  const primaryApplication = getPrimaryApplication(applications)
  const candidateAge = candidate.age || metadata.age || applicationForm.age || null
  const languageLabel = getCandidateLanguageLabel(candidate, metadata)

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <Link to="/candidates" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6 font-medium">
        <ArrowLeft size={20} aria-hidden /> Back to Candidates
      </Link>

      <div className="mb-8 flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="relative flex-shrink-0">
            <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-3xl border border-zinc-200 bg-zinc-100 shadow-sm">
              {candidate.photo_url ? (
                <img
                  src={`${import.meta.env.VITE_API_URL || ''}${candidate.photo_url}`}
                  alt={candidate.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <User size={36} className="text-zinc-300" />
              )}
            </div>
            {canEdit && (
              <>
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={photoMutation.isPending}
                  className="absolute -bottom-2 -right-2 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-900 text-white shadow-md transition-colors hover:bg-zinc-700 disabled:opacity-50"
                  title="Upload photo"
                >
                  <Camera size={14} />
                </button>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handlePhotoChange}
                />
              </>
            )}
          </div>

          <div className="space-y-4">
            <div className="flex flex-wrap items-start gap-3">
              <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-50 break-words">{candidate.name || candidate.phone || 'Unknown'}</h1>
              <Badge status={normalizeStatus(candidate.status)} className="text-sm" />
            </div>

            <div className="flex flex-wrap items-center gap-4 text-zinc-600 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1" title="WhatsApp Number">
                <Phone size={18} aria-hidden /> {candidate.phone || '-'}
              </span>
              {candidate.contact_phone && (
                <span className="inline-flex items-center gap-1" title="Call Number (non-WhatsApp)">
                  <Phone size={18} aria-hidden className="opacity-60" /> {candidate.contact_phone}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Mail size={18} aria-hidden /> {candidate.email || 'No email provided'}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Source</p>
                <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-50 break-words">{candidate.source || 'Unknown'}</p>
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Preferred Language</p>
                <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-50 break-words">{languageLabel}</p>
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Age</p>
                <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-50">{candidateAge ? `${candidateAge} years` : 'Not available'}</p>
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Application Status</p>
                <div className="mt-2">
                  {primaryApplication ? (
                    <Badge status={normalizeStatus(primaryApplication.status)} className="text-xs" />
                  ) : (
                    <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Not assigned</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 xl:justify-end">
          {canEdit && (
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
            >
              <Pencil size={16} aria-hidden /> Edit Profile
            </button>
          )}
          <Link
            to={`/communications?candidate=${candidate.id}`}
            className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
          >
            <MessageSquare size={16} aria-hidden /> Go to Chat
          </Link>
          <Link
            to={`/cv-manager?candidate=${candidate.id}`}
            className="inline-flex items-center gap-2 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-2.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
          >
            <FileText size={16} aria-hidden /> Open CV Manager
          </Link>
        </div>
      </div>

      {canEdit && (
        <EditCandidateModal
          candidate={candidate}
          open={editOpen}
          onClose={() => setEditOpen(false)}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4 flex items-center gap-2">
              <User size={20} aria-hidden /> Details
            </h2>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">WhatsApp Number</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-50 break-words">{candidate.phone || '-'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Call Number</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-50 break-words">{candidate.contact_phone || '-'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Email</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-50 break-words">{candidate.email || 'No email provided'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Source</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-50">{candidate.source}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Preferred language</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-50">{languageLabel}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Age</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-50">{candidateAge ? `${candidateAge} years` : '-'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Created</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-50">
                  {candidate.created_at ? format(new Date(candidate.created_at), 'MMM d, yyyy') : '-'}
                </dd>
              </div>
              {candidate.last_contact_at && (
                <div>
                  <dt className="text-zinc-500 dark:text-zinc-400">Last contact</dt>
                  <dd className="font-medium text-zinc-900 dark:text-zinc-50">
                    {format(new Date(candidate.last_contact_at), 'MMM d, yyyy')}
                  </dd>
                </div>
              )}
            </dl>
            {candidate.notes && (
              <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <dt className="text-zinc-500 dark:text-zinc-400 text-sm mb-1">Notes</dt>
                <dd className="text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">{candidate.notes}</dd>
              </div>
            )}
            {candidate.remarks && (
              <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <dt className="text-zinc-500 dark:text-zinc-400 text-sm mb-1">Chatbot Remarks</dt>
                <dd className="text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap bg-blue-50 border border-blue-100 rounded-md px-3 py-2">
                  {candidate.remarks}
                </dd>
              </div>
            )}
            {Array.isArray(candidate.preferences_log) && candidate.preferences_log.length > 0 && (
              <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <dt className="text-zinc-500 dark:text-zinc-400 text-sm mb-2">Preferences History ({candidate.preferences_log.length})</dt>
                <dd>
                  <ul className="space-y-1 text-sm">
                    {candidate.preferences_log.map((entry, i) => (
                      <li key={i} className="flex items-start justify-between gap-3 border-l-2 border-zinc-200 dark:border-zinc-800 pl-3">
                        <span className="text-zinc-700 dark:text-zinc-300">
                          <span className="font-medium">{entry.job_role || '—'}</span>
                          {entry.country && <span className="text-zinc-500 dark:text-zinc-400"> · {entry.country}</span>}
                          {entry.experience_years != null && <span className="text-zinc-500 dark:text-zinc-400"> · {entry.experience_years}y</span>}
                          {entry.source && <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-2">({entry.source})</span>}
                        </span>
                        {entry.ts && (
                          <span className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
                            {new Date(entry.ts).toLocaleDateString()}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </Card>

          {/* Call log & remarks — same engagement feed shown in the chat + CV
              Manager, so an agent's calls/notes follow the candidate everywhere. */}
          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-3 flex items-center gap-2">
              <MessageSquare size={20} aria-hidden /> Call log &amp; remarks
            </h2>
            <div className="-mx-2">
              <CallRemarksPanel candidateId={candidate.id} />
            </div>
          </Card>

          {Object.keys(applicationForm).length > 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4 flex items-center gap-2">
                <ClipboardList size={20} aria-hidden /> Digital Application Form
              </h2>
              
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">Position Applied For</label>
                    <div className="font-medium">{applicationForm.position_applied_for || '-'}</div>
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">Secondary Position</label>
                    <div className="font-medium">{applicationForm.secondary_position || '-'}</div>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 border-b border-zinc-200 dark:border-zinc-800 pb-1 mb-3">Personal Details</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div className="md:col-span-2">
                      <label className="text-zinc-500 dark:text-zinc-400">Full Name</label>
                      <div className="font-medium">{applicationForm.full_name || '-'}</div>
                    </div>
                    <div className="md:col-span-2">
                      <label className="text-zinc-500 dark:text-zinc-400">Address</label>
                      <div className="font-medium">{applicationForm.address || '-'}</div>
                    </div>
                    <div>
                      <label className="text-zinc-500 dark:text-zinc-400">Passport No</label>
                      <div className="font-medium">{applicationForm.passport_no || '-'}</div>
                    </div>
                    <div>
                      <label className="text-zinc-500 dark:text-zinc-400">N.I.C No</label>
                      <div className="font-medium">{applicationForm.nic_no || '-'}</div>
                    </div>
                    <div>
                      <label className="text-zinc-500 dark:text-zinc-400">Date of Birth</label>
                      <div className="font-medium">{applicationForm.dob || '-'}</div>
                    </div>
                    <div>
                      <label className="text-zinc-500 dark:text-zinc-400">Age</label>
                      <div className="font-medium">{applicationForm.age || '-'}</div>
                    </div>
                    <div>
                      <label className="text-zinc-500 dark:text-zinc-400">Gender</label>
                      <div className="font-medium capitalize">{applicationForm.gender || '-'}</div>
                    </div>
                    <div>
                      <label className="text-zinc-500 dark:text-zinc-400">Marital Status</label>
                      <div className="font-medium capitalize">{applicationForm.marital_status || '-'}</div>
                    </div>
                    {applicationForm.languages && (
                      <div className="md:col-span-2">
                        <label className="text-zinc-500 dark:text-zinc-400">Languages</label>
                        <div className="flex gap-2 mt-1">
                          {applicationForm.languages.map((lang, i) => (
                            <Badge key={i} status="default" className="bg-zinc-100 dark:bg-zinc-800 text-gray-800">{lang}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                   <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 border-b border-zinc-200 dark:border-zinc-800 pb-1 mb-3">Education Level</h3>
                   <div className="flex flex-wrap gap-4">
                      {['O/L', 'A/L', 'Diploma', 'Degree'].map((level) => {
                        const key = level.toLowerCase().replace('/', '').replace('degree', 'degree');
                        const schemaKey = key === 'o/l' ? 'ol' : key === 'a/l' ? 'al' : key;
                        const isChecked = applicationForm.education?.[schemaKey];
                        return (
                          <div key={level} className="flex items-center gap-2">
                             {isChecked ? <CheckSquare size={16} className="text-blue-600" /> : <Square size={16} className="text-zinc-400 dark:text-zinc-500" />}
                             <span className={isChecked ? 'font-medium text-zinc-900 dark:text-zinc-50' : 'text-zinc-500 dark:text-zinc-400'}>{level}</span>
                          </div>
                        )
                      })}
                   </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 border-b border-zinc-200 dark:border-zinc-800 pb-1 mb-3">Working Experience</h3>
                  {applicationForm.experience && applicationForm.experience.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="bg-zinc-50 dark:bg-zinc-900/60">
                            <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">Company</th>
                            <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">Position</th>
                            <th className="px-3 py-2 text-right font-medium text-zinc-500 dark:text-zinc-400">Years</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {applicationForm.experience.map((exp, idx) => (
                            <tr key={idx}>
                              <td className="px-3 py-2 text-zinc-900 dark:text-zinc-50">{exp.company}</td>
                              <td className="px-3 py-2 text-zinc-900 dark:text-zinc-50">{exp.position}</td>
                              <td className="px-3 py-2 text-right text-zinc-900 dark:text-zinc-50">{exp.years}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-zinc-500 dark:text-zinc-400 text-sm italic">No experience recorded.</p>
                  )}
                </div>
              </div>
            </Card>
          )}

          {documents.length > 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4 flex items-center gap-2">
                <FileText size={20} aria-hidden /> Documents
              </h2>

              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">CV</h3>
              {cvs.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">No CV uploaded yet.</p>
              ) : (
                <ul className="space-y-2 mb-4">
                  {cvs.map((cv) => {
                    const url = resolveDocumentUrl(cv)
                    return (
                      <li key={cv.id} className="flex items-center justify-between py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-0">
                        <span className="text-zinc-700 dark:text-zinc-300">{cv.file_name || 'CV'}</span>
                        {url === PENDING_URL ? (
                          <span className="text-xs text-amber-600 italic">CV processing — check back in a moment</span>
                        ) : url ? (
                          <div className="flex items-center gap-3">
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary-600 hover:text-primary-700 text-sm font-medium"
                            >
                              View
                            </a>
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              download={cv.file_name || 'cv'}
                              className="text-primary-600 hover:text-primary-700 text-sm font-medium inline-flex items-center gap-1"
                            >
                              <Download size={14} aria-hidden /> Download
                            </a>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}

              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Additional Documents</h3>
              {additionalDocuments.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">No additional documents uploaded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {additionalDocuments.map((doc) => {
                    const url = resolveDocumentUrl(doc)
                    return (
                      <li key={doc.id} className="flex items-center justify-between py-2 border-b border-zinc-100 dark:border-zinc-800/60 last:border-0">
                        <span className="text-zinc-700 dark:text-zinc-300">{doc.file_name || 'Additional Document'}</span>
                        {url && (
                          <div className="flex items-center gap-3">
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary-600 hover:text-primary-700 text-sm font-medium"
                            >
                              View
                            </a>
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              download={doc.file_name || 'document'}
                              className="text-primary-600 hover:text-primary-700 text-sm font-medium inline-flex items-center gap-1"
                            >
                              <Download size={14} aria-hidden /> Download
                            </a>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          )}

          {communications.length > 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4 flex items-center gap-2">
                <MessageSquare size={20} aria-hidden /> Recent communications
              </h2>
              <ul className="space-y-3 max-h-64 overflow-y-auto">
                {communications.slice(0, 10).map((c) => (
                  <li key={c.id} className="text-sm p-3 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg">
                    <span className="text-zinc-500 dark:text-zinc-400">{c.channel} · {c.direction}</span>
                    <p className="text-zinc-900 dark:text-zinc-50 mt-1">{c.content || '(no content)'}</p>
                    <p className="text-zinc-400 dark:text-zinc-500 text-xs mt-1">
                      {c.sent_at ? format(new Date(c.sent_at), 'MMM d, HH:mm') : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <CandidateOnboardingChecklist candidate={candidate} />

          <Card>
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              <FolderKanban size={20} aria-hidden /> Current Assignment
            </h2>
            {primaryApplication ? (
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Project</p>
                  {primaryApplication.project_id ? (
                    <Link to={`/projects/${primaryApplication.project_id}`} className="mt-2 inline-block text-sm font-medium text-primary-600 hover:text-primary-700 break-words">
                      {primaryApplication.project_title || 'Untitled project'}
                    </Link>
                  ) : (
                    <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-50">Unassigned project</p>
                  )}
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Assigned Job</p>
                  <Link to={`/jobs/${primaryApplication.job_id}`} className="mt-2 inline-block text-sm font-medium text-primary-600 hover:text-primary-700 break-words">
                    {primaryApplication.job_title || 'Untitled job'}
                  </Link>
                  {primaryApplication.job_category && (
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{primaryApplication.job_category}</p>
                  )}
                </div>
                <div className="rounded-xl bg-zinc-50 dark:bg-zinc-900/60 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Application Status</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge status={normalizeStatus(primaryApplication.status)} className="text-xs" />
                    {primaryApplication.match_score != null && (
                      <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Match score: {primaryApplication.match_score}%</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">No job or project assignment yet.</p>
            )}
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4 flex items-center gap-2">
              <Briefcase size={20} aria-hidden /> Applications
            </h2>
            {applications.length === 0 ? (
              <p className="text-zinc-500 dark:text-zinc-400 text-sm">No applications yet.</p>
            ) : (
              <ul className="space-y-3">
                {applications.map((app) => (
                  <li key={app.id} className="rounded-lg bg-zinc-50 dark:bg-zinc-900/60 p-3">
                    <div className="space-y-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Project</p>
                        {app.project_id ? (
                          <Link to={`/projects/${app.project_id}`} className="mt-1 inline-block text-sm font-medium text-primary-600 hover:text-primary-700 break-words">
                            {app.project_title || 'Untitled project'}
                          </Link>
                        ) : (
                          <p className="mt-1 text-sm text-zinc-900 dark:text-zinc-50">Unassigned project</p>
                        )}
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Job</p>
                        <Link to={`/jobs/${app.job_id}`} className="mt-1 inline-block text-sm font-medium text-primary-600 hover:text-primary-700 break-words">
                          {app.job_title}
                        </Link>
                        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{app.job_category || 'Job role'}</p>
                      </div>
                    </div>
                    <Badge status={normalizeStatus(app.status)} className="mt-3 text-xs" />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}