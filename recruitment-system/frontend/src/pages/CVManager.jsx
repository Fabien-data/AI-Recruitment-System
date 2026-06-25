import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
import { Link, useSearchParams } from 'react-router-dom'
import { showNotificationToast } from '../utils/notificationToast'
import {
  getCandidates,
  getCandidate,
  getJobs,
  getProjects,
  getApplications,
  createApplication,
  updateApplication,
  transferApplication,
  updateCandidate,
  batchAutoAssign,
  reparseCv,
  screenCandidate,
  uploadCandidateDocument,
  setCandidateStage,
  apiClient,
} from '../api'
import { getStatusLabel, normalizeStatus, CANDIDATE_STAGES, CANDIDATE_STAGE_LABELS, CANDIDATE_MANUAL_STATUS_OPTIONS, FUTURE_POOL_CATEGORY_OPTIONS } from '../constants/lifecycle'
import { FuturePoolTags } from '../components/ui/FuturePoolTags'
import { useSectionAccess } from '../stores/authStore'
import { EditCandidateModal } from '../components/EditCandidateModal'
import {
  Search,
  FileText,
  CheckCircle,
  ArrowRight,
  MessageSquare,
  Briefcase,
  User,
  Database,
  Star,
  Clock,
  Download,
  Eye,
  Tag,
  Filter,
  ChevronDown,
  AlertCircle,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Building,
  MapPin,
  DollarSign,
  Send,
  Bell,
  Smartphone,
  Sparkles,
  Plus,
  Pencil,
  Calendar,
  MapPinned,
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal, ConfirmModal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { PageHeader } from '../components/ui/PageHeader'
import { Tabs } from '../components/ui/Tabs'
import { CallRemarksPanel } from '../components/communications/CallRemarksPanel'
import ProjectJobSelector from '../components/applications/ProjectJobSelector'
import { CertifyDialog, ScheduleInterviewDialog } from '../components/communications/StageActionDialogs'
import { EmptyState } from '../components/ui/EmptyState'
import { FileSearch, BadgeCheck, CalendarClock } from 'lucide-react'
import toast from 'react-hot-toast'
import { getDocumentCategory, resolveDocumentUrl, isImageDocument, PENDING_URL } from '../utils/documents'
import { formatHeight } from '../utils/height'
import { DocumentPreview } from '../components/documents/DocumentPreview'

const DEBOUNCE_MS = 300

// Safely parse tags/skills that may arrive as a JSON string or an array
function parseTags(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return value.split(',').map(t => t.trim()).filter(Boolean) }
  }
  return []
}

function getCvSourceUrl(cv) {
  return cv?.resolved_file_url || cv?.file_url || ''
}

// getDocumentCategory, resolveDocumentUrl and isImageDocument all live in
// utils/documents.js (imported at top) so Communications + CandidateDetail +
// this page classify and resolve CV URLs the same way — including chatbot://
// uploads (→ PENDING_URL) and image rendering (B004/B014).

// Remark types for CV evaluation
const REMARK_TYPES = [
  { id: 'excellent',     label: 'Excellent Candidate', tone: 'emerald', icon: Star },
  { id: 'good',          label: 'Good Fit',            tone: 'blue',    icon: CheckCircle2 },
  { id: 'potential',     label: 'Has Potential',       tone: 'indigo',  icon: Clock },
  { id: 'needs_review',  label: 'Needs Review',        tone: 'amber',   icon: Eye },
  { id: 'not_qualified', label: 'Not Qualified',       tone: 'rose',    icon: XCircle },
  { id: 'future_pool',   label: 'Future Pool',         tone: 'purple',  icon: Database },
]

