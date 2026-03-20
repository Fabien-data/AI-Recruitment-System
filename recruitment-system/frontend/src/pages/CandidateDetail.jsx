import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getCandidate } from '../api'
import { ArrowLeft, User, Mail, Phone, FileText, Briefcase, MessageSquare, ClipboardList, CheckSquare, Square, Download } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { format } from 'date-fns'

function getDocumentCategory(cv) {
  if (cv?.document_category) return cv.document_category
  try {
    const parsed = typeof cv?.parsed_data === 'string' ? JSON.parse(cv.parsed_data) : cv?.parsed_data
    return parsed?.__document_category === 'additional' ? 'additional' : 'cv'
  } catch {
    return 'cv'
  }
}

function resolveDocumentUrl(cv) {
  const raw = cv?.resolved_file_url || cv?.file_url || ''
  if (!raw || raw.startsWith('chatbot://')) return null
  if (raw.startsWith('http')) return raw
  return `${import.meta.env.VITE_API_URL || ''}${raw}`
}

export default function CandidateDetail() {
  const { id } = useParams()
  const { data: candidate, isLoading, error } = useQuery({
    queryKey: ['candidate', id],
    queryFn: () => getCandidate(id),
    enabled: !!id,
  })

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
          <p className="text-gray-600 font-medium">Candidate not found</p>
          <Link to="/candidates">
            <Button variant="primary" className="mt-4">Back to Candidates</Button>
          </Link>
        </div>
      </div>
    )
  }

  const documents = candidate.cvs || []
  const cvs = documents.filter((doc) => getDocumentCategory(doc) === 'cv')
  const additionalDocuments = documents.filter((doc) => getDocumentCategory(doc) === 'additional')
  const applications = candidate.applications || []
  const communications = candidate.communications || []
  const applicationForm = candidate.metadata?.application_form || {}

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <Link to="/candidates" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6 font-medium">
        <ArrowLeft size={20} aria-hidden /> Back to Candidates
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{candidate.name || 'Unknown'}</h1>
          <div className="flex flex-wrap items-center gap-4 mt-2 text-gray-600">
            <span className="inline-flex items-center gap-1">
              <Phone size={18} aria-hidden /> {candidate.phone}
            </span>
            {candidate.email && (
              <span className="inline-flex items-center gap-1">
                <Mail size={18} aria-hidden /> {candidate.email}
              </span>
            )}
          </div>
        </div>
        <Badge status={candidate.status} className="text-sm" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <User size={20} aria-hidden /> Details
            </h2>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-gray-500">Source</dt>
                <dd className="font-medium text-gray-900">{candidate.source}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Preferred language</dt>
                <dd className="font-medium text-gray-900">{candidate.preferred_language || 'en'}</dd>
              </div>
              <div>
                <dt className="text-gray-500">Created</dt>
                <dd className="font-medium text-gray-900">
                  {candidate.created_at ? format(new Date(candidate.created_at), 'MMM d, yyyy') : '-'}
                </dd>
              </div>
              {candidate.last_contact_at && (
                <div>
                  <dt className="text-gray-500">Last contact</dt>
                  <dd className="font-medium text-gray-900">
                    {format(new Date(candidate.last_contact_at), 'MMM d, yyyy')}
                  </dd>
                </div>
              )}
            </dl>
            {candidate.notes && (
              <div className="mt-4 pt-4 border-t border-gray-200">
                <dt className="text-gray-500 text-sm mb-1">Notes</dt>
                <dd className="text-gray-700 whitespace-pre-wrap">{candidate.notes}</dd>
              </div>
            )}
          </Card>

          {Object.keys(applicationForm).length > 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <ClipboardList size={20} aria-hidden /> Digital Application Form
              </h2>
              
              <div className="space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-gray-500 uppercase tracking-wide">Position Applied For</label>
                    <div className="font-medium">{applicationForm.position_applied_for || '-'}</div>
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 uppercase tracking-wide">Secondary Position</label>
                    <div className="font-medium">{applicationForm.secondary_position || '-'}</div>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-1 mb-3">Personal Details</h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div className="md:col-span-2">
                      <label className="text-gray-500">Full Name</label>
                      <div className="font-medium">{applicationForm.full_name || '-'}</div>
                    </div>
                    <div className="md:col-span-2">
                      <label className="text-gray-500">Address</label>
                      <div className="font-medium">{applicationForm.address || '-'}</div>
                    </div>
                    <div>
                      <label className="text-gray-500">Passport No</label>
                      <div className="font-medium">{applicationForm.passport_no || '-'}</div>
                    </div>
                    <div>
                      <label className="text-gray-500">N.I.C No</label>
                      <div className="font-medium">{applicationForm.nic_no || '-'}</div>
                    </div>
                    <div>
                      <label className="text-gray-500">Date of Birth</label>
                      <div className="font-medium">{applicationForm.dob || '-'}</div>
                    </div>
                    <div>
                      <label className="text-gray-500">Age</label>
                      <div className="font-medium">{applicationForm.age || '-'}</div>
                    </div>
                    <div>
                      <label className="text-gray-500">Gender</label>
                      <div className="font-medium capitalize">{applicationForm.gender || '-'}</div>
                    </div>
                    <div>
                      <label className="text-gray-500">Marital Status</label>
                      <div className="font-medium capitalize">{applicationForm.marital_status || '-'}</div>
                    </div>
                    {applicationForm.languages && (
                      <div className="md:col-span-2">
                        <label className="text-gray-500">Languages</label>
                        <div className="flex gap-2 mt-1">
                          {applicationForm.languages.map((lang, i) => (
                            <Badge key={i} status="default" className="bg-gray-100 text-gray-800">{lang}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div>
                   <h3 className="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-1 mb-3">Education Level</h3>
                   <div className="flex flex-wrap gap-4">
                      {['O/L', 'A/L', 'Diploma', 'Degree'].map((level) => {
                        const key = level.toLowerCase().replace('/', '').replace('degree', 'degree');
                        const schemaKey = key === 'o/l' ? 'ol' : key === 'a/l' ? 'al' : key;
                        const isChecked = applicationForm.education?.[schemaKey];
                        return (
                          <div key={level} className="flex items-center gap-2">
                             {isChecked ? <CheckSquare size={16} className="text-blue-600" /> : <Square size={16} className="text-gray-400" />}
                             <span className={isChecked ? 'font-medium text-gray-900' : 'text-gray-500'}>{level}</span>
                          </div>
                        )
                      })}
                   </div>
                </div>

                <div>
                  <h3 className="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-1 mb-3">Working Experience</h3>
                  {applicationForm.experience && applicationForm.experience.length > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50">
                            <th className="px-3 py-2 text-left font-medium text-gray-500">Company</th>
                            <th className="px-3 py-2 text-left font-medium text-gray-500">Position</th>
                            <th className="px-3 py-2 text-right font-medium text-gray-500">Years</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {applicationForm.experience.map((exp, idx) => (
                            <tr key={idx}>
                              <td className="px-3 py-2 text-gray-900">{exp.company}</td>
                              <td className="px-3 py-2 text-gray-900">{exp.position}</td>
                              <td className="px-3 py-2 text-right text-gray-900">{exp.years}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-gray-500 text-sm italic">No experience recorded.</p>
                  )}
                </div>
              </div>
            </Card>
          )}

          {documents.length > 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <FileText size={20} aria-hidden /> Documents
              </h2>

              <h3 className="text-sm font-semibold text-gray-700 mb-2">CV</h3>
              {cvs.length === 0 ? (
                <p className="text-sm text-gray-500 mb-4">No CV uploaded yet.</p>
              ) : (
                <ul className="space-y-2 mb-4">
                  {cvs.map((cv) => {
                    const url = resolveDocumentUrl(cv)
                    return (
                      <li key={cv.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                        <span className="text-gray-700">{cv.file_name || 'CV'}</span>
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
                              download={cv.file_name || 'cv'}
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

              <h3 className="text-sm font-semibold text-gray-700 mb-2">Additional Documents</h3>
              {additionalDocuments.length === 0 ? (
                <p className="text-sm text-gray-500">No additional documents uploaded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {additionalDocuments.map((doc) => {
                    const url = resolveDocumentUrl(doc)
                    return (
                      <li key={doc.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                        <span className="text-gray-700">{doc.file_name || 'Additional Document'}</span>
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
              <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <MessageSquare size={20} aria-hidden /> Recent communications
              </h2>
              <ul className="space-y-3 max-h-64 overflow-y-auto">
                {communications.slice(0, 10).map((c) => (
                  <li key={c.id} className="text-sm p-3 bg-gray-50 rounded-lg">
                    <span className="text-gray-500">{c.channel} · {c.direction}</span>
                    <p className="text-gray-900 mt-1">{c.content || '(no content)'}</p>
                    <p className="text-gray-400 text-xs mt-1">
                      {c.sent_at ? format(new Date(c.sent_at), 'MMM d, HH:mm') : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Briefcase size={20} aria-hidden /> Applications
            </h2>
            {applications.length === 0 ? (
              <p className="text-gray-500 text-sm">No applications yet.</p>
            ) : (
              <ul className="space-y-3">
                {applications.map((app) => (
                  <li key={app.id} className="p-3 bg-gray-50 rounded-lg">
                    <Link to={`/jobs/${app.job_id}`} className="font-medium text-primary-600 hover:text-primary-700">
                      {app.job_title}
                    </Link>
                    <p className="text-xs text-gray-500 mt-1">{app.job_category}</p>
                    <Badge status={app.status} className="mt-2 text-xs" />
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