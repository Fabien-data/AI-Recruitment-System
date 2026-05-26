import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getJob, getJobCandidates } from '../api'
import {
  ArrowLeft, Briefcase, MapPin, Calendar, FolderKanban, Users, User, Pencil, Trash2,
  Building2, Globe2, Layers, DollarSign, Tag, Clock, ListChecks, Hash,
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { EditJobModal } from '../components/EditJobModal'
import { DeleteJobConfirm } from '../components/DeleteJobConfirm'
import { UrgencyPill } from '../components/jobs/UrgencyPill'
import { DomainPill } from '../components/jobs/DomainPill'
import { CountryFlag } from '../components/jobs/CountryFlag'
import { useAuthStore } from '../stores/authStore'
import { format } from 'date-fns'

function fmtDate(value) {
  if (!value) return null
  try {
    return format(new Date(value), 'MMM d, yyyy')
  } catch {
    return null
  }
}

function InfoCell({ icon: Icon, label, children }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-zinc-50/60 dark:bg-zinc-800/40">
      {Icon && (
        <div className="flex-shrink-0 mt-0.5 rounded-lg bg-white dark:bg-zinc-900 p-1.5 text-zinc-500 dark:text-zinc-400 shadow-sm">
          <Icon size={14} aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
        <div className="mt-0.5 text-sm font-medium text-zinc-900 dark:text-zinc-100 break-words">
          {children ?? <span className="text-zinc-400 dark:text-zinc-500">—</span>}
        </div>
      </div>
    </div>
  )
}

function DescriptionCard({ description }) {
  const [expanded, setExpanded] = useState(false)
  const long = description && description.length > 600
  const visible = long && !expanded ? description.slice(0, 600) + '…' : description
  return (
    <Card>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-3">Description</h2>
      {description ? (
        <>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words max-w-prose">
            {visible}
          </p>
          {long && (
            <button
              type="button"
              className="mt-2 text-xs font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No description provided.</p>
      )}
    </Card>
  )
}

function RequirementsCard({ requirements }) {
  if (!requirements || typeof requirements !== 'object') return null
  const entries = Object.entries(requirements).filter(([, v]) => {
    if (v == null || v === '') return false
    if (Array.isArray(v) && v.length === 0) return false
    return true
  })
  if (entries.length === 0) return null

  const chipKeys = new Set(['required_skills', 'required_languages', 'education', 'skills', 'languages'])
  const chipEntries = entries.filter(([k]) => chipKeys.has(k))
  const numericEntries = entries.filter(([k]) => !chipKeys.has(k))

  return (
    <Card>
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-3">Requirements</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
        {chipEntries.length > 0 && (
          <div className="md:col-span-1 space-y-3">
            {chipEntries.map(([key, value]) => {
              const list = Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim()).filter(Boolean)
              if (list.length === 0) return null
              return (
                <div key={key}>
                  <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">
                    {key.replace(/_/g, ' ')}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((item) => (
                      <span
                        key={item}
                        className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-xs text-zinc-700 dark:text-zinc-300"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {numericEntries.length > 0 && (
          <div className="md:col-span-1 space-y-2">
            {numericEntries.map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between border-b border-zinc-100 dark:border-zinc-800 pb-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  {key.replace(/_/g, ' ')}
                </span>
                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {Array.isArray(value) ? value.join(', ') : String(value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

export default function JobDetail() {
  const { id } = useParams()
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'

  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const { data: job, isLoading, error } = useQuery({
    queryKey: ['job', id],
    queryFn: () => getJob(id),
    enabled: !!id,
  })

  const { data: candidatesData, isLoading: isCandidatesLoading } = useQuery({
    queryKey: ['job-candidates-preview', id],
    queryFn: () => getJobCandidates(id),
    enabled: !!id,
  })

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-4 w-full mb-2" />
        <Skeleton className="h-4 w-2/3 mb-8" />
        <Card>
          <Skeleton className="h-6 w-1/3 mb-4" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Link to="/jobs" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6">
          <ArrowLeft size={20} /> Back to Jobs
        </Link>
        <div className="card text-center py-12">
          <p className="text-zinc-600 dark:text-zinc-400 font-medium">Job not found</p>
          <Link to="/jobs">
            <Button variant="primary" className="mt-4">Back to Jobs</Button>
          </Link>
        </div>
      </div>
    )
  }

  const candidatePreview = Array.isArray(candidatesData?.candidates)
    ? candidatesData.candidates.slice(0, 5)
    : []

  const totalApplicants = candidatesData?.total_candidates ?? job.application_count ?? candidatePreview.length

  return (
    <div className="p-6 lg:p-8 animate-fade-in space-y-6">
      {/* Breadcrumb */}
      <div className="text-sm">
        <Link to="/jobs" className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium">
          <ArrowLeft size={16} aria-hidden /> Jobs
        </Link>
        {job.project_title && (
          <>
            <span className="mx-1 text-zinc-400">/</span>
            <Link to={`/projects/${job.project_id}`} className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100">
              {job.project_title}
            </Link>
          </>
        )}
        <span className="mx-1 text-zinc-400">/</span>
        <span className="text-zinc-500 dark:text-zinc-400">{job.title}</span>
      </div>

      {/* Hero */}
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 break-words">{job.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge status={job.status} />
              <UrgencyPill level={job.urgency_level} />
              <DomainPill domain={job.domain} />
              {(job.country || job.country_code) && <CountryFlag code={job.country_code} name={job.country} />}
              {job.category && (
                <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  <Tag size={11} /> {job.category}
                </span>
              )}
            </div>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              {job.created_at && <>Created {fmtDate(job.created_at)}</>}
              {job.updated_at && job.updated_at !== job.created_at && <> · Updated {fmtDate(job.updated_at)}</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/jobs/${id}/candidates`}>
              <Button variant="secondary">
                <Users size={15} /> View Candidates ({totalApplicants})
              </Button>
            </Link>
            <Button variant="secondary" onClick={() => setEditOpen(true)}>
              <Pencil size={15} /> Edit
            </Button>
            {isAdmin && (
              <Button variant="secondary" onClick={() => setDeleteOpen(true)} className="text-rose-600 hover:text-rose-700">
                <Trash2 size={15} /> Delete
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Info Grid */}
      <Card>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-3">At a glance</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <InfoCell icon={FolderKanban} label="Project">
            {job.project_title ? (
              <Link to={`/projects/${job.project_id}`} className="text-primary-600 hover:text-primary-700 dark:text-primary-400">
                {job.project_title}
                {job.project_client && <span className="text-zinc-500 dark:text-zinc-400"> — {job.project_client}</span>}
              </Link>
            ) : null}
          </InfoCell>
          <InfoCell icon={Globe2} label="Country">
            {job.country ? <CountryFlag code={job.country_code} name={job.country} /> : null}
          </InfoCell>
          <InfoCell icon={Layers} label="Domain">
            {job.domain ? <DomainPill domain={job.domain} /> : null}
          </InfoCell>
          <InfoCell icon={Briefcase} label="Urgency">
            {job.urgency_level && job.urgency_level !== 'normal' ? <UrgencyPill level={job.urgency_level} /> : 'Normal'}
          </InfoCell>
          <InfoCell icon={Hash} label="Positions">
            {(job.positions_filled ?? 0)} of {job.positions_available ?? 1} filled
            {job.positions_remaining != null && (
              <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">({job.positions_remaining} open)</span>
            )}
          </InfoCell>
          <InfoCell icon={DollarSign} label="Salary">{job.salary_range}</InfoCell>
          <InfoCell icon={MapPin} label="Location">{job.location}</InfoCell>
          <InfoCell icon={Calendar} label="Deadline">{fmtDate(job.deadline)}</InfoCell>
          <InfoCell icon={Tag} label="Category">{job.category}</InfoCell>
          <InfoCell icon={Building2} label="Client">{job.project_client}</InfoCell>
          <InfoCell icon={Clock} label="Created">{fmtDate(job.created_at)}</InfoCell>
          <InfoCell icon={ListChecks} label="Applications">{totalApplicants}</InfoCell>
        </div>
      </Card>

      <DescriptionCard description={job.description} />

      <RequirementsCard requirements={job.requirements} />

      {/* Candidates preview */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Candidates</h2>
          <Link
            to={`/jobs/${id}/candidates`}
            className="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium"
          >
            View All →
          </Link>
        </div>
        {isCandidatesLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
          </div>
        ) : candidatePreview.length > 0 ? (
          <div className="space-y-2">
            {candidatePreview.map((item) => {
              const candidate = item.candidate || {}
              return (
                <Link
                  key={item.application_id}
                  to={`/candidates/${candidate.id}`}
                  className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 overflow-hidden">
                    {candidate.photo_url ? (
                      <img
                        src={`${import.meta.env.VITE_API_URL || ''}${candidate.photo_url}`}
                        alt={candidate.name}
                        className="w-full h-full object-cover"
                      />
                    ) : candidate.name?.charAt(0)?.toUpperCase() || <User size={14} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50 truncate group-hover:text-primary-600 dark:group-hover:text-primary-400">{candidate.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{item.application_status || 'applied'}</p>
                  </div>
                  <span className="text-xs font-semibold text-primary-600 dark:text-primary-400 flex-shrink-0">{item.match_score || 0}%</span>
                </Link>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2">No candidates assigned yet.</p>
        )}
      </Card>

      {editOpen && (
        <EditJobModal isOpen={editOpen} job={job} onClose={() => setEditOpen(false)} />
      )}
      {deleteOpen && (
        <DeleteJobConfirm isOpen={deleteOpen} job={job} onClose={() => setDeleteOpen(false)} />
      )}
    </div>
  )
}
