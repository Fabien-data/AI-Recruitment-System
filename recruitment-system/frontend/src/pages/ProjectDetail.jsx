import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getProject, getProjectJobs, getProjectCandidates, getProjectStats, exportProjectCsv } from '../api'
import { 
  ArrowLeft, FolderKanban, MapPin, Calendar, Users, Briefcase, 
  DollarSign, Home, Bus, Utensils, FileText, Plane, Phone, Mail, MapPinned, Plus, User, Download
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { Button } from '../components/ui/Button'
import { CreateJobModal } from '../components/CreateJobModal'
import { format } from 'date-fns'
import { useAuthStore } from '../stores/authStore'

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
                  <p className="mt-1 text-xs leading-snug text-zinc-500 dark:text-zinc-400 break-words">{c.application_status || c.status || 'applied'}</p>
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

export default function ProjectDetail() {
  const { id } = useParams()
  const { user } = useAuthStore()
  const [candidatesJobFilter, setCandidatesJobFilter] = useState('')
  const [isJobModalOpen, setIsJobModalOpen] = useState(false)

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
        <Skeleton className="h-4 w-full mb-2" />
        <Skeleton className="h-4 w-2/3 mb-8" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card><Skeleton className="h-32" /></Card>
            <Card><Skeleton className="h-48" /></Card>
          </div>
          <div className="space-y-6">
            <Card><Skeleton className="h-24" /></Card>
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

  const countries = typeof project.countries === 'string' ? JSON.parse(project.countries) : project.countries
  const benefits = typeof project.benefits === 'string' ? JSON.parse(project.benefits) : project.benefits
  const salaryInfo = typeof project.salary_info === 'string' ? JSON.parse(project.salary_info) : project.salary_info
  const contactInfo = typeof project.contact_info === 'string' ? JSON.parse(project.contact_info) : project.contact_info
  
  const benefitIcons = {
    accommodation: Home,
    transport: Bus,
    meals: Utensils,
    visa: FileText,
    ticket: Plane
  }

  const activeBenefits = Object.entries(benefits).filter(([_, value]) => value)
  const stats = statsData || {}
  const completionRate = stats.total_positions > 0 
    ? Math.round((stats.filled_positions / stats.total_positions) * 100) 
    : 0

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      {/* Back Navigation */}
      <Link to="/projects" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6 font-medium">
        <ArrowLeft size={20} /> Back to Projects
      </Link>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-50 break-words">{project.title}</h1>
            <Badge status={project.status} />
            <Badge status={project.priority} />
          </div>
          <p className="text-xl text-zinc-600 dark:text-zinc-400 mb-3">{project.client_name}</p>
          <div className="flex flex-wrap items-center gap-4 text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <FolderKanban size={18} /> {project.industry_type}
            </span>
            {project.interview_date && (
              <span className="inline-flex items-center gap-1">
                <Calendar size={18} /> Interview: {format(new Date(project.interview_date), 'MMM d, yyyy')}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Users size={18} /> {project.team?.length || 0} Team Members
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="inline-flex items-center gap-1"
            onClick={() => exportProjectCsv(id)}
          >
            <Download size={15} /> Export CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Overview Card */}
          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4">Project Overview</h2>
            
            {/* Countries */}
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

            {/* Description */}
            {project.description && (
              <div className="mb-4">
                <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Description</h3>
                <p className="text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">{project.description}</p>
              </div>
            )}

            {/* Timeline */}
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

            {/* Benefits */}
            {activeBenefits.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-3">Benefits Included</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {activeBenefits.map(([benefit]) => {
                    const Icon = benefitIcons[benefit]
                    return (
                      <div
                        key={benefit}
                        className="flex items-center gap-2.5 rounded-xl bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/40 dark:to-zinc-900 ring-1 ring-inset ring-emerald-100 dark:ring-emerald-900/60 px-3 py-2.5"
                      >
                        <div className="rounded-lg bg-emerald-100 dark:bg-emerald-900/60 p-1.5 text-emerald-700 dark:text-emerald-200 shadow-sm">
                          {Icon && <Icon size={14} aria-hidden />}
                        </div>
                        <span className="capitalize text-sm font-medium text-zinc-800 dark:text-zinc-200">{benefit}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Salary */}
            {(salaryInfo?.min || salaryInfo?.max) && (
              <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
                <DollarSign size={20} className="text-blue-600" />
                <span className="font-medium text-zinc-900 dark:text-zinc-50">
                  {salaryInfo.currency} {salaryInfo.min || 0} - {salaryInfo.max || 0}
                </span>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">per month</span>
              </div>
            )}

            {/* Contact Information */}
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

          {/* Jobs Card */}
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
                <Link to="/jobs" className="text-primary-600 hover:text-primary-700 text-sm font-medium">
                  View All Jobs
                </Link>
              </div>
            </div>
            {project.jobs && project.jobs.length > 0 ? (
              <div className="space-y-3">
                {project.jobs.map((job) => (
                  <Link
                    key={job.id}
                    to={`/jobs/${job.id}`}
                    className="block rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <h3 className="font-medium text-zinc-900 dark:text-zinc-50">{job.title}</h3>
                      <Badge status={job.status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-600 dark:text-zinc-400">
                      <span className="inline-flex items-center gap-1">
                        <Briefcase size={14} /> {job.category}
                      </span>
                      <span>
                        {job.candidate_count || 0} candidates
                      </span>
                      <span>
                        {job.positions_filled || 0} / {job.positions_available || 1} filled
                      </span>
                    </div>
                  </Link>
                ))}
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

          {/* Candidates Card */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Candidates</h2>
              <div className="flex flex-wrap items-center justify-end gap-3">
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

            {/* Pipeline stats */}
            {stats.total_applications > 0 && (
              <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
                <PipelineStat tone="blue" label="Total" value={stats.total_applications} />
                <PipelineStat tone="amber" label="Screening" value={stats.screening_count || 0} />
                <PipelineStat tone="purple" label="Interview" value={stats.interview_count || 0} />
                <PipelineStat tone="emerald" label="Selected" value={stats.selected_count || 0} />
              </div>
            )}

            {/* Candidate cards */}
            <ProjectCandidateList projectId={id} jobFilter={candidatesJobFilter} />
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Stats Card */}
          <Card accent="blue">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4">Progress</h2>
            <div className="space-y-4">
              <div>
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="text-zinc-600 dark:text-zinc-400">Positions Filled</span>
                  <span className="font-semibold text-zinc-900 dark:text-zinc-50">{completionRate}%</span>
                </div>
                <div className="w-full bg-zinc-200/70 dark:bg-zinc-800 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary-500 to-primary-600 transition-all duration-500"
                    style={{ width: `${completionRate}%` }}
                  />
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                  {stats.filled_positions || 0} of {stats.total_positions || 0} positions filled
                </p>
              </div>

              <div className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">Total Jobs</span>
                  <span className="text-lg font-bold text-zinc-900 dark:text-zinc-50">{stats.total_jobs || 0}</span>
                </div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">Total Candidates</span>
                  <span className="text-lg font-bold text-zinc-900 dark:text-zinc-50">{stats.unique_candidates || 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-600 dark:text-zinc-400">Applications</span>
                  <span className="text-lg font-bold text-zinc-900 dark:text-zinc-50">{stats.total_applications || 0}</span>
                </div>
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

          {/* Quick Actions Card */}
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
    </div>
  )
}

const pipelineTones = {
  blue:    { wrap: 'section-grad-blue ring-blue-200/60 dark:ring-blue-900/60',       label: 'text-blue-700 dark:text-blue-300',       value: 'text-blue-900 dark:text-blue-100' },
  amber:   { wrap: 'section-grad-amber ring-amber-200/60 dark:ring-amber-900/60',    label: 'text-amber-700 dark:text-amber-300',     value: 'text-amber-900 dark:text-amber-100' },
  purple:  { wrap: 'section-grad-purple ring-purple-200/60 dark:ring-purple-900/60', label: 'text-purple-700 dark:text-purple-300',   value: 'text-purple-900 dark:text-purple-100' },
  emerald: { wrap: 'section-grad-emerald ring-emerald-200/60 dark:ring-emerald-900/60', label: 'text-emerald-700 dark:text-emerald-300', value: 'text-emerald-900 dark:text-emerald-100' },
}

function PipelineStat({ tone = 'blue', label, value }) {
  const t = pipelineTones[tone] || pipelineTones.blue
  return (
    <div className={`rounded-xl ring-1 ring-inset p-3 text-center ${t.wrap}`}>
      <p className={`text-[10px] font-semibold uppercase tracking-wider ${t.label}`}>{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${t.value}`}>{value}</p>
    </div>
  )
}
