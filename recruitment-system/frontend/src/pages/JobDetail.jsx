import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getJob, getJobCandidates } from '../api'
import {
  ArrowLeft, Briefcase, MapPin, Calendar, FolderKanban, Users, User, Pencil, Trash2,
  Building2, Globe2, Layers, DollarSign, Tag, Clock, ListChecks, Hash, GraduationCap, Languages,
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

const toneStyles = {
  indigo:  { wrap: 'bg-indigo-50/70 dark:bg-indigo-950/30 ring-indigo-100 dark:ring-indigo-900/50',   icon: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200' },
  emerald: { wrap: 'bg-emerald-50/70 dark:bg-emerald-950/30 ring-emerald-100 dark:ring-emerald-900/50', icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200' },
  blue:    { wrap: 'bg-blue-50/70 dark:bg-blue-950/30 ring-blue-100 dark:ring-blue-900/50',           icon: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200' },
  amber:   { wrap: 'bg-amber-50/70 dark:bg-amber-950/30 ring-amber-100 dark:ring-amber-900/50',       icon: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200' },
  purple:  { wrap: 'bg-purple-50/70 dark:bg-purple-950/30 ring-purple-100 dark:ring-purple-900/50',   icon: 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-200' },
  rose:    { wrap: 'bg-rose-50/70 dark:bg-rose-950/30 ring-rose-100 dark:ring-rose-900/50',           icon: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-200' },
  zinc:    { wrap: 'bg-zinc-50 dark:bg-zinc-900/60 ring-zinc-100 dark:ring-zinc-800',                 icon: 'bg-white text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300' },
}

function InfoCell({ icon: Icon, label, children, tone = 'zinc' }) {
  const t = toneStyles[tone] || toneStyles.zinc
  return (
    <div className={`flex h-full min-h-[88px] items-start gap-3 rounded-2xl p-3.5 ring-1 ring-inset ${t.wrap}`}>
      {Icon && (
        <div className={`flex-shrink-0 mt-0.5 rounded-lg p-2 shadow-sm ${t.icon}`}>
          <Icon size={14} aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{label}</p>
        <div className="mt-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100 break-words">
          {children ?? <span className="font-normal text-zinc-400 dark:text-zinc-500">—</span>}
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
      <div className="flex items-center gap-2 mb-3">
        <div className="rounded-lg bg-blue-100 dark:bg-blue-900/40 p-1.5 text-blue-700 dark:text-blue-300">
          <ListChecks size={14} aria-hidden />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Description</h2>
      </div>
      {description ? (
        <>
          <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words max-w-prose">
            {visible}
          </p>
          {long && (
            <button
              type="button"
              className="mt-2 text-xs font-semibold text-primary-600 hover:text-primary-700 dark:text-primary-400"
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

const chipMeta = {
  required_skills:    { label: 'Required Skills',    icon: Tag,           chip: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/50 dark:text-blue-200 dark:ring-blue-900/60' },
  skills:             { label: 'Skills',             icon: Tag,           chip: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/50 dark:text-blue-200 dark:ring-blue-900/60' },
  required_languages: { label: 'Required Languages', icon: Languages,     chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:ring-emerald-900/60' },
  languages:          { label: 'Languages',          icon: Languages,     chip: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:ring-emerald-900/60' },
  education:          { label: 'Education',          icon: GraduationCap, chip: 'bg-purple-50 text-purple-700 ring-purple-200 dark:bg-purple-950/50 dark:text-purple-200 dark:ring-purple-900/60' },
}

function RequirementsCard({ requirements }) {
  if (!requirements || typeof requirements !== 'object') return null
  const entries = Object.entries(requirements).filter(([, v]) => {
    if (v == null || v === '') return false
    if (Array.isArray(v) && v.length === 0) return false
    return true
  })
  if (entries.length === 0) return null

  const chipKeys = new Set(Object.keys(chipMeta))
  const chipEntries = entries.filter(([k]) => chipKeys.has(k))
  const numericEntries = entries.filter(([k]) => !chipKeys.has(k))

  return (
    <Card accent="blue">
      <div className="flex items-center gap-2 mb-4">
        <div className="rounded-lg bg-primary-100 dark:bg-primary-900/40 p-1.5 text-primary-700 dark:text-primary-300">
          <Layers size={14} aria-hidden />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Requirements</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
        {chipEntries.length > 0 && (
          <div className="md:col-span-1 space-y-4">
            {chipEntries.map(([key, value]) => {
              const list = Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim()).filter(Boolean)
              if (list.length === 0) return null
              const meta = chipMeta[key]
              const Icon = meta.icon
              return (
                <div key={key}>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Icon size={12} className="text-zinc-500 dark:text-zinc-400" aria-hidden />
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                      {meta.label}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {list.map((item) => (
                      <span
                        key={item}
                        className={`inline-flex items-center rounded-full ring-1 ring-inset px-2.5 py-0.5 text-xs font-medium ${meta.chip}`}
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
          <div className="md:col-span-1 space-y-1.5">
            {numericEntries.map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-3 border-b border-zinc-100 dark:border-zinc-800 pb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                  {key.replace(/_/g, ' ')}
                </span>
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 text-right">
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
  const filled = job.positions_filled ?? 0
  const available = job.positions_available ?? 1
  const fillPct = Math.min(100, Math.round((filled / Math.max(1, available)) * 100))

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
      <Card accent="blue" className="overflow-hidden bg-gradient-to-br from-blue-50 via-white to-white dark:from-blue-950/40 dark:via-zinc-900 dark:to-zinc-900">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 break-words">{job.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge status={job.status} />
              <UrgencyPill level={job.urgency_level} />
              <DomainPill domain={job.domain} />
              {(job.country || job.country_code) && <CountryFlag code={job.country_code} name={job.country} />}
              {job.category && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-zinc-900/60 ring-1 ring-zinc-200 dark:ring-zinc-700 px-2.5 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  <Tag size={11} /> {job.category}
                </span>
              )}
            </div>
            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              {job.created_at && <>Created {fmtDate(job.created_at)}</>}
              {job.updated_at && job.updated_at !== job.created_at && <> · Updated {fmtDate(job.updated_at)}</>}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end lg:flex-nowrap">
            <Link to={`/jobs/${id}/candidates`} className="shrink-0">
              <Button variant="primary" size="sm">
                <Users size={15} /> Candidates ({totalApplicants})
              </Button>
            </Link>
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)} className="shrink-0">
              <Pencil size={15} /> Edit
            </Button>
            {isAdmin && (
              <Button variant="secondary" size="sm" onClick={() => setDeleteOpen(true)} className="shrink-0 text-rose-600 hover:text-rose-700 dark:text-rose-400">
                <Trash2 size={15} /> Delete
              </Button>
            )}
          </div>
        </div>

        {/* Positions progress strip */}
        <div className="mt-5">
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Positions filled</span>
            <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{filled} / {available}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-primary-500 to-primary-600 transition-all duration-500"
              style={{ width: `${fillPct}%` }}
            />
          </div>
        </div>
      </Card>

      {/* Info Grid */}
      <Card>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-4">At a glance</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <InfoCell icon={FolderKanban} label="Project" tone="indigo">
            {job.project_title ? (
              <Link to={`/projects/${job.project_id}`} className="text-primary-600 hover:text-primary-700 dark:text-primary-400">
                {job.project_title}
                {job.project_client && <span className="font-normal text-zinc-500 dark:text-zinc-400"> — {job.project_client}</span>}
              </Link>
            ) : null}
          </InfoCell>
          <InfoCell icon={Globe2} label="Country" tone="emerald">
            {job.country ? <CountryFlag code={job.country_code} name={job.country} /> : null}
          </InfoCell>
          <InfoCell icon={Layers} label="Domain" tone="blue">
            {job.domain ? <DomainPill domain={job.domain} /> : null}
          </InfoCell>
          <InfoCell icon={Briefcase} label="Urgency" tone={job.urgency_level === 'top_urgent' || job.urgency_level === 'urgent' ? 'rose' : 'amber'}>
            {job.urgency_level && job.urgency_level !== 'normal' ? <UrgencyPill level={job.urgency_level} /> : 'Normal'}
          </InfoCell>
          <InfoCell icon={Hash} label="Positions" tone="purple">
            {filled} of {available} filled
            {job.positions_remaining != null && (
              <span className="ml-1 font-normal text-xs text-zinc-500 dark:text-zinc-400">({job.positions_remaining} open)</span>
            )}
          </InfoCell>
          <InfoCell icon={DollarSign} label="Salary" tone="amber">{job.salary_range}</InfoCell>
          <InfoCell icon={MapPin} label="Location" tone="emerald">{job.location}</InfoCell>
          <InfoCell icon={Calendar} label="Deadline" tone="rose">{fmtDate(job.deadline)}</InfoCell>
          <InfoCell icon={Tag} label="Category" tone="blue">{job.category}</InfoCell>
          <InfoCell icon={Building2} label="Client" tone="indigo">{job.project_client}</InfoCell>
          <InfoCell icon={Clock} label="Created" tone="zinc">{fmtDate(job.created_at)}</InfoCell>
          <InfoCell icon={ListChecks} label="Applications" tone="purple">{totalApplicants}</InfoCell>
        </div>
      </Card>

      <DescriptionCard description={job.description} />

      <RequirementsCard requirements={job.requirements} />

      {/* Candidates preview */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-purple-100 dark:bg-purple-900/40 p-1.5 text-purple-700 dark:text-purple-300">
              <Users size={14} aria-hidden />
            </div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Candidates</h2>
          </div>
          <Link
            to={`/jobs/${id}/candidates`}
            className="text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 font-semibold"
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
              const score = item.match_score || 0
              const scoreTone = score >= 80 ? 'emerald' : score >= 60 ? 'blue' : 'amber'
              const scoreClass = {
                emerald: 'text-emerald-600 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 ring-emerald-200 dark:ring-emerald-900/60',
                blue:    'text-blue-600 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 ring-blue-200 dark:ring-blue-900/60',
                amber:   'text-amber-600 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 ring-amber-200 dark:ring-amber-900/60',
              }[scoreTone]
              return (
                <Link
                  key={item.application_id}
                  to={`/candidates/${candidate.id}`}
                  className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors group"
                >
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 overflow-hidden ring-2 ring-white dark:ring-zinc-900">
                    {candidate.photo_url ? (
                      <img
                        src={`${import.meta.env.VITE_API_URL || ''}${candidate.photo_url}`}
                        alt={candidate.name}
                        className="w-full h-full object-cover"
                      />
                    ) : candidate.name?.charAt(0)?.toUpperCase() || <User size={14} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate group-hover:text-primary-600 dark:group-hover:text-primary-400">{candidate.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{item.application_status || 'applied'}</p>
                  </div>
                  <span className={`text-xs font-bold flex-shrink-0 rounded-full ring-1 ring-inset px-2 py-0.5 ${scoreClass}`}>
                    {score}%
                  </span>
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