const REMARK_TONES = {
  emerald: { idle: 'border-emerald-200/70 dark:border-emerald-900/60 bg-emerald-50/40 dark:bg-emerald-950/20 hover:border-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40', sel: 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/50 ring-2 ring-emerald-500/30',  icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200', label: 'text-emerald-900 dark:text-emerald-100' },
  blue:    { idle: 'border-blue-200/70 dark:border-blue-900/60 bg-blue-50/40 dark:bg-blue-950/20 hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40',                  sel: 'border-blue-500 bg-blue-50 dark:bg-blue-950/50 ring-2 ring-blue-500/30',          icon: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200',           label: 'text-blue-900 dark:text-blue-100' },
  indigo:  { idle: 'border-indigo-200/70 dark:border-indigo-900/60 bg-indigo-50/40 dark:bg-indigo-950/20 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40',  sel: 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/50 ring-2 ring-indigo-500/30',  icon: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200',     label: 'text-indigo-900 dark:text-indigo-100' },
  amber:   { idle: 'border-amber-200/70 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20 hover:border-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40',          sel: 'border-amber-500 bg-amber-50 dark:bg-amber-950/50 ring-2 ring-amber-500/30',     icon: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200',         label: 'text-amber-900 dark:text-amber-100' },
  rose:    { idle: 'border-rose-200/70 dark:border-rose-900/60 bg-rose-50/40 dark:bg-rose-950/20 hover:border-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40',                  sel: 'border-rose-500 bg-rose-50 dark:bg-rose-950/50 ring-2 ring-rose-500/30',         icon: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-200',             label: 'text-rose-900 dark:text-rose-100' },
  purple:  { idle: 'border-purple-200/70 dark:border-purple-900/60 bg-purple-50/40 dark:bg-purple-950/20 hover:border-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/40',  sel: 'border-purple-500 bg-purple-50 dark:bg-purple-950/50 ring-2 ring-purple-500/30',  icon: 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-200',     label: 'text-purple-900 dark:text-purple-100' },
}

export default function CVManager() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
  // Future Pool drill-down (only meaningful when statusFilter === 'future_pool').
  const [futurePoolCat, setFuturePoolCat] = useState('')
  const [futurePoolCountry, setFuturePoolCountry] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [jobFilter, setJobFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [languageFilter, setLanguageFilter] = useState('')
  const [hasCvFilter, setHasCvFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  const queryClient = useQueryClient()

  // Auto-assign hits backend routes that require applications.create; hide the
  // trigger for roles that can reach CV Manager but would get a 403 (e.g.
  // marketing_agent, project_handler).
  const canAutoAssign = useSectionAccess('applications', 'create')

  // Options for the Job / Project selects (active jobs + all projects).
  const { data: jobsOptions } = useQuery({
    queryKey: ['jobs', { status: 'active', limit: 200 }],
    queryFn: () => getJobs({ status: 'active', limit: 200 }),
  })
  const { data: projectsOptions } = useQuery({
    queryKey: ['projects', { limit: 200 }],
    queryFn: () => getProjects({ limit: 200 }),
  })
  const jobChoices = jobsOptions?.data || []
  const projectChoices = projectsOptions?.data || projectsOptions || []

  const clearAllFilters = () => {
    setStatusFilter(''); setSourceFilter(''); setJobFilter(''); setProjectFilter('')
    setLanguageFilter(''); setHasCvFilter(''); setDateFrom(''); setDateTo('')
    setFuturePoolCat(''); setFuturePoolCountry('')
  }

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  // Any filter change should send the user back to page 1 (otherwise a
  // narrower result set can leave them stranded on an empty later page).
  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, sourceFilter, jobFilter, projectFilter, languageFilter, hasCvFilter, dateFrom, dateTo, futurePoolCat, futurePoolCountry])

  const candidateIdFromQuery = searchParams.get('candidate')

  useEffect(() => {
    if (!candidateIdFromQuery) return
    setSelectedCandidate((currentCandidate) => {
      if (currentCandidate?.id === candidateIdFromQuery) return currentCandidate
      return { id: candidateIdFromQuery, name: 'Candidate' }
    })
  }, [candidateIdFromQuery])

  const handleCloseReview = () => {
    setSelectedCandidate(null)
    if (!candidateIdFromQuery) return
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('candidate')
    setSearchParams(nextParams, { replace: true })
  }

  const candidateQueryParams = {
    page,
    search,
    limit: 20,
    status: statusFilter || undefined,
    source: sourceFilter || undefined,
    job_id: jobFilter || undefined,
    project_ids: projectFilter || undefined,
    language: languageFilter || undefined,
    has_cv: hasCvFilter || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    // Future Pool drill-down only applies inside the Future Pool view.
    future_pool_category: statusFilter === 'future_pool' ? (futurePoolCat || undefined) : undefined,
    future_pool_country: statusFilter === 'future_pool' ? (futurePoolCountry.trim() || undefined) : undefined,
  }

  const { data: candidatesData, isLoading: isLoadingCandidates, refetch } = useQuery({
    queryKey: ['candidates', candidateQueryParams],
    queryFn: () => getCandidates(candidateQueryParams)
  })

  // Auto-assign all new candidates to matching jobs
  const autoAssignMutation = useMutation({
    mutationFn: () => batchAutoAssign(50, 'new'),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
      toast.custom((t) => (
        <div className={`${t.visible ? 'animate-enter' : 'animate-leave'} max-w-md w-full bg-white dark:bg-zinc-900 shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5`}>
          <div className="flex-1 w-0 p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0 pt-0.5">
                <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                  <Sparkles className="h-6 w-6 text-blue-600" />
                </div>
              </div>
              <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Auto-Assignment Complete!</p>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  {data.assigned} assigned to jobs, {data.to_pool} moved to general pool
                </p>
              </div>
            </div>
          </div>
          <div className="flex border-l border-zinc-200 dark:border-zinc-800">
            <button
              onClick={() => toast.dismiss(t.id)}
              className="w-full border border-transparent rounded-none rounded-r-lg p-4 flex items-center justify-center text-sm font-medium text-primary-600 hover:text-primary-500"
            >
              Close
            </button>
          </div>
        </div>
      ), { duration: 5000 })
    },
    onError: (error) => {
      toast.error('Auto-assign failed: ' + error.message)
    }
  })

  const candidatesList = candidatesData?.data || []
  const pagination = candidatesData?.pagination

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={FileSearch}
        tone="blue"
        title="CV Manager"
        subtitle="Review, Remark, and Assign Candidates to Projects"
        actions={
          <>
            {canAutoAssign && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => autoAssignMutation.mutate()}
                loading={autoAssignMutation.isPending}
              >
                <Sparkles size={16} />
                Auto-Assign All
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => refetch()} aria-label="Refresh">
              <RefreshCw size={16} />
            </Button>
          </>
        }
      />

      {/* Search and Filters */}
      <div className="card mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" size={20} />
            <input
              type="text"
              placeholder="Search candidates by name, phone, or email..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="input pl-10 w-full"
            />
          </div>

          <Button
            variant="secondary"
            onClick={() => setShowFilters(!showFilters)}
            className="gap-1"
          >
            <Filter size={16} /> Filters
            <ChevronDown size={16} className={`transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </Button>
        </div>

        {/* Filter Options */}
        {showFilters && (
          <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-800 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Status</label>
              <select
                className="input w-full"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">All Statuses</option>
                <option value="new">New</option>
                <option value="screening">Screening</option>
                <option value="certified">Certified</option>
                <option value="interview_scheduled">Interview Scheduled</option>
                <option value="future_pool">Future Pool</option>
              </select>
            </div>
            {statusFilter === 'future_pool' && (
              <>
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Future Pool reason</label>
                  <select className="input w-full" value={futurePoolCat} onChange={(e) => setFuturePoolCat(e.target.value)}>
                    {FUTURE_POOL_CATEGORY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Desired country</label>
                  <input
                    type="text"
                    className="input w-full"
                    placeholder="e.g. Qatar"
                    value={futurePoolCountry}
                    onChange={(e) => setFuturePoolCountry(e.target.value)}
                  />
                </div>
              </>
            )}
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Source</label>
              <select
                className="input w-full"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
              >
                <option value="">All Sources</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="email">Email</option>
                <option value="messenger">Messenger</option>
                <option value="walkin">Walk-in</option>
                <option value="web">Web</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Job</label>
              <select className="input w-full" value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
                <option value="">All Jobs</option>
                {jobChoices.map((j) => (
                  <option key={j.id} value={j.id}>{j.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Project</label>
              <select className="input w-full" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
                <option value="">All Projects</option>
                {projectChoices.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Language</label>
              <select className="input w-full" value={languageFilter} onChange={(e) => setLanguageFilter(e.target.value)}>
                <option value="">All Languages</option>
                <option value="en">English</option>
                <option value="si">Sinhala</option>
                <option value="ta">Tamil</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">CV</label>
              <select className="input w-full" value={hasCvFilter} onChange={(e) => setHasCvFilter(e.target.value)}>
                <option value="">All Candidates</option>
                <option value="true">CV uploaded</option>
                <option value="false">No CV</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Added from</label>
              <input type="date" className="input w-full" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Added to</label>
              <input type="date" className="input w-full" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button variant="secondary" size="sm" onClick={clearAllFilters}>
                Clear Filters
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
        <StatCard label="Total CVs" value={pagination?.total || 0} color="blue" />
        <StatCard label="New" value={candidatesList.filter(c => normalizeStatus(c.status) === 'new').length} color="green" />
        <StatCard label="Screening" value={candidatesList.filter(c => normalizeStatus(c.status) === 'screening').length} color="amber" />
        <StatCard label="Certified" value={candidatesList.filter(c => normalizeStatus(c.status) === 'certified').length} color="emerald" />
        <StatCard label="Interview Scheduled" value={candidatesList.filter(c => normalizeStatus(c.status) === 'interview_scheduled').length} color="purple" />
        <StatCard label="Future Pool" value={candidatesList.filter(c => normalizeStatus(c.status) === 'future_pool').length} color="gray" />
      </div>

      {/* Candidates List */}
      <div className="card overflow-hidden">
        {isLoadingCandidates ? (
          <TableSkeleton rows={8} cols={6} />
        ) : candidatesList.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 dark:text-zinc-400">
            <User className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600 mb-2" />
            <p className="font-medium">No candidates found</p>
            <p className="text-sm mt-1">Click "Seed Mock Data" to add sample candidates for testing</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Candidate</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Contact</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Skills</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Source</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Actions</th>
                </tr>
              </thead>
              <tbody>
                {candidatesList.map((candidate) => (
                  <tr key={candidate.id} className="border-b border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white font-semibold">
                          {candidate.name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div>
                          <p className="font-medium text-zinc-900 dark:text-zinc-50">{candidate.name}</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">ID: {candidate.id?.slice(0, 8)}...</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <p className="text-zinc-900 dark:text-zinc-50">{candidate.phone}</p>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">{candidate.email || 'No email'}</p>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {parseTags(candidate.tags || candidate.skills).slice(0, 3).map((skill, i) => (
                          <span key={i} className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 px-2 py-0.5 rounded-full">{skill}</span>
                        ))}
                        {parseTags(candidate.tags || candidate.skills).length > 3 && (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">+{parseTags(candidate.tags || candidate.skills).length - 3}</span>
                        )}
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <SourceBadge source={candidate.source} />
                    </td>
                    <td className="py-4 px-4">
                      <Badge status={candidate.status} />
                      <FuturePoolTags candidate={candidate} className="mt-1.5 max-w-[220px]" />
                    </td>
                    <td className="py-4 px-4">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setSelectedCandidate(candidate)}
                        className="gap-1"
                      >
                        <Eye size={14} /> Review & Manage
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex justify-between items-center px-4 py-3 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Showing {((page - 1) * 20) + 1} to {Math.min(page * 20, pagination.total)} of {pagination.total} candidates
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage(p => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {selectedCandidate && (
        <CVReviewModal
          candidate={selectedCandidate}
          onClose={handleCloseReview}
        />
      )}
    </div>
  )
}

function StatCard({ label, value, color }) {
  const colorClasses = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    gray: 'bg-zinc-50 dark:bg-zinc-900/60 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800'
  }

  return (
    <div className={`card py-3 px-4 border ${colorClasses[color]}`}>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-sm opacity-80">{label}</p>
    </div>
  )
}

function SourceBadge({ source }) {
  const sourceStyles = {
    whatsapp: 'bg-green-100 text-green-700',
    email: 'bg-blue-100 text-blue-700',
    messenger: 'bg-purple-100 text-purple-700',
    walkin: 'bg-amber-100 text-amber-700',
    web: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
    manual: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
  }

  return (
    <span className={`text-xs px-2 py-1 rounded-full capitalize ${sourceStyles[source] || sourceStyles.manual}`}>
      {source || 'Unknown'}
    </span>
  )
}

// Exported so the Communications panel can open the full CV review/edit flow
// in-place (as a modal over the conversation) without navigating away — the
// agent never loses the chat they were on.
export function CVReviewModal({ candidate, onClose }) {
  const [activeTab, setActiveTab] = useState('overview')
  const queryClient = useQueryClient()

  // Fetch Full Candidate Details (including CVs and metadata)
  const { data: fullCandidateData } = useQuery({
    queryKey: ['candidate', candidate.id],
    queryFn: () => getCandidate(candidate.id),
    enabled: !!candidate?.id,
  })

  const fullCandidate = fullCandidateData || candidate

  // Fetch Jobs for allocation
  const { data: jobsData } = useQuery({
    queryKey: ['jobs', { status: 'active' }],
    queryFn: () => getJobs({ status: 'active' })
  })

  // Fetch Applications for this candidate
  const { data: applicationsData } = useQuery({
    queryKey: ['applications', { candidate_id: candidate.id }],
    queryFn: () => getApplications({ candidate_id: candidate.id })
  })

  const jobs = jobsData?.data || []
  const applications = Array.isArray(applicationsData) ? applicationsData : []

  const tabs = [
    { value: 'overview',     label: 'Overview',         icon: User,          tone: 'blue' },
    { value: 'ai_insights',  label: 'AI Insights',      icon: Sparkles,      tone: 'purple' },
    { value: 'remarks',      label: 'Remarks & Notes',  icon: MessageSquare, tone: 'amber' },
    { value: 'applications', label: 'Applied Position', icon: Briefcase,     tone: 'emerald', count: applications.length },
    { value: 'allocate',     label: 'Assign Project',   icon: Building,      tone: 'indigo' },
  ]

  return (
    <Modal open={true} onClose={onClose} title={`Review: ${candidate.name || 'Candidate'}`} size="lg">
      <Tabs value={activeTab} onChange={setActiveTab} items={tabs} className="mb-6" />

      <div className="min-h-[450px]">
        {activeTab === 'overview' && (
          <OverviewTab candidate={fullCandidate} />
        )}
        {activeTab === 'ai_insights' && (
          <AIInsightsTab candidate={fullCandidate} />
        )}
        {activeTab === 'remarks' && (
          <RemarksTab candidate={fullCandidate} />
        )}
        {activeTab === 'applications' && (
          <ApplicationsTab applications={applications} candidate={fullCandidate} jobs={jobs} />
        )}
        {activeTab === 'allocate' && (
          <AllocateTab candidate={fullCandidate} jobs={jobs} existingApplications={applications} />
        )}
      </div>
    </Modal>
  )
}

function OverviewTab({ candidate }) {
  const [expandedCVs, setExpandedCVs] = useState({})
  const [reparsingId, setReparsingId] = useState(null)
  const [docType, setDocType] = useState('cv')
  const [editOpen, setEditOpen] = useState(false)
  const [certifyOpen, setCertifyOpen] = useState(false)
  const [interviewOpen, setInterviewOpen] = useState(false)
  const docFileRef = useRef(null)
  const queryClient = useQueryClient()

  // Quick status change from the overview header. Status changes are NOT silent
  // (user decision 2026-06-11): the candidate is notified of the new stage.
  // certified / interview route to the dialogs (which carry notes / a date and
  // notify with full context); the rest send the matching message via notify=true.
  const statusMutation = useMutation({
    mutationFn: (status) => setCandidateStage(candidate.id, status, true),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['candidate', candidate.id] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      const waOk = res?.notification?.success?.some?.((s) => s.channel === 'whatsapp')
      toast.success(waOk ? 'Status updated — candidate notified' : 'Status updated')
    },
    onError: (e) => toast.error(e?.response?.data?.error || 'Failed to update status'),
  })

  const onStatusSelect = (value) => {
    if (!value) return
    if (value === 'certified') { setCertifyOpen(true); return }
    if (value === 'interview_scheduled') { setInterviewOpen(true); return }
    statusMutation.mutate(value)
  }

  const uploadDocMutation = useMutation({
    mutationFn: ({ file, doc_type }) => uploadCandidateDocument(candidate.id, file, doc_type),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate', candidate.id] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      toast.success('Document uploaded')
      if (docFileRef.current) docFileRef.current.value = ''
    },
    onError: (e) => toast.error(e?.response?.data?.error || 'Upload failed'),
  })

  const onPickDoc = (e) => {
    const file = e.target.files?.[0]
    if (file) uploadDocMutation.mutate({ file, doc_type: docType })
  }

  const toggleCV = (id) => {
    setExpandedCVs(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const handleReparse = async (cvId) => {
    setReparsingId(cvId)
    try {
      await reparseCv(cvId)
      await queryClient.invalidateQueries({ queryKey: ['candidate', candidate.id] })
      await queryClient.invalidateQueries({ queryKey: ['candidates'] })
      showNotificationToast?.({ title: 'Re-parsed', message: 'CV details refreshed from the document.', type: 'success' })
    } catch (e) {
      const msg = e?.response?.data?.error || e.message || 'Re-parse failed'
      showNotificationToast?.({ title: 'Re-parse failed', message: msg, type: 'error' })
    } finally {
      setReparsingId(null)
    }
  }

  const metadata = typeof candidate.metadata === 'string'
    ? JSON.parse(candidate.metadata || '{}')
    : (candidate.metadata || {})

  const mismatches = metadata.mismatches || []
  const cvDocuments = (candidate.cvs || []).filter(cv => getDocumentCategory(cv) === 'cv')
  // Everything that isn't a primary CV (passport / certificate / photo / other).
  const additionalDocuments = (candidate.cvs || []).filter(cv => getDocumentCategory(cv) !== 'cv')

  const safeParseJSON = (str) => {
    if (!str) return null;
    if (typeof str === 'object') return str;
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Candidate Info Card */}
      <div className="rounded-2xl bg-gradient-to-br from-blue-50 via-white to-white dark:from-blue-950/40 dark:via-zinc-900 dark:to-zinc-900 ring-1 ring-inset ring-blue-100 dark:ring-blue-900/60 p-5">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-2xl font-bold flex-shrink-0 ring-2 ring-white dark:ring-zinc-900 shadow-lg">
            {candidate.name?.charAt(0)?.toUpperCase() || '?'}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-50 tracking-tight truncate">{candidate.name}</h3>
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-zinc-600 dark:text-zinc-400">
              {candidate.phone && (
                <span className="inline-flex items-center gap-1.5">
                  <Smartphone size={13} className="text-zinc-400" />{candidate.phone}
                </span>
              )}
              {candidate.email && (
                <span className="inline-flex items-center gap-1.5">
                  <Send size={13} className="text-zinc-400" />{candidate.email}
                </span>
              )}
              {candidate.preferred_language && (
                <span className="inline-flex items-center gap-1 rounded-full bg-white/80 dark:bg-zinc-900/60 ring-1 ring-zinc-200 dark:ring-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  {candidate.preferred_language.toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-2 shrink-0">
            <Badge status={candidate.status} />
            {/* Quick status change */}
            <select
              value={CANDIDATE_MANUAL_STATUS_OPTIONS.some((o) => o.value === normalizeStatus(candidate.status)) ? normalizeStatus(candidate.status) : ''}
              onChange={(e) => onStatusSelect(e.target.value)}
              disabled={statusMutation.isPending}
              title="Change candidate status (notifies the candidate)"
              className="input text-xs py-1 w-40"
            >
              <option value="" disabled>Set status…</option>
              {CANDIDATE_MANUAL_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {/* Certify / Schedule also notify with full context (notes / date).
                Changing status in the dropdown above now notifies too. */}
            <div className="flex gap-1.5">
              <Button size="sm" variant="secondary" className="gap-1 text-emerald-700 dark:text-emerald-300" onClick={() => setCertifyOpen(true)}>
                <BadgeCheck size={14} /> Certify &amp; notify
              </Button>
              <Button size="sm" variant="secondary" className="gap-1 text-indigo-700 dark:text-indigo-300" onClick={() => setInterviewOpen(true)}>
                <CalendarClock size={14} /> Schedule interview
              </Button>
            </div>
            <Button size="sm" variant="secondary" className="gap-1" onClick={() => setEditOpen(true)}>
              <Pencil size={14} /> Edit details
            </Button>
          </div>
        </div>
      </div>

      <EditCandidateModal candidate={candidate} open={editOpen} onClose={() => setEditOpen(false)} />
      <CertifyDialog
        open={certifyOpen}
        onClose={() => setCertifyOpen(false)}
        candidateId={candidate.id}
        candidateName={candidate.name}
      />
      <ScheduleInterviewDialog
        open={interviewOpen}
        onClose={() => setInterviewOpen(false)}
        candidateId={candidate.id}
        candidateName={candidate.name}
      />

      {/* Details Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <DetailCard label="Source"     value={candidate.source} icon={Database}    tone="indigo" />
        <DetailCard label="Height"     value={formatHeight(metadata.height_cm) || 'N/A'} icon={Star} tone="emerald" />
        <DetailCard label="Age"        value={(candidate.age || metadata.age) ? `${candidate.age || metadata.age} years` : 'N/A'} icon={User} tone="amber" />
        <DetailCard label="Experience" value={(candidate.experience_years || metadata.experience_years) ? `${candidate.experience_years || metadata.experience_years} years` : 'N/A'} icon={Briefcase} tone="purple" />
      </div>

      {/* Extra profile details captured from chat + CV extraction */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <DetailCard label="Country"   value={metadata.destination_country || metadata.country || candidate.preferred_country || 'N/A'} icon={MapPin} tone="indigo" />
        <DetailCard label="Licenses"  value={metadata.licenses || 'N/A'} icon={Tag} tone="amber" />
        <DetailCard label="Prev. Employer" value={metadata.previous_employer || 'N/A'} icon={Building} tone="purple" />
        <DetailCard label="English"   value={metadata.english_proficiency || 'N/A'} icon={CheckCircle} tone="emerald" />
      </div>

      {/* Profile completeness + needs-review flag */}
      {(() => {
        const checks = [
          !!candidate.name,
          !!(candidate.age || metadata.age),
          (candidate.experience_years != null || metadata.experience_years != null),
          parseTags(candidate.skills || candidate.tags).length > 0,
          !!(metadata.destination_country || metadata.country || candidate.preferred_country),
          (cvDocuments?.length || 0) > 0,
        ]
        const pct = Math.round((checks.filter(Boolean).length / checks.length) * 100)
        const needsReview = (cvDocuments?.length || 0) === 0 || (cvDocuments || []).some((cv) => {
          let pd = cv.parsed_data
          if (typeof pd === 'string') { try { pd = JSON.parse(pd) } catch { pd = {} } }
          pd = pd || {}
          const missing = Array.isArray(pd.missing_critical_fields) ? pd.missing_critical_fields.length : 0
          const conf = typeof pd.overall_confidence === 'number' ? pd.overall_confidence : 1
          return missing > 0 || conf < 0.6
        })
        const barTone = pct >= 80 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-red-500'
        return (
          <div className="rounded-2xl ring-1 ring-inset ring-zinc-200 dark:ring-zinc-800 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Profile completeness</span>
              <div className="flex items-center gap-2">
                {needsReview && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    <AlertCircle size={11} /> Needs review
                  </span>
                )}
                <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200">{pct}%</span>
              </div>
            </div>
            <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div className={clsx('h-full rounded-full transition-all', barTone)} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })()}

      {/* Mismatches Alert */}
      {mismatches.length > 0 && (
        <div className="rounded-2xl section-grad-amber ring-1 ring-inset ring-amber-200 dark:ring-amber-900/60 p-4">
          <h4 className="flex items-center gap-2 text-amber-900 dark:text-amber-200 font-semibold mb-2">
            <div className="rounded-lg bg-amber-100 dark:bg-amber-900/60 p-1.5 text-amber-700 dark:text-amber-200">
              <AlertCircle size={14} aria-hidden />
            </div>
            Requirement Mismatches
          </h4>
          <ul className="list-disc list-inside text-sm text-amber-800 dark:text-amber-200 space-y-1 ml-1">
            {mismatches.map((mismatch, idx) => (
              <li key={idx}>{typeof mismatch === 'string' ? mismatch : (mismatch?.reason || mismatch?.field || JSON.stringify(mismatch))}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Skills */}
      <div>
        <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Skills & Tags</h4>
        <div className="flex flex-wrap gap-2">
          {parseTags(candidate.skills || candidate.tags).map((tag, i) => (
            <span key={i} className="px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-sm font-medium">
              {tag}
            </span>
          ))}
          {parseTags(candidate.skills || candidate.tags).length === 0 && (
            <span className="text-zinc-500 dark:text-zinc-400 text-sm">No skills/tags added yet</span>
          )}
        </div>
      </div>

      {/* Add document — admin-side CV/passport/certificate/photo upload. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 p-3">
        <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Add document:</span>
        <select className="input w-auto" value={docType} onChange={(e) => setDocType(e.target.value)}>
          <option value="cv">CV / Resume</option>
          <option value="passport">Passport</option>
          <option value="certificate">Certificate</option>
          <option value="photo">Photo</option>
          <option value="other">Other</option>
        </select>
        <input
          ref={docFileRef}
          type="file"
          className="hidden"
          accept=".pdf,.doc,.docx,image/*"
          onChange={onPickDoc}
        />
        <Button
          size="sm"
          variant="secondary"
          className="gap-1"
          loading={uploadDocMutation.isPending}
          onClick={() => docFileRef.current?.click()}
        >
          <Plus size={14} /> Upload
        </Button>
      </div>

      {/* Primary CV Quick-View — shows the latest uploaded CV if available.
          Uses the shared DocumentPreview so image CVs render as <img> (not a
          broken PDF iframe), and chatbot uploads still syncing show a clear
          "processing" state instead of a dead preview (B014). */}
      {(() => {
        const primaryCv = cvDocuments?.[0]
        if (!primaryCv) return null
        // null → nothing to preview (the CV list below shows the messaging);
        // PENDING_URL is truthy so DocumentPreview can render its "processing".
        if (!resolveDocumentUrl(primaryCv)) return null
        return (
          <DocumentPreview cv={primaryCv} fileName={primaryCv.file_name || `CV_${candidate.name}`} className="h-96" />
        )
      })()}

      {/* CV Preview */}
      <div>
        <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">CV</h4>
        {cvDocuments && cvDocuments.length > 0 ? (
          <div className="space-y-3">
            {cvDocuments.map(cv => {
              // Shared resolver: real https URL when ready, PENDING_URL while a
              // chatbot upload is still syncing, null when there's nothing.
              const rawUrl = getCvSourceUrl(cv)
              const resolvedUrl = resolveDocumentUrl(cv)
              const pendingUpload = resolvedUrl === PENDING_URL
              const isChatbotRecord = rawUrl.startsWith('chatbot://')
              const parsedInsights = safeParseJSON(cv.parsed_data)

              return (
                <div key={cv.id} className="border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 overflow-hidden">
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="text-primary-500" size={24} />
                      <div>
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                          {cv.file_name && !isChatbotRecord
                            ? cv.file_name
                            : isChatbotRecord
                              ? 'CV (processed via chatbot)'
                              : 'CV Document'}
                        </span>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {cv.uploaded_at
                            ? `Received ${new Date(cv.uploaded_at).toLocaleDateString()}`
                            : 'CV on file'}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2 text-primary-600 flex-wrap justify-end">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-1"
                        onClick={() => toggleCV(cv.id)}
                        disabled={!parsedInsights}
                        title={parsedInsights ? 'Show AI insights' : 'AI insights not available'}
                      >
                        <Sparkles size={14} /> {expandedCVs[cv.id] ? 'Hide Insights' : 'AI Insights'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-1"
                        onClick={() => handleReparse(cv.id)}
                        loading={reparsingId === cv.id}
                        title="Re-run AI extraction on this document"
                      >
                        <RefreshCw size={14} /> Re-parse
                      </Button>
                      {resolvedUrl && !pendingUpload && (
                        <>
                          <a href={resolvedUrl} target="_blank" rel="noopener noreferrer">
                            <Button variant="secondary" size="sm" className="gap-1">
                              <Eye size={14} /> View
                            </Button>
                          </a>
                          <a href={resolvedUrl} download target="_blank" rel="noopener noreferrer">
                            <Button variant="secondary" size="sm" className="gap-1">
                              <Download size={14} /> Download
                            </Button>
                          </a>
                        </>
                      )}
                      {pendingUpload && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <Clock size={13} /> Processing…
                        </span>
                      )}
                    </div>
                  </div>

                  {expandedCVs[cv.id] && parsedInsights && (
                    <div className="px-4 py-3 bg-white dark:bg-zinc-900 border-t border-zinc-100 dark:border-zinc-800/60 text-sm">
                      <h5 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-2 flex items-center gap-1">
                        <Sparkles size={14} className="text-primary-500" /> AI Extracted Details
                      </h5>
                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                        {Object.entries(parsedInsights).map(([key, val]) => {
                          if (val == null || val === '' || key === 'raw_text' || key === 'language_register' || key.startsWith('__')) return null;
                          if (Array.isArray(val)) {
                            if (val.length === 0) return null;
                            const formattedKey = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                            return (
                              <div key={key} className="col-span-2">
                                <dt className="text-zinc-500 dark:text-zinc-400 text-xs">{formattedKey}</dt>
                                <dd className="font-medium text-zinc-900 dark:text-zinc-50">{val.join(', ')}</dd>
                              </div>
                            )
                          }
                          if (typeof val === 'object') return null;
                          const formattedKey = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                          return (
                            <div key={key}>
                              <dt className="text-zinc-500 dark:text-zinc-400 text-xs">{formattedKey}</dt>
                              <dd className="font-medium text-zinc-900 dark:text-zinc-50 break-words">{String(val)}</dd>
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
        ) : (
          <div className="p-6 text-center border border-dashed border-gray-300 rounded-lg bg-zinc-50 dark:bg-zinc-900/60">
            <FileText className="mx-auto h-8 w-8 text-zinc-400 dark:text-zinc-500 mb-2" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400 font-medium">No CV uploaded</p>
          </div>
        )}
      </div>

      {/* Additional Documents */}
      <div>
        <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Additional Documents</h4>
        {additionalDocuments && additionalDocuments.length > 0 ? (
          <div className="space-y-3">
            {additionalDocuments.map(doc => {
              const rawUrl = getCvSourceUrl(doc)
              const resolvedUrl = resolveDocumentUrl(doc)
              const pendingUpload = resolvedUrl === PENDING_URL
              const parsedInsights = safeParseJSON(doc.parsed_data)

              return (
                <div key={doc.id} className="border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 overflow-hidden">
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="text-primary-500" size={24} />
                      <div>
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                            {doc.file_name || 'Additional Document'}
                          </span>
                          <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                            {getDocumentCategory(doc)}
                          </span>
                        </span>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {doc.uploaded_at
                            ? `Received ${new Date(doc.uploaded_at).toLocaleDateString()}`
                            : 'Document on file'}
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-2 text-primary-600 flex-wrap justify-end">
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-1"
                        onClick={() => toggleCV(doc.id)}
                        disabled={!parsedInsights}
                        title={parsedInsights ? 'Show AI insights' : 'AI insights not available'}
                      >
                        <Sparkles size={14} /> {expandedCVs[doc.id] ? 'Hide Insights' : 'AI Insights'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="gap-1"
                        onClick={() => handleReparse(doc.id)}
                        loading={reparsingId === doc.id}
                        title="Re-run AI extraction on this document"
                      >
                        <RefreshCw size={14} /> Re-parse
                      </Button>
                      {resolvedUrl && !pendingUpload && (
                        <>
                          <a href={resolvedUrl} target="_blank" rel="noopener noreferrer">
                            <Button variant="secondary" size="sm" className="gap-1">
                              <Eye size={14} /> View
                            </Button>
                          </a>
                          <a href={resolvedUrl} download target="_blank" rel="noopener noreferrer">
                            <Button variant="secondary" size="sm" className="gap-1">
                              <Download size={14} /> Download
                            </Button>
                          </a>
                        </>
                      )}
                      {pendingUpload && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <Clock size={13} /> Processing…
                        </span>
                      )}
                    </div>
                  </div>

                  {expandedCVs[doc.id] && parsedInsights && (
                    <div className="px-4 py-3 bg-white dark:bg-zinc-900 border-t border-zinc-100 dark:border-zinc-800/60 text-sm">
                      <h5 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-2 flex items-center gap-1">
                        <Sparkles size={14} className="text-primary-500" /> AI Extracted Details
                      </h5>
                      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
                        {Object.entries(parsedInsights).map(([key, val]) => {
                          if (val == null || val === '' || key === 'raw_text' || key === 'language_register' || key.startsWith('__')) return null;
                          if (Array.isArray(val)) {
                            if (val.length === 0) return null;
                            const formattedKey = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                            return (
                              <div key={key} className="col-span-2">
                                <dt className="text-zinc-500 dark:text-zinc-400 text-xs">{formattedKey}</dt>
                                <dd className="font-medium text-zinc-900 dark:text-zinc-50">{val.join(', ')}</dd>
                              </div>
                            )
                          }
                          if (typeof val === 'object') return null;
                          const formattedKey = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                          return (
                            <div key={key}>
                              <dt className="text-zinc-500 dark:text-zinc-400 text-xs">{formattedKey}</dt>
                              <dd className="font-medium text-zinc-900 dark:text-zinc-50 break-words">{String(val)}</dd>
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
        ) : (
          <div className="p-6 text-center border border-dashed border-gray-300 rounded-lg bg-zinc-50 dark:bg-zinc-900/60">
            <FileText className="mx-auto h-8 w-8 text-zinc-400 dark:text-zinc-500 mb-2" />
            <p className="text-sm text-zinc-500 dark:text-zinc-400 font-medium">No additional documents uploaded</p>
          </div>
        )}
      </div>

      {/* Quick Notes Preview */}
      {candidate.notes && (
        <div>
          <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Quick Notes</h4>
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
            {candidate.notes}
          </div>
        </div>
      )}
    </div>
  )
}

const DETAIL_TONES = {
  indigo:  { wrap: 'bg-indigo-50/70 dark:bg-indigo-950/30 ring-indigo-100 dark:ring-indigo-900/50',   icon: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-200' },
  emerald: { wrap: 'bg-emerald-50/70 dark:bg-emerald-950/30 ring-emerald-100 dark:ring-emerald-900/50', icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200' },
  amber:   { wrap: 'bg-amber-50/70 dark:bg-amber-950/30 ring-amber-100 dark:ring-amber-900/50',       icon: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200' },
  purple:  { wrap: 'bg-purple-50/70 dark:bg-purple-950/30 ring-purple-100 dark:ring-purple-900/50',   icon: 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-200' },
  blue:    { wrap: 'bg-blue-50/70 dark:bg-blue-950/30 ring-blue-100 dark:ring-blue-900/50',           icon: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200' },
  zinc:    { wrap: 'bg-zinc-50 dark:bg-zinc-900/60 ring-zinc-100 dark:ring-zinc-800',                 icon: 'bg-white text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300' },
}

function DetailCard({ label, value, icon: Icon, tone = 'zinc' }) {
  const t = DETAIL_TONES[tone] || DETAIL_TONES.zinc
  const isReact = typeof Icon === 'function' || typeof Icon === 'object'
  return (
    <div className={`flex items-start gap-3 p-3.5 rounded-2xl ring-1 ring-inset min-h-[78px] ${t.wrap}`}>
      {Icon && (
        <div className={`flex-shrink-0 mt-0.5 rounded-lg p-1.5 shadow-sm ${t.icon}`}>
          {isReact ? <Icon size={14} aria-hidden /> : <span className="text-base leading-none">{Icon}</span>}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{label}</span>
        <p className="mt-0.5 font-semibold text-sm text-zinc-900 dark:text-zinc-50 break-words">{value || '—'}</p>
      </div>
    </div>
  )
}

// ─── AI Insights Tab ─────────────────────────────────────────────────────────
function AIInsightsTab({ candidate }) {
  const metadata = typeof candidate.metadata === 'string'
    ? JSON.parse(candidate.metadata || '{}')
    : (candidate.metadata || {})

  const mismatches = (metadata.mismatches || []).map(m =>
    typeof m === 'string' ? { field: m, reason: '', severity: 'warning' } : m
  )
  const criticalMismatches = mismatches.filter(m => m.severity === 'critical')
  const otherMismatches = mismatches.filter(m => m.severity !== 'critical')
  const strengths = metadata.strengths || parseTags(candidate.tags || candidate.skills).slice(0, 5).map(s => ({ label: s }))
  const matchScore = metadata.match_score || candidate.match_score || null

  const scoreColor = matchScore >= 70 ? '#10b981' : matchScore >= 50 ? '#f59e0b' : '#ef4444'
  const scoreTone = matchScore >= 70 ? 'emerald' : matchScore >= 50 ? 'amber' : 'rose'
  const scoreGrad = {
    emerald: 'section-grad-emerald ring-emerald-200/60 dark:ring-emerald-900/60',
    amber:   'section-grad-amber ring-amber-200/60 dark:ring-amber-900/60',
    rose:    'section-grad-rose ring-rose-200/60 dark:ring-rose-900/60',
  }[scoreTone]

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Match Score */}
      {matchScore != null && (
        <div className={`flex items-center gap-6 p-5 rounded-2xl ring-1 ring-inset ${scoreGrad}`}>
          <div className="relative w-24 h-24 flex-shrink-0">
            <svg className="w-24 h-24 -rotate-90" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" className="text-zinc-200 dark:text-zinc-800" strokeWidth="3.5"/>
              <circle cx="18" cy="18" r="15.9" fill="none" stroke={scoreColor}
                strokeWidth="3.5" strokeDasharray={`${matchScore} 100`} strokeLinecap="round" className="transition-all duration-700"/>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xl font-bold text-zinc-900 dark:text-zinc-50">{matchScore}%</span>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Match Score</p>
            <p className="font-bold text-zinc-900 dark:text-zinc-50 text-xl tracking-tight">
              {matchScore >= 70 ? 'Excellent match' : matchScore >= 50 ? 'Moderate match' : 'Low match'}
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              {matchScore >= 70 ? 'Strong fit for this role.'
               : matchScore >= 50 ? 'Manual review recommended.'
               : 'Consider alternative roles.'}
            </p>
          </div>
        </div>
      )}

      {/* Critical Mismatches */}
      {criticalMismatches.length > 0 && (
        <div className="rounded-2xl section-grad-rose ring-1 ring-inset ring-rose-200/60 dark:ring-rose-900/60 p-4">
          <h4 className="text-sm font-semibold text-rose-900 dark:text-rose-200 mb-3 flex items-center gap-2">
            <div className="rounded-lg bg-rose-100 dark:bg-rose-900/60 p-1.5 text-rose-700 dark:text-rose-200">
              <XCircle size={14} aria-hidden />
            </div>
            Critical Mismatches
          </h4>
          <div className="space-y-2">
            {criticalMismatches.map((m, i) => (
              <div key={i} className="flex items-start gap-2 p-3 bg-white/70 dark:bg-zinc-900/40 ring-1 ring-rose-200/70 dark:ring-rose-900/40 rounded-xl text-sm">
                <XCircle size={15} className="text-rose-500 mt-0.5 flex-shrink-0"/>
                <div>
                  {m.field && <span className="font-semibold text-rose-700 dark:text-rose-300">{m.field}: </span>}
                  <span className="text-rose-700 dark:text-rose-300">{m.reason || m.field || (typeof m === 'object' ? JSON.stringify(m) : String(m))}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Other Mismatches */}
      {otherMismatches.length > 0 && (
        <div className="rounded-2xl section-grad-amber ring-1 ring-inset ring-amber-200/60 dark:ring-amber-900/60 p-4">
          <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-3 flex items-center gap-2">
            <div className="rounded-lg bg-amber-100 dark:bg-amber-900/60 p-1.5 text-amber-700 dark:text-amber-200">
              <AlertCircle size={14} aria-hidden />
            </div>
            Other Mismatches
          </h4>
          <div className="space-y-2">
            {otherMismatches.map((m, i) => (
              <div key={i} className="flex items-start gap-2 p-2.5 bg-white/70 dark:bg-zinc-900/40 ring-1 ring-amber-200/70 dark:ring-amber-900/40 rounded-xl text-sm text-amber-800 dark:text-amber-200">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0"/>
                <span>{m.reason || m.field || (typeof m === 'object' ? JSON.stringify(m) : String(m))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Strengths */}
      {strengths.length > 0 && (
        <div className="rounded-2xl section-grad-emerald ring-1 ring-inset ring-emerald-200/60 dark:ring-emerald-900/60 p-4">
          <h4 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200 mb-3 flex items-center gap-2">
            <div className="rounded-lg bg-emerald-100 dark:bg-emerald-900/60 p-1.5 text-emerald-700 dark:text-emerald-200">
              <CheckCircle2 size={14} aria-hidden />
            </div>
            Strengths
          </h4>
          <div className="flex flex-wrap gap-2">
            {strengths.map((s, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/60 ring-1 ring-inset ring-emerald-200 dark:ring-emerald-900 px-3 py-1 text-xs font-semibold text-emerald-800 dark:text-emerald-200">
                <CheckCircle size={11} />
                {s.label || s}
              </span>
            ))}
          </div>
        </div>
      )}

      {!matchScore && criticalMismatches.length === 0 && strengths.length === 0 && (
        <EmptyState
          icon={Sparkles}
          tone="purple"
          title="No AI insights yet"
          description="Insights will appear here after auto-assign processing."
        />
      )}
    </div>
  )
}

function RemarksTab({ candidate }) {
  const [notes, setNotes] = useState(candidate.notes || '')
  const [selectedRemarkType, setSelectedRemarkType] = useState(null)
  const [customTags, setCustomTags] = useState(parseTags(candidate.tags).join(', '))
  const queryClient = useQueryClient()

  const updateMutation = useMutation({
    mutationFn: (data) => updateCandidate(candidate.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      toast.success('Remarks saved successfully')
    },
    onError: (error) => {
      toast.error('Failed to save remarks: ' + error.message)
    }
  })

  const handleSaveRemarks = () => {
    const tagsArray = customTags.split(',').map(t => t.trim()).filter(t => t)
    updateMutation.mutate({
      notes,
      tags: tagsArray,
      status: selectedRemarkType === 'future_pool' ? 'future_pool' : candidate.status
    })
  }

  return (
    <div className="space-y-6">
      {/* Remark Type Selection */}
      <div>
        <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">Quick Evaluation</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {REMARK_TYPES.map(type => {
            const Icon = type.icon
            const isSelected = selectedRemarkType === type.id
            const t = REMARK_TONES[type.tone] || REMARK_TONES.blue
            return (
              <button
                key={type.id}
                type="button"
                onClick={() => setSelectedRemarkType(isSelected ? null : type.id)}
                className={`p-3 rounded-2xl border-2 transition-all flex items-center gap-2.5 text-left ${isSelected ? t.sel : t.idle}`}
              >
                <span className={`w-8 h-8 rounded-xl flex items-center justify-center shadow-sm ${t.icon}`}>
                  <Icon size={15} />
                </span>
                <span className={`text-sm font-semibold ${isSelected ? t.label : 'text-zinc-700 dark:text-zinc-300'}`}>{type.label}</span>
                {isSelected && <CheckCircle2 size={14} className="ml-auto text-current shrink-0" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tags */}
      <div>
        <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
          <Tag size={14} className="inline mr-1" /> Skills & Tags (comma separated)
        </label>
        <input
          type="text"
          className="input w-full"
          placeholder="e.g., English, Security, Height OK, Experienced"
          value={customTags}
          onChange={(e) => setCustomTags(e.target.value)}
        />
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          Current tags will be visible in the candidate list for quick reference
        </p>
      </div>

      {/* Detailed Notes */}
      <div>
        <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
          <MessageSquare size={14} className="inline mr-1" /> Detailed Remarks
        </label>
        <textarea
          className="input w-full h-40 resize-none"
          placeholder="Add detailed notes about this candidate...

Examples:
- Interview observations
- Skill verification results  
- Document verification status
- Concerns or highlights
- Recommended for specific projects"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {/* Call log & remarks — shared with the conversation panel so the agent's
          call history follows the candidate everywhere (synced source of truth). */}
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <CallRemarksPanel candidateId={candidate.id} />
      </div>

      {/* Save Button */}
      <div className="flex justify-end gap-3 pt-4 border-t border-zinc-200 dark:border-zinc-800">
        <Button variant="secondary" onClick={() => {
          setNotes(candidate.notes || '')
          setCustomTags(parseTags(candidate.tags).join(', '))
          setSelectedRemarkType(null)
        }}>
          Reset
        </Button>
        <Button onClick={handleSaveRemarks} loading={updateMutation.isPending}>
          Save All Remarks
        </Button>
      </div>
    </div>
  )
}

function ApplicationsTab({ applications, candidate, jobs }) {
  const queryClient = useQueryClient()
  const [screeningAppId, setScreeningAppId] = useState(null)
  const [transferId, setTransferId] = useState(null)
  const [scheduleApp, setScheduleApp] = useState(null)
  const [assignJobId, setAssignJobId] = useState('')

  // A CV on file is the hard gate for moving New → Screening (matches the
  // backend has_cv check: cv_uploaded flag OR a CV-category document).
  const hasCv = candidate?.cv_uploaded === true
    || (candidate?.cvs || []).some((cv) => getDocumentCategory(cv) === 'cv')

  // Pull the WhatsApp-stated job interest from candidate metadata. The
  // chatbot writes this to candidates.metadata.job_interest_stated in
  // backend/src/routes/chatbot-intake.js. Display it prominently so the
  // recruiter can confirm the candidate's intent at a glance.
  const meta = typeof candidate?.metadata === 'string'
    ? (() => { try { return JSON.parse(candidate.metadata) } catch { return {} } })()
    : (candidate?.metadata || {})
  const statedJob = meta.job_interest_stated || ''
  const destinationCountry = meta.destination_country || ''

  // If the candidate already has an application matching the stated job
  // by title, hide the "assign" CTA. Otherwise surface the top 3 suggested
  // jobs (best matches by title fuzzy + same category) so the recruiter
  // can one-click create the application.
  const normalizedStated = String(statedJob).trim().toLowerCase()
  const appliedJobIds = new Set(applications.map(a => a.job_id))
  const activeJobs = (jobs || []).filter(j => j.status === 'active')
  const exactStatedAlreadyApplied = applications.some(a =>
    String(a.job_title || '').trim().toLowerCase() === normalizedStated
  )
  const suggestedJobs = !normalizedStated
    ? []
    : activeJobs
        .filter(j => !appliedJobIds.has(j.id))
        .map((j) => {
          const title = String(j.title || '').toLowerCase()
          let score = 0
          if (title === normalizedStated) score = 100
          else if (title.includes(normalizedStated) || normalizedStated.includes(title)) score = 75
          else {
            // Token overlap heuristic for cases like "Security Guard" vs "Security"
            const a = new Set(normalizedStated.split(/\s+/).filter(Boolean))
            const b = new Set(title.split(/\s+/).filter(Boolean))
            const overlap = [...a].filter(t => b.has(t)).length
            if (overlap > 0) score = 30 + overlap * 15
          }
          return { ...j, _score: score }
        })
        .filter(j => j._score > 0)
        .sort((x, y) => y._score - x._score)
        .slice(0, 3)

  const assignMutation = useMutation({
    mutationFn: () => createApplication({ candidate_id: candidate.id, job_id: assignJobId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['candidate', candidate.id] })
      toast.success('Candidate assigned to position')
      setAssignJobId('')
    },
    onError: (err) => toast.error(err?.response?.data?.error || 'Failed to assign'),
  })

  // New → Screening is a candidate-stage transition (not an application status
  // change): it sends the "application complete" WhatsApp and drops the
  // candidate into the job to await certification. Certification itself is now
  // an agent action in Applications/Projects.
  const screeningMutation = useMutation({
    mutationFn: (payload) => screenCandidate(candidate.id, payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['candidate', candidate.id] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setScreeningAppId(null)
      showNotificationToast(data?.notification, 'Moved to Screening')
    },
    onError: (error) => {
      const code = error?.response?.data?.code
      const msg = error?.response?.data?.error || error.message
      toast.error(code === 'screening_gate' ? msg : ('Failed to move to Screening: ' + msg))
    },
  })

  return (
    <div className="space-y-4">
      {/* WhatsApp-stated position card (always shown when chatbot captured one) */}
      {statedJob && (
        <div className="rounded-2xl border border-emerald-200 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/30 dark:to-zinc-900 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200 p-2">
              <MessageSquare size={18} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                Stated position from WhatsApp
              </p>
              <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 text-lg mt-0.5">{statedJob}</h4>
              {destinationCountry && (
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-0.5">
                  Destination: <span className="font-medium">{destinationCountry}</span>
                </p>
              )}

              {exactStatedAlreadyApplied ? (
                <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                  <CheckCircle2 size={14} /> Already applied — see the open application below.
                </p>
              ) : suggestedJobs.length === 0 ? (
                <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
                  No active job matches "{statedJob}" right now. You can still pick any open job via <strong>Assign Project</strong>.
                </p>
              ) : (
                <div className="mt-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-2">
                    Suggested open positions
                  </p>
                  <div className="space-y-2">
                    {suggestedJobs.map((j) => (
                      <div key={j.id} className="flex items-center gap-3 rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 p-3">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-zinc-900 dark:text-zinc-50 text-sm truncate">{j.title}</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{j.category}{j.location ? ` · ${j.location}` : ''}</p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => { setAssignJobId(j.id); assignMutation.mutate() }}
                          disabled={assignMutation.isPending}
                          className="gap-1"
                        >
                          <Plus size={14} /> Assign
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {applications.length === 0 ? (
        <div className="text-center py-8">
          <Briefcase className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600 mb-3" />
          <p className="font-semibold text-zinc-700 dark:text-zinc-300">No active applications</p>
          <p className="text-zinc-500 dark:text-zinc-400 mt-1 text-sm">
            {statedJob
              ? 'Use the suggested positions above or the Assign Project tab to allocate this candidate.'
              : 'Go to "Assign Project" tab to allocate this candidate to a job.'}
          </p>
        </div>
      ) : applications.map(app => (
        <div key={app.id} className="border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 hover:shadow-md transition-shadow">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 text-lg">{app.job_title}</h4>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 flex items-center gap-2">
                <Briefcase size={14} /> {app.job_category}
              </p>
            </div>
            <Badge status={app.status} />
          </div>

          <div className="flex items-center gap-6 text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            <span className="flex items-center gap-1">
              <Clock size={14} /> Applied: {new Date(app.applied_at).toLocaleDateString()}
            </span>
            {app.match_score && (
              <span className={`flex items-center gap-1 font-medium ${app.match_score >= 0.7 ? 'text-green-600' :
                app.match_score >= 0.5 ? 'text-amber-600' : 'text-red-600'
                }`}>
                <Star size={14} /> Match: {Math.round(app.match_score * 100)}%
              </span>
            )}
          </div>

          {(() => {
            const appStatus = normalizeStatus(app.status)
            // Entry = an application still in the screening bucket (legacy
            // applied/auto_assigned/reviewing all fold to 'screening').
            const isEntryState = appStatus === 'screening'
            const isCertifiedPlus = ['certified', 'interview_scheduled', 'hired'].includes(appStatus)
            return (
              <div className="flex gap-2 items-center border-t border-zinc-100 dark:border-zinc-800/60 pt-3">
                {/* New → Screening: the only stage action in CV Manager. Certify
                    (Screening → Certified) is done by agents in Applications. */}
                {normalizeStatus(candidate.status) === 'new' && isEntryState && (
                  <Button
                    size="sm"
                    className="gap-1"
                    disabled={!hasCv}
                    title={hasCv
                      ? 'Move to Screening and notify the candidate their application is complete'
                      : 'Upload a CV/resume before moving the candidate to Screening'}
                    onClick={() => setScreeningAppId(app.id)}
                  >
                    <CheckCircle size={16} /> Screening
                  </Button>
                )}
                {normalizeStatus(candidate.status) !== 'new' && (
                  <span className="text-sm text-zinc-500 dark:text-zinc-400 italic flex items-center gap-1">
                    {isCertifiedPlus && <CheckCircle2 size={14} className="text-green-500" />}
                    {appStatus === 'certified'
                      ? `Certified${app.certified_at ? ` on ${new Date(app.certified_at).toLocaleDateString()}` : ''}`
                      : isEntryState
                        ? 'In Screening — awaiting certification'
                        : `Status: ${getStatusLabel(app.status)}`}
                  </span>
                )}
                {/* Certified → let the agent book the interview right here
                    instead of jumping to the Job Candidates page. */}
                {appStatus === 'certified' && (
                  <Button
                    size="sm"
                    className="gap-1 bg-indigo-600 hover:bg-indigo-700 text-white"
                    onClick={() => setScheduleApp(app)}
                  >
                    <Calendar size={16} /> Schedule Interview
                  </Button>
                )}
                {isEntryState && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="gap-1"
                    onClick={() => setTransferId(app.id)}
                  >
                    <ArrowRight size={16} /> Transfer
                  </Button>
                )}
              </div>
            )
          })()}
        </div>
      ))}

      {screeningAppId && (
        <ScreeningModal
          jobTitle={applications.find((a) => a.id === screeningAppId)?.job_title || ''}
          onClose={() => setScreeningAppId(null)}
          onConfirm={(payload) => screeningMutation.mutate(payload)}
          loading={screeningMutation.isPending}
        />
      )}

      {transferId && (
        <TransferModal
          appId={transferId}
          onClose={() => setTransferId(null)}
        />
      )}

      {scheduleApp && (
        <ScheduleInterviewModal
          application={scheduleApp}
          candidate={candidate}
          onClose={() => setScheduleApp(null)}
          onSuccess={() => {
            setScheduleApp(null)
            queryClient.invalidateQueries({ queryKey: ['applications'] })
            queryClient.invalidateQueries({ queryKey: ['candidate', candidate.id] })
            queryClient.invalidateQueries({ queryKey: ['candidates'] })
            queryClient.invalidateQueries({ queryKey: ['interviews'] })
          }}
        />
      )}
    </div>
  )
}

// Single-candidate interview scheduler, surfaced in CV Manager once an
// application is Certified / Pre-Screened. Mirrors the Job Candidates modal:
// POST /api/interviews creates the record, flips the application to Scheduled,
// and sends the candidate a WhatsApp invitation.
function ScheduleInterviewModal({ application, candidate, onClose, onSuccess }) {
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [location, setLocation] = useState('')
  const [duration, setDuration] = useState(30)
  const [description, setDescription] = useState('')
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)

  const mutation = useMutation({
    mutationFn: async () => {
      if (!date || !time) throw new Error('Date and time are required')
      const channels = notifyWhatsApp ? ['whatsapp'] : []
      return apiClient.post('/api/interviews', {
        application_id: application.id,
        scheduled_datetime: `${date}T${time}`,
        location: location || null,
        duration_minutes: Number(duration) || 30,
        description: description.trim() || null,
        notify_channels: channels,
      }).then((res) => res.data)
    },
    onSuccess: (result) => {
      const notif = result?.notification
      if (notif && Array.isArray(notif.failed) && notif.failed.length > 0) {
        showNotificationToast(notif, 'Interview scheduled')
      } else {
        toast.success(`Interview scheduled for ${candidate.name || 'candidate'}`)
      }
      onSuccess()
    },
    onError: (err) => toast.error(err?.response?.data?.error || err.message || 'Failed to schedule interview'),
  })

  return (
    <Modal open onClose={onClose} title="Schedule Interview" size="md">
      <div className="space-y-4">
        <div className="rounded-xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900/50 p-4 flex items-start gap-3">
          <Calendar className="text-indigo-600 mt-0.5 flex-shrink-0" size={20} />
          <div>
            <h4 className="font-semibold text-indigo-800 dark:text-indigo-200">
              Interview for {candidate.name || 'Candidate'} — {application.job_title || 'Job'}
            </h4>
            <p className="text-sm text-indigo-700 dark:text-indigo-300 mt-1">
              Creates the interview record, moves the application to <strong>Scheduled</strong>, and sends the candidate a WhatsApp invitation with the date, time, and location.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="input w-full"
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 flex items-center gap-1">
            <MapPinned size={12} /> Location / Venue
          </label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="e.g., Head Office, Colombo 3"
            className="input w-full"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Duration (minutes)</label>
          <input
            type="number"
            min="10"
            max="240"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            className="input w-full"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Extra details for the candidate (optional)</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="e.g., Bring your portfolio. Ask for Mr. Perera at reception."
            className="input w-full resize-y"
          />
          {notifyWhatsApp && (
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">Included in the WhatsApp invitation.</p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={notifyWhatsApp}
            onChange={(e) => setNotifyWhatsApp(e.target.checked)}
            className="accent-primary-600"
          />
          Send interview invitation via WhatsApp
        </label>

        <div className="flex justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
            <Calendar size={16} />
            {mutation.isPending ? 'Scheduling…' : 'Schedule Interview'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// Lightweight modal for the New → Screening transition. It only confirms the
// move + collects an optional internal note and a "notify candidate" toggle —
// no interview scheduling (that belongs to certify/interview, done by agents).
function ScreeningModal({ jobTitle, onClose, onConfirm, loading }) {
  const [note, setNote] = useState('')
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)

  const handleSubmit = () => {
    onConfirm({
      note: note || undefined,
      notify_channels: notifyWhatsApp ? ['whatsapp'] : [],
    })
  }

  return (
    <Modal open={true} onClose={onClose} title="Move to Screening" size="sm">
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-amber-50 to-emerald-50 dark:from-amber-950/30 dark:to-emerald-950/30 rounded-lg border border-amber-200 dark:border-amber-900/40">
          <CheckCircle className="text-emerald-500 mt-0.5 flex-shrink-0" size={22} />
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            This confirms the candidate's details + CV are complete and moves them to{' '}
            <strong>Screening</strong>{jobTitle ? <> under <strong>{jobTitle}</strong></> : null}. They'll wait
            here until an agent certifies them.
          </p>
        </div>

        <label className={clsx(
          'flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all w-fit',
          notifyWhatsApp ? 'border-green-500 bg-green-50 dark:bg-green-950/30' : 'border-zinc-200 dark:border-zinc-800',
        )}>
          <input
            type="checkbox"
            checked={notifyWhatsApp}
            onChange={(e) => setNotifyWhatsApp(e.target.checked)}
          />
          <Smartphone size={18} className={notifyWhatsApp ? 'text-green-600' : 'text-zinc-400 dark:text-zinc-500'} />
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Send "application complete" WhatsApp
          </span>
        </label>

        <div>
          <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
            <MessageSquare size={14} className="inline mr-1" /> Internal note (optional)
          </label>
          <textarea
            className="input w-full h-20"
            placeholder="e.g. 'Documents verified, ready for the project handler'"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} loading={loading} className="gap-2">
            <Send size={16} /> Move to Screening
          </Button>
        </div>
      </div>
    </Modal>
  )
}


function TransferModal({ appId, onClose }) {
  const [targetJobId, setTargetJobId] = useState('')
  const [reason, setReason] = useState('')
  const queryClient = useQueryClient()

  const { data: jobsData } = useQuery({
    queryKey: ['jobs', { status: 'active' }],
    queryFn: () => getJobs({ status: 'active' })
  })
  const jobs = jobsData?.data || []

  const transferMutation = useMutation({
    mutationFn: (data) => transferApplication(appId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      onClose()
      toast.success('Application transferred successfully')
    }
  })

  return (
    <Modal open={true} onClose={onClose} title="Transfer to Different Project" size="sm">
      <div className="p-1">
        <div className="flex items-start gap-3 mb-4 p-3 bg-amber-50 rounded-lg">
          <ArrowRight className="text-amber-500 mt-0.5" size={20} />
          <p className="text-sm text-amber-800">
            Transferring will move this candidate to a different project. The original application will be marked as transferred.
          </p>
        </div>

        <div className="space-y-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Target Project</label>
            <select
              className="input w-full"
              value={targetJobId}
              onChange={(e) => setTargetJobId(e.target.value)}
            >
              <option value="">Select a project...</option>
              {jobs.map(job => (
                <option key={job.id} value={job.id}>
                  {job.title} ({job.category})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Transfer Reason</label>
            <textarea
              className="input w-full h-20"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you transferring this candidate?"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => transferMutation.mutate({ target_job_id: targetJobId, transfer_reason: reason })}
            loading={transferMutation.isPending}
            disabled={!targetJobId}
            className="gap-1"
          >
            <ArrowRight size={16} /> Transfer
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function AllocateTab({ candidate, existingApplications }) {
  const queryClient = useQueryClient()
  const appliedJobIds = (existingApplications || []).map(a => a.job_id)
  const [selectedJob, setSelectedJob] = useState(null)

  const allocateMutation = useMutation({
    mutationFn: (jobId) => createApplication({ candidate_id: candidate.id, job_id: jobId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['candidate', candidate.id] })
      toast.success('Candidate assigned to project!')
      setSelectedJob(null)
    },
    onError: (error) => {
      toast.error('Failed to assign: ' + (error?.message || 'unknown error'))
    }
  })

  const remaining = selectedJob
    ? Math.max(0, (selectedJob.positions_available || 0) - (selectedJob.positions_filled || 0))
    : 0
  const isFull = selectedJob && (selectedJob.positions_available || 0) > 0 && remaining === 0

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        Assign {candidate.name} to a Project
      </h3>

      {/* Cascading: pick a Project first, then a Job within it. */}
      <ProjectJobSelector excludeJobIds={appliedJobIds} onChange={setSelectedJob} />

      {selectedJob && (
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4 bg-white dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 truncate">{selectedJob.title}</h4>
              <div className="flex flex-wrap gap-2 mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {selectedJob.category && (
                  <span className="inline-flex items-center gap-1"><Briefcase size={11} /> {selectedJob.category}</span>
                )}
                {selectedJob.location && (
                  <span className="inline-flex items-center gap-1"><MapPin size={11} /> {selectedJob.location}</span>
                )}
              </div>
            </div>
            {(selectedJob.positions_available || 0) > 0 && (
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ring-1 ring-inset whitespace-nowrap shrink-0 ${
                remaining === 0
                  ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-200 ring-rose-200 dark:ring-rose-900'
                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200 ring-emerald-200 dark:ring-emerald-900'
              }`}>
                {remaining} open
              </span>
            )}
          </div>
          {selectedJob.description && (
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-2 line-clamp-2">{selectedJob.description}</p>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => selectedJob && allocateMutation.mutate(selectedJob.id)}
          loading={allocateMutation.isPending}
          disabled={!selectedJob || isFull}
          className="gap-1"
        >
          <CheckCircle size={14} /> Assign
        </Button>
      </div>
    </div>
  )
}
