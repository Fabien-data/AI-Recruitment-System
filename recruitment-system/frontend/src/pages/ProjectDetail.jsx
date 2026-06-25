import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { getProject, getProjectCandidates, getProjectStats, exportProjectCsv, getAdLinks, generateAdLink } from '../api'
import {
  ArrowLeft, FolderKanban, MapPin, Calendar, Users, Briefcase,
  DollarSign, Home, Bus, Utensils, FileText, Plane, Phone, Mail, MapPinned, Plus, User, Download,
  HeartPulse, UtensilsCrossed, CheckCircle2, Clock, Award, XCircle, TrendingUp, Building2, Megaphone, Pencil,
  List, LayoutGrid,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { Button } from '../components/ui/Button'
import { CreateJobModal } from '../components/CreateJobModal'
import { EditProjectModal } from '../components/EditProjectModal'
import { AdLinkCard } from '../components/AdLinkModal'
import ProjectKanban from '../components/ProjectKanban'
import { format } from 'date-fns'
import { useAuthStore } from '../stores/authStore'
import { getStatusLabel, getStatusColor, normalizeStatus } from '../constants/lifecycle'

// Project = Meta campaign. This panel lets the team build the whole campaign's
// ads in one place: one row per job, each with its generate button or its live
// ad link (message template / destination URL / QR / click+conversion stats).
function ProjectCampaignPanel({ project, projectId, canManage }) {
  const queryClient = useQueryClient()
  const jobs = Array.isArray(project?.jobs) ? project.jobs : []

  const { data, isLoading } = useQuery({
    queryKey: ['ad-links', { project_id: projectId }],
    queryFn: () => getAdLinks({ project_id: projectId }),
    enabled: !!projectId,
  })
  const links = Array.isArray(data?.data) ? data.data : []
  const linksByJob = links.reduce((acc, link) => {
    (acc[link.job_id] ||= []).push(link)
    return acc
  }, {})

  const generate = useMutation({
    mutationFn: (job) =>
      generateAdLink({
        job_id: job.id,
        project_id: projectId,
        campaign_name: project?.title || undefined,
      }),
    onSuccess: () => {
      toast.success('Ad link generated — the bot now knows this job')
      queryClient.invalidateQueries({ queryKey: ['ad-links'] })
    },
    onError: (e) => {
      if (e.response?.status === 409) {
        toast.error(`That code is already used by "${e.response.data?.existing_campaign || 'another campaign'}"`)
      } else {
        toast.error(e.response?.data?.error || 'Failed to generate ad link')
      }
    },
  })

  return (
    <Card>
      <div className="flex items-center gap-2 mb-1">
        <Megaphone size={18} className="text-primary-600" />
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Meta Ad Campaign</h2>
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
        Run one Meta campaign for this project, with one ad per job. Generate each job's link, then paste its
        message template into the ad — the bot reads the hidden ref to route the candidate to the right role.
      </p>

      {jobs.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 py-4">Add a job to this project to start its campaign.</p>
      ) : isLoading ? (
        <div className="space-y-2">
          {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}
        </div>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => {
            const jobLinks = linksByJob[job.id] || []
            return (
              <div key={job.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <Link to={`/jobs/${job.id}`} className="font-medium text-zinc-900 dark:text-zinc-50 hover:text-primary-600 truncate block">
                      {job.title}
                    </Link>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {jobLinks.length > 0 ? `${jobLinks.length} ad${jobLinks.length > 1 ? 's' : ''}` : 'No ad link yet'}
                    </p>
                  </div>
                  {canManage && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => generate.mutate(job)}
                      loading={generate.isLoading && generate.variables?.id === job.id}
                    >
                      <Megaphone size={14} /> {jobLinks.length > 0 ? 'New link' : 'Generate link'}
                    </Button>
                  )}
                </div>
                {jobLinks.length > 0 && (
                  <div className="space-y-3">
                    {jobLinks.map((link) => <AdLinkCard key={link.ad_ref} link={link} />)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function ProjectCandidateList({ projectId, jobFilter }) {
  const params = jobFilter ? { job_id: jobFilter, limit: 8 } : { limit: 8 }
  const { data, isLoading } = useQuery({
    queryKey: ['project-candidates', projectId, jobFilter],
    queryFn: () => getProjectCandidates(projectId, params),
    enabled: !!projectId,
  })

  const candidates = Array.isArray(data) ? data : (data?.candidates || data?.data || [])
  const groupedCandidates = candidates.reduce((acc, candidate) => {
    const jobTitle = candidate.job_title || 'Unassigned Job'
    if (!acc[jobTitle]) acc[jobTitle] = []
    acc[jobTitle].push(candidate)
    return acc
  }, {})
  const groupedEntries = Object.entries(groupedCandidates)

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (!candidates.length) {
    return <p className="text-center text-zinc-500 dark:text-zinc-400 py-6 text-sm">No candidates assigned yet</p>
  }

  return (
    <div className="space-y-4">
      {groupedEntries.map(([jobTitle, jobCandidates]) => (
        <div key={jobTitle}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2">{jobTitle}</h3>
          <div className="space-y-2">
            {jobCandidates.map((c) => (
              <Link
                key={`${jobTitle}-${c.id || c.candidate_id}`}
                to={`/candidates/${c.id || c.candidate_id}`}
                className="group flex items-start gap-3 rounded-xl p-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
              >
                <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 overflow-hidden">
                  {c.photo_url
                    ? <img src={`${import.meta.env.VITE_API_URL || ''}${c.photo_url}`} alt={c.name} className="w-full h-full object-cover" />
                    : (c.name?.charAt(0)?.toUpperCase() || <User size={14} />)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-tight text-zinc-900 dark:text-zinc-50 break-words group-hover:text-primary-600">{c.name}</p>
                  <p className="mt-1 text-xs leading-snug text-zinc-500 dark:text-zinc-400 break-words">
                    {getStatusLabel(normalizeStatus(c.application_status || c.status))}
                  </p>
                </div>
                {c.match_score != null && (
                  <span className="text-xs font-semibold text-primary-600 flex-shrink-0">
                    {c.match_score}%
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// Radial progress ring — animated via Framer Motion.
function ProgressRing({ percent, size = 140, strokeWidth = 12 }) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const safePct = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const offset = circumference - (safePct / 100) * circumference
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          fill="none"
          className="text-zinc-200 dark:text-zinc-800"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="url(#progressGrad)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
        <defs>
          <linearGradient id="progressGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold text-zinc-900 dark:text-zinc-50 tabular-nums">{safePct}%</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Filled</span>
      </div>
    </div>
  )
}

// Icon-led stat card used in the overview grid.
function OverviewStatCard({ icon: Icon, label, value, tone = 'blue' }) {
  const tones = {
    blue:    { ring: 'ring-blue-200/60 dark:ring-blue-900/60',       bg: 'bg-blue-50 dark:bg-blue-950/40',       text: 'text-blue-700 dark:text-blue-300',       value: 'text-blue-900 dark:text-blue-100' },
    purple:  { ring: 'ring-purple-200/60 dark:ring-purple-900/60',   bg: 'bg-purple-50 dark:bg-purple-950/40',   text: 'text-purple-700 dark:text-purple-300',   value: 'text-purple-900 dark:text-purple-100' },
    amber:   { ring: 'ring-amber-200/60 dark:ring-amber-900/60',     bg: 'bg-amber-50 dark:bg-amber-950/40',     text: 'text-amber-700 dark:text-amber-300',     value: 'text-amber-900 dark:text-amber-100' },
    emerald: { ring: 'ring-emerald-200/60 dark:ring-emerald-900/60', bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-700 dark:text-emerald-300', value: 'text-emerald-900 dark:text-emerald-100' },
    indigo:  { ring: 'ring-indigo-200/60 dark:ring-indigo-900/60',   bg: 'bg-indigo-50 dark:bg-indigo-950/40',   text: 'text-indigo-700 dark:text-indigo-300',   value: 'text-indigo-900 dark:text-indigo-100' },
  }
  const t = tones[tone] || tones.blue
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`rounded-2xl ring-1 ring-inset ${t.ring} ${t.bg} p-4 flex items-center gap-3`}
    >
      <div className={`rounded-xl bg-white/70 dark:bg-zinc-900/40 p-2 ${t.text}`}>
        <Icon size={20} />
      </div>
      <div className="min-w-0">
        <p className={`text-[11px] font-semibold uppercase tracking-wider ${t.text}`}>{label}</p>
        <p className={`text-2xl font-bold ${t.value} tabular-nums leading-tight`}>{value}</p>
      </div>
    </motion.div>
  )
}

// Compact lifecycle pill (Screening / Certified / Interview Scheduled / ...).
function LifecyclePill({ status, count }) {
  return (
    <div className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 ${getStatusColor(status)}`}>
      <span className="text-xs font-medium">{getStatusLabel(status)}</span>
      <span className="text-sm font-bold tabular-nums">{count || 0}</span>
    </div>
  )
}

const BENEFIT_ICON_MAP = {
  accommodation: Home,
  transport: Bus,
  meals: Utensils,
  meals_included: UtensilsCrossed,
  meals_not_included: UtensilsCrossed,
  medical: HeartPulse,
  visa: FileText,
  ticket: Plane,
}

const BENEFIT_LABEL_MAP = {
  accommodation: 'Accommodation',
  transport: 'Transport',
  meals: 'Meals',
  meals_included: 'Meals in salary',
  meals_not_included: 'Meals NOT in salary',
  medical: 'Medical',
  visa: 'Visa',
  ticket: 'Air Ticket',
}

function parseJsonField(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export default function ProjectDetail() {
  const { id } = useParams()
  const { user } = useAuthStore()
  const [candidatesJobFilter, setCandidatesJobFilter] = useState('')
  const [candidatesView, setCandidatesView] = useState('list') // 'list' | 'board'
  const [isJobModalOpen, setIsJobModalOpen] = useState(false)
  const [isEditOpen, setIsEditOpen] = useState(false)
  // Mirrors the backend PUT /api/projects/:id authorization.
  const canManageProject = ['admin', 'sourcing_department', 'project_handler'].includes(user?.role)

  const { data: project, isLoading, error } = useQuery({
    queryKey: ['project', id],
    queryFn: () => getProject(id),
    enabled: !!id,
  })

  const { data: statsData } = useQuery({
    queryKey: ['project-stats', id],
    queryFn: () => getProjectStats(id),
    enabled: !!id,
  })

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-32 w-full mb-6 rounded-2xl" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card><Skeleton className="h-32" /></Card>
            <Card><Skeleton className="h-48" /></Card>
          </div>
          <div className="space-y-6">
            <Card><Skeleton className="h-48" /></Card>
            <Card><Skeleton className="h-32" /></Card>
          </div>
        </div>
      </div>
    )
  }

  if (error || !project) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Link to="/projects" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6">
          <ArrowLeft size={20} /> Back to Projects
        </Link>
        <div className="card text-center py-12">
          <p className="text-zinc-600 dark:text-zinc-400 font-medium">Project not found</p>
        </div>
      </div>
    )
  }

  const countries = parseJsonField(project.countries, [])
  const benefits = parseJsonField(project.benefits, {})
  const salaryInfo = parseJsonField(project.salary_info, {})
  const contactInfo = parseJsonField(project.contact_info, {})

  // Resolve industries — prefer the new array column, fall back to legacy text.
  const industryArr = parseJsonField(project.industry_types, [])
  const industries = Array.isArray(industryArr) && industryArr.length > 0
    ? industryArr
    : (project.industry_type ? [project.industry_type] : [])

  const activeBenefits = Object.entries(benefits || {}).filter(([_, v]) => v)
  const stats = statsData || {}
  const totalPositions = Number(stats.total_positions) || 0
  const filledPositions = Number(stats.filled_positions) || 0
  const completionRate = totalPositions > 0
    ? Math.round((filledPositions / totalPositions) * 100)
    : 0

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <Link to="/projects" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6 font-medium">
        <ArrowLeft size={20} /> Back to Projects
      </Link>

      {/* Hero header with gradient banner */}
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-500 via-blue-500 to-emerald-500 p-6 sm:p-8 text-white mb-6 shadow-lg"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.25),transparent_60%)] pointer-events-none" />
        <div className="relative flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <h1 className="text-3xl sm:text-4xl font-bold leading-tight break-words">{project.title}</h1>
              <Badge status={project.status} className="bg-white/20 text-white border-white/30" />
              <Badge status={project.priority} className="bg-white/20 text-white border-white/30" />
            </div>
            <p className="text-lg text-white/90 mb-3 inline-flex items-center gap-2">
              <Building2 size={18} className="opacity-80" /> {project.client_name}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              {industries.map((ind) => (
                <span key={ind} className="inline-flex items-center gap-1 bg-white/20 text-white px-2.5 py-0.5 rounded-full ring-1 ring-white/30 text-xs font-medium">
                  <FolderKanban size={12} />
                  {ind}
                </span>
              ))}
              {countries?.slice(0, 4).map((c) => (
                <span key={c} className="inline-flex items-center gap-1 bg-white/15 text-white px-2.5 py-0.5 rounded-full text-xs font-medium">
                  <MapPin size={12} />
                  {c}
                </span>
              ))}
              {countries?.length > 4 && (
                <span className="text-xs text-white/80">+{countries.length - 4} more</span>
              )}
            </div>
          </div>
          <div className="flex sm:items-end items-start gap-2">
            <ProgressRing percent={completionRate} size={120} strokeWidth={10} />
            <div className="flex flex-col gap-2">
              {canManageProject && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="inline-flex items-center gap-1 bg-white/15 text-white hover:bg-white/25 border-white/20"
                  onClick={() => setIsEditOpen(true)}
                >
                  <Pencil size={15} /> Edit
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                className="inline-flex items-center gap-1 bg-white/15 text-white hover:bg-white/25 border-white/20"
                onClick={() => exportProjectCsv(id)}
              >
                <Download size={15} /> CSV
              </Button>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Top stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <OverviewStatCard icon={Briefcase} label="Total Jobs" value={stats.total_jobs || 0} tone="blue" />
        <OverviewStatCard icon={Users} label="Candidates" value={stats.unique_candidates || 0} tone="purple" />
        <OverviewStatCard icon={FileText} label="Applications" value={stats.total_applications || 0} tone="amber" />
        <OverviewStatCard icon={Calendar} label="Interviews" value={stats.interviews_count || 0} tone="indigo" />
        <OverviewStatCard icon={Award} label="Certified" value={stats.certified_count || 0} tone="purple" />
        <OverviewStatCard icon={Award} label="Hired" value={stats.placed_count || stats.selected_count || 0} tone="emerald" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Project Info */}
          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4">Project Overview</h2>

            <div className="mb-4">
              <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Target Countries</h3>
              <div className="flex flex-wrap gap-2">
                {countries?.map((country) => (
                  <span key={country} className="inline-flex items-center gap-1 px-3 py-1 bg-blue-50 text-blue-700 rounded-lg border border-blue-100">
                    <MapPin size={16} />
                    {country}
                  </span>
                ))}
              </div>
            </div>

            {project.description && (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Description</h3>
                <p className="text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">{project.description}</p>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4 p-4 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg">
              {project.start_date && (
                <div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Start Date</p>
                  <p className="font-medium text-zinc-900 dark:text-zinc-50">{format(new Date(project.start_date), 'MMM d, yyyy')}</p>
                </div>
              )}
              {project.interview_date && (
                <div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Interview Date</p>
                  <p className="font-medium text-zinc-900 dark:text-zinc-50">{format(new Date(project.interview_date), 'MMM d, yyyy')}</p>
                </div>
              )}
              {project.end_date && (
                <div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">End Date</p>
                  <p className="font-medium text-zinc-900 dark:text-zinc-50">{format(new Date(project.end_date), 'MMM d, yyyy')}</p>
                </div>
              )}
            </div>

            {activeBenefits.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-3">Benefits Included</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {activeBenefits.map(([benefit]) => {
                    const Icon = BENEFIT_ICON_MAP[benefit] || FileText
                    const label = BENEFIT_LABEL_MAP[benefit] || benefit.replace(/_/g, ' ')
                    return (
                      <div
                        key={benefit}
                        className="flex items-center gap-2.5 rounded-xl bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/40 dark:to-zinc-900 ring-1 ring-inset ring-emerald-100 dark:ring-emerald-900/60 px-3 py-2.5"
                      >
                        <div className="rounded-lg bg-emerald-100 dark:bg-emerald-900/60 p-1.5 text-emerald-700 dark:text-emerald-200 shadow-sm">
                          <Icon size={14} aria-hidden />
                        </div>
                        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 capitalize">{label}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {(salaryInfo?.min || salaryInfo?.max) && (
              <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
                <DollarSign size={20} className="text-blue-600" />
                <span className="font-medium text-zinc-900 dark:text-zinc-50">
                  {salaryInfo.currency} {salaryInfo.min || 0} - {salaryInfo.max || 0}
                </span>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">per month</span>
              </div>
            )}

            {(contactInfo?.whatsapp || contactInfo?.email || contactInfo?.address) && (
              <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">Contact Information</h3>
                <div className="space-y-2">
                  {contactInfo.whatsapp && (
                    <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                      <Phone size={16} className="text-zinc-400 dark:text-zinc-500" />
                      <span>{contactInfo.whatsapp}</span>
                    </div>
                  )}
                  {contactInfo.email && (
                    <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                      <Mail size={16} className="text-zinc-400 dark:text-zinc-500" />
                      <span>{contactInfo.email}</span>
                    </div>
                  )}
                  {contactInfo.address && (
                    <div className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
                      <MapPinned size={16} className="text-zinc-400 dark:text-zinc-500" />
                      <span>{contactInfo.address}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>

          {/* Jobs Panel — with mini progress bars per job */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Jobs in Project</h2>
              <div className="flex gap-2">
                {(user?.role === 'admin' || user?.role === 'sourcing_department') && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setIsJobModalOpen(true)}
                    className="inline-flex items-center gap-1"
                  >
                    <Plus size={16} />
                    Add Job
                  </Button>
                )}
                <Link to={`/jobs?project_id=${id}`} className="text-primary-600 hover:text-primary-700 text-sm font-medium">
                  View All Jobs
                </Link>
              </div>
            </div>
            {project.jobs && project.jobs.length > 0 ? (
              <div className="space-y-3">
                {project.jobs.map((job) => {
                  const filled = Number(job.positions_filled) || 0
                  const certified = Number(job.certified_count) || 0
                  const total = Number(job.positions_available) || 1
                  const pct = Math.min(100, Math.round((filled / Math.max(1, total)) * 100))
                  const certPct = Math.min(100, Math.round((certified / Math.max(1, total)) * 100))
                  const bar = pct >= 100 ? 'from-emerald-500 to-emerald-600' : pct >= 60 ? 'from-amber-400 to-amber-500' : 'from-primary-500 to-primary-600'
                  return (
                    <Link
                      key={job.id}
                      to={`/jobs/${job.id}`}
                      className="block rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 transition-all hover:shadow-sm hover:border-primary-200 dark:hover:border-primary-900/40"
                    >
                      <div className="mb-2 flex items-start justify-between gap-3">
                        <h3 className="font-medium text-zinc-900 dark:text-zinc-50">{job.title}</h3>
                        <Badge status={job.status} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400 mb-2">
                        <span className="inline-flex items-center gap-1">
                          <Briefcase size={14} /> {job.category}
                        </span>
                        <span>{job.candidate_count || 0} candidates</span>
                      </div>
                      <div className="space-y-1.5">
                        <div>
                          <div className="flex items-center justify-between text-[11px] mb-0.5">
                            <span className="text-zinc-500 dark:text-zinc-400">Certified</span>
                            <span className="tabular-nums font-semibold text-zinc-700 dark:text-zinc-200">{certified} / {total}</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-violet-600 transition-all duration-500"
                              style={{ width: `${certPct}%` }}
                            />
                          </div>
                        </div>
                        <div>
                          <div className="flex items-center justify-between text-[11px] mb-0.5">
                            <span className="text-zinc-500 dark:text-zinc-400">Placed</span>
                            <span className="tabular-nums font-semibold text-zinc-700 dark:text-zinc-200">{filled} / {total}</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                            <div
                              className={`h-full rounded-full bg-gradient-to-r ${bar} transition-all duration-500`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-zinc-500 dark:text-zinc-400 mb-3">No jobs linked to this project yet</p>
                {(user?.role === 'admin' || user?.role === 'sourcing_department') && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setIsJobModalOpen(true)}
                    className="inline-flex items-center gap-1"
                  >
                    <Plus size={16} />
                    Create First Job
                  </Button>
                )}
              </div>
            )}
          </Card>

          {/* Meta Ad Campaign — one ad per job under this project's campaign */}
          <ProjectCampaignPanel
            project={project}
            projectId={id}
            canManage={user?.role === 'admin' || user?.role === 'sourcing_department'}
          />

          {/* Candidates */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Candidates</h2>
              <div className="flex flex-wrap items-center justify-end gap-3">
                {/* List / Board view toggle */}
                <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 p-0.5 bg-zinc-50 dark:bg-zinc-800/60">
                  <button
                    type="button"
                    onClick={() => setCandidatesView('list')}
                    aria-pressed={candidatesView === 'list'}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      candidatesView === 'list'
                        ? 'bg-white dark:bg-zinc-900 text-primary-600 shadow-sm'
                        : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                    }`}
                  >
                    <List size={14} /> List
                  </button>
                  <button
                    type="button"
                    onClick={() => setCandidatesView('board')}
                    aria-pressed={candidatesView === 'board'}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      candidatesView === 'board'
                        ? 'bg-white dark:bg-zinc-900 text-primary-600 shadow-sm'
                        : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                    }`}
                  >
                    <LayoutGrid size={14} /> Board
                  </button>
                </div>
                {project.jobs && project.jobs.length > 1 && (
                  <select
                    value={candidatesJobFilter}
                    onChange={(e) => setCandidatesJobFilter(e.target.value)}
                    className="max-w-full rounded-lg border border-gray-300 px-2 py-1 text-sm"
                  >
                    <option value="">All Jobs</option>
                    {project.jobs.map((job) => (
                      <option key={job.id} value={job.id}>{job.title}</option>
                    ))}
                  </select>
                )}
                <Link
                  to={`/applications?project_id=${id}`}
                  className="text-sm text-primary-600 hover:text-primary-700 font-medium"
                >
                  View All →
                </Link>
              </div>
            </div>
            {candidatesView === 'board' ? (
              <ProjectKanban projectId={id} jobFilter={candidatesJobFilter} />
            ) : (
              <ProjectCandidateList projectId={id} jobFilter={candidatesJobFilter} />
            )}
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Pipeline Status — clickable, filters /applications by status */}
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp size={18} className="text-primary-600" />
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Pipeline Status</h2>
            </div>
            <div className="grid grid-cols-1 gap-2">
              {[
                // One pill per CANONICAL application status. The backend's legacy
                // stats keys now collapse onto canonical values (pre_screened_count ==
                // certified_count, selected_count == interview_count), so we read each
                // canonical count once — no duplicate Certified / Interview Scheduled
                // pills — and filter /applications by the canonical status directly.
                { status: 'screening',           count: stats.applied_count },
                { status: 'certified',           count: stats.certified_count },
                { status: 'interview_scheduled', count: stats.interview_scheduled ?? stats.interview_count },
                { status: 'rejected',            count: stats.rejected_count },
              ].map(({ status, count }) => (
                <Link
                  key={status}
                  to={`/applications?project_id=${id}&status=${status}`}
                  className="block"
                >
                  <LifecyclePill status={status} count={count} />
                </Link>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">Positions filled</span>
                <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
                  {filledPositions} / {totalPositions}
                </span>
              </div>
              <div className="mt-2 w-full bg-zinc-200/70 dark:bg-zinc-800 rounded-full h-2 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary-500 to-emerald-500 transition-all duration-700"
                  style={{ width: `${completionRate}%` }}
                />
              </div>
            </div>
          </Card>

          {/* Team Card */}
          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4">Project Team</h2>
            {project.team && project.team.length > 0 ? (
              <div className="space-y-3">
                {project.team.map((member) => (
                  <div key={member.id} className="flex items-start gap-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 p-3">
                    <div className="w-10 h-10 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center font-medium">
                      {member.full_name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium leading-tight text-zinc-900 dark:text-zinc-50 break-words">{member.full_name}</p>
                      <p className="mt-1 text-xs leading-snug text-zinc-500 dark:text-zinc-400 break-words">{member.email}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge status={member.user_role} className="text-xs" />
                        <span className="text-xs text-zinc-500 dark:text-zinc-400 capitalize">• {member.role}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-zinc-500 dark:text-zinc-400 py-4 text-sm">No team members assigned</p>
            )}
          </Card>

          {/* Quick Actions */}
          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-3">Quick Actions</h2>
            <div className="space-y-2">
              <Link
                to={`/jobs?project_id=${id}`}
                className="block w-full text-center px-4 py-2 bg-primary-50 text-primary-700 hover:bg-primary-100 rounded-lg font-medium text-sm transition-colors"
              >
                View Project Jobs
              </Link>
              <Link
                to={`/applications?project_id=${id}`}
                className="block w-full text-center px-4 py-2 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-gray-200 rounded-lg font-medium text-sm transition-colors"
              >
                View Applications
              </Link>
              <Link
                to={`/interviews?project_id=${id}`}
                className="block w-full text-center px-4 py-2 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg font-medium text-sm transition-colors"
              >
                View Interviews
              </Link>
            </div>
          </Card>
        </div>
      </div>

      {/* Create Job Modal */}
      <CreateJobModal
        projectId={id}
        isOpen={isJobModalOpen}
        onClose={() => setIsJobModalOpen(false)}
      />

      <EditProjectModal
        isOpen={isEditOpen}
        project={project}
        onClose={() => setIsEditOpen(false)}
      />
    </div>
  )
}
