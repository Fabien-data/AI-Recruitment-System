import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { showNotificationToast } from '../utils/notificationToast'
import {
  getCandidates,
  getCandidate,
  getJobs,
  getApplications,
  createApplication,
  updateApplication,
  transferApplication,
  updateCandidate,
  batchAutoAssign
} from '../api'
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
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal, ConfirmModal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { PageHeader } from '../components/ui/PageHeader'
import { Tabs } from '../components/ui/Tabs'
import { EmptyState } from '../components/ui/EmptyState'
import { FileSearch } from 'lucide-react'
import toast from 'react-hot-toast'

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

function resolveCvUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  if (rawUrl.startsWith('chatbot://')) return null
  if (/^https?:\/\//i.test(rawUrl)) return rawUrl
  const apiBase = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
  if (!apiBase) return rawUrl
  return rawUrl.startsWith('/') ? `${apiBase}${rawUrl}` : `${apiBase}/${rawUrl}`
}

function getCvSourceUrl(cv) {
  return cv?.resolved_file_url || cv?.file_url || ''
}

function getDocumentCategory(cv) {
  if (cv?.document_category) return cv.document_category
  try {
    const parsed = typeof cv?.parsed_data === 'string' ? JSON.parse(cv.parsed_data) : cv?.parsed_data
    return parsed?.__document_category === 'additional' ? 'additional' : 'cv'
  } catch {
    return 'cv'
  }
}

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
  const [sourceFilter, setSourceFilter] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  const queryClient = useQueryClient()

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

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

  const { data: candidatesData, isLoading: isLoadingCandidates, refetch } = useQuery({
    queryKey: ['candidates', { page, search, status: statusFilter, source: sourceFilter }],
    queryFn: () => getCandidates({ page, search, limit: 20, status: statusFilter || undefined, source: sourceFilter || undefined })
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
            <Button
              variant="primary"
              size="sm"
              onClick={() => autoAssignMutation.mutate()}
              loading={autoAssignMutation.isPending}
            >
              <Sparkles size={16} />
              Auto-Assign All
            </Button>
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
                <option value="interview">Interview</option>
                <option value="hired">Hired</option>
                <option value="rejected">Rejected</option>
                <option value="future_pool">Future Pool</option>
              </select>
            </div>
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
            <div className="flex items-end">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setStatusFilter(''); setSourceFilter(''); }}
              >
                Clear Filters
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <StatCard label="Total CVs" value={pagination?.total || 0} color="blue" />
        <StatCard label="New" value={candidatesList.filter(c => c.status === 'new').length} color="green" />
        <StatCard label="Screening" value={candidatesList.filter(c => c.status === 'screening').length} color="amber" />
        <StatCard label="Interview" value={candidatesList.filter(c => c.status === 'interview').length} color="purple" />
        <StatCard label="Future Pool" value={candidatesList.filter(c => c.status === 'future_pool').length} color="gray" />
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

function CVReviewModal({ candidate, onClose }) {
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

  const toggleCV = (id) => {
    setExpandedCVs(prev => ({ ...prev, [id]: !prev[id] }))
  }

  const metadata = typeof candidate.metadata === 'string'
    ? JSON.parse(candidate.metadata || '{}')
    : (candidate.metadata || {})

  const mismatches = metadata.mismatches || []
  const cvDocuments = (candidate.cvs || []).filter(cv => getDocumentCategory(cv) === 'cv')
  const additionalDocuments = (candidate.cvs || []).filter(cv => getDocumentCategory(cv) === 'additional')

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
          <Badge status={candidate.status} />
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <DetailCard label="Source"     value={candidate.source} icon={Database}    tone="indigo" />
        <DetailCard label="Height"     value={metadata.height_cm ? `${metadata.height_cm} cm` : 'N/A'} icon={Star} tone="emerald" />
        <DetailCard label="Age"        value={(candidate.age || metadata.age) ? `${candidate.age || metadata.age} years` : 'N/A'} icon={User} tone="amber" />
        <DetailCard label="Experience" value={(candidate.experience_years || metadata.experience_years) ? `${candidate.experience_years || metadata.experience_years} years` : 'N/A'} icon={Briefcase} tone="purple" />
      </div>

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
              <li key={idx}>{mismatch}</li>
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

      {/* Primary CV Quick-View — shows the latest uploaded CV if available */}
      {(() => {
        const primaryCv = cvDocuments?.[0]
        if (!primaryCv) return null
        const rawUrl = getCvSourceUrl(primaryCv)
        const resolvedUrl = resolveCvUrl(rawUrl)
        if (!resolvedUrl) return null
        const isImage = /\.(png|jpe?g|webp|gif)$/i.test(rawUrl) || primaryCv.file_type === 'image'
        return (
          <div className="border border-blue-100 rounded-xl overflow-hidden bg-blue-50">
            <div className="flex items-center justify-between px-4 py-2 border-b border-blue-100 bg-white dark:bg-zinc-900">
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">CV Preview</span>
              <a
                href={resolvedUrl}
                download={`CV_${candidate.name}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs btn btn-primary py-1 px-3"
              >
                <Download size={13} /> Download CV
              </a>
            </div>
            <div className="h-96">
              {isImage
                ? <img src={resolvedUrl} alt="CV" className="w-full h-full object-contain" />
                : <iframe src={`${resolvedUrl}#toolbar=0`} className="w-full h-full" title="CV Preview" />
              }
            </div>
          </div>
        )
      })()}

      {/* CV Preview */}
      <div>
        <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">CV</h4>
        {cvDocuments && cvDocuments.length > 0 ? (
          <div className="space-y-3">
            {cvDocuments.map(cv => {
              // Resolve a proper HTTP URL; returns null for chatbot:// or missing URLs
              const rawUrl = getCvSourceUrl(cv)
              const resolvedUrl = resolveCvUrl(rawUrl)
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
                      {resolvedUrl && (
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
              const resolvedUrl = resolveCvUrl(rawUrl)
              const parsedInsights = safeParseJSON(doc.parsed_data)

              return (
                <div key={doc.id} className="border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 overflow-hidden">
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="text-primary-500" size={24} />
                      <div>
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                          {doc.file_name || 'Additional Document'}
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
                      {resolvedUrl && (
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
                  <span className="text-rose-700 dark:text-rose-300">{m.reason || m.field || m}</span>
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
                <span>{m.reason || m.field || m}</span>
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
  const [certifyId, setCertifyId] = useState(null)
  const [transferId, setTransferId] = useState(null)
  const [assignJobId, setAssignJobId] = useState('')

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

  const certifyMutation = useMutation({
    mutationFn: ({ id, payload }) => updateApplication(id, payload),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      setCertifyId(null)
      showNotificationToast(data?.notification, 'Candidate certified')
    },
    onError: (error) => {
      toast.error('Failed to certify: ' + error.message)
    }
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

          <div className="flex gap-2 border-t border-zinc-100 dark:border-zinc-800/60 pt-3">
            {['applied', 'new', 'reviewing'].includes(app.status) ? (
              <>
                <Button
                  size="sm"
                  className="gap-1"
                  onClick={() => setCertifyId(app.id)}
                >
                  <CheckCircle size={16} /> Certify
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="gap-1"
                  onClick={() => setTransferId(app.id)}
                >
                  <ArrowRight size={16} /> Transfer
                </Button>
              </>
            ) : (
              <span className="text-sm text-zinc-500 dark:text-zinc-400 italic flex items-center gap-1">
                {app.status === 'certified' && <CheckCircle2 size={14} className="text-green-500" />}
                {app.status === 'certified'
                  ? `Certified on ${new Date(app.certified_at).toLocaleDateString()}`
                  : `Status: ${app.status}`}
              </span>
            )}
          </div>
        </div>
      ))}

      {certifyId && (
        <CertifyModal
          appId={certifyId}
          onClose={() => setCertifyId(null)}
          onConfirm={(payload) => certifyMutation.mutate({ id: certifyId, payload })}
          loading={certifyMutation.isPending}
        />
      )}

      {transferId && (
        <TransferModal
          appId={transferId}
          onClose={() => setTransferId(null)}
        />
      )}
    </div>
  )
}

function CertifyModal({ appId, onClose, onConfirm, loading }) {
  const [notes, setNotes] = useState('')
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)
  const [notifyEmail, setNotifyEmail] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [interviewDate, setInterviewDate] = useState('')
  const [interviewTime, setInterviewTime] = useState('')
  const [interviewLocation, setInterviewLocation] = useState('')

  const notifyChannels = [
    notifyWhatsApp ? 'whatsapp' : null,
    notifyEmail ? 'email' : null
  ].filter(Boolean)

  const handleSubmit = () => {
    if (!interviewDate || !interviewTime) {
      toast.error('Please select interview date and time before certifying')
      return
    }

    const localDateTime = new Date(`${interviewDate}T${interviewTime}`)
    if (Number.isNaN(localDateTime.getTime())) {
      toast.error('Invalid interview date/time')
      return
    }

    onConfirm({
      status: 'certified',
      certification_notes: notes,
      prescreening_datetime: localDateTime.toISOString(),
      prescreening_location: interviewLocation || null,
      notify_channels: notifyChannels
    })
  }

  return (
    <Modal open={true} onClose={onClose} title="Certify Candidate" size="md">
      <div className="space-y-4">
        {/* Success Message */}
        <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg border border-green-200">
          <CheckCircle className="text-green-500 mt-0.5 flex-shrink-0" size={24} />
          <div>
            <h4 className="font-semibold text-green-800">Certify & Notify Candidate</h4>
            <p className="text-sm text-green-700 mt-1">
              This will mark the candidate as <strong>certified</strong> and automatically send them a congratulatory notification.
            </p>
          </div>
        </div>

        {/* Notification Channels */}
        <div>
          <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
            <Bell size={14} className="inline mr-1" /> Notification Channels
          </label>
          <div className="flex gap-3">
            <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifyWhatsApp ? 'border-green-500 bg-green-50' : 'border-zinc-200 dark:border-zinc-800 hover:border-gray-300'
              }`}>
              <input
                type="checkbox"
                checked={notifyWhatsApp}
                onChange={(e) => setNotifyWhatsApp(e.target.checked)}
                className="sr-only"
              />
              <Smartphone size={18} className={notifyWhatsApp ? 'text-green-600' : 'text-zinc-400 dark:text-zinc-500'} />
              <span className={`text-sm font-medium ${notifyWhatsApp ? 'text-green-700' : 'text-zinc-600 dark:text-zinc-400'}`}>
                WhatsApp
              </span>
              {notifyWhatsApp && <CheckCircle2 size={16} className="text-green-500 ml-auto" />}
            </label>

            <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifyEmail ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 dark:border-zinc-800 hover:border-gray-300'
              }`}>
              <input
                type="checkbox"
                checked={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.checked)}
                className="sr-only"
              />
              <Send size={18} className={notifyEmail ? 'text-blue-600' : 'text-zinc-400 dark:text-zinc-500'} />
              <span className={`text-sm font-medium ${notifyEmail ? 'text-blue-700' : 'text-zinc-600 dark:text-zinc-400'}`}>
                Email
              </span>
              {notifyEmail && <CheckCircle2 size={16} className="text-blue-500 ml-auto" />}
            </label>
          </div>
        </div>

        {/* Certification Remarks */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
              <Clock size={14} className="inline mr-1" /> Interview Date
            </label>
            <input
              type="date"
              className="input w-full"
              value={interviewDate}
              onChange={(e) => setInterviewDate(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
              <Clock size={14} className="inline mr-1" /> Interview Time
            </label>
            <input
              type="time"
              className="input w-full"
              value={interviewTime}
              onChange={(e) => setInterviewTime(e.target.value)}
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
            <MapPin size={14} className="inline mr-1" /> Interview Location
          </label>
          <input
            type="text"
            className="input w-full"
            placeholder="Office / venue / online link"
            value={interviewLocation}
            onChange={(e) => setInterviewLocation(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
            <MessageSquare size={14} className="inline mr-1" /> Certification Remarks (Internal)
          </label>
          <textarea
            className="input w-full h-20"
            placeholder="Enter internal notes (e.g., 'Documents verified, height confirmed')"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {/* Message Preview */}
        <button
          type="button"
          onClick={() => setShowPreview(!showPreview)}
          className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1"
        >
          <Eye size={14} /> {showPreview ? 'Hide' : 'Preview'} notification message
        </button>

        {showPreview && (
          <div className="p-4 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare size={14} className="text-zinc-500 dark:text-zinc-400" />
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase">Message Preview</span>
            </div>
            <div className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-line bg-white dark:bg-zinc-900 p-3 rounded border border-zinc-100 dark:border-zinc-800/60">
              🎉 Dear [Candidate Name],
              {'\n\n'}
              Congratulations! You have successfully passed our pre-screening process for the position.
              {'\n\n'}
              📋 Next Steps:
              {'\n'}1. Our team will contact you shortly to schedule an interview
              {'\n'}2. Please keep your documents ready
              {'\n'}3. Make sure your phone is reachable
              {'\n\n'}
              Best regards,
              {'\n'}Dewan Recruitment Team
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            loading={loading}
            className="gap-2"
            disabled={!notifyWhatsApp && !notifyEmail}
          >
            <Send size={16} /> Certify & Send Notification
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

function AllocateTab({ candidate, jobs, existingApplications }) {
  const queryClient = useQueryClient()
  const appliedJobIds = existingApplications.map(a => a.job_id)
  const [selectedCategory, setSelectedCategory] = useState('')

  const allocateMutation = useMutation({
    mutationFn: (jobId) => createApplication({ candidate_id: candidate.id, job_id: jobId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      toast.success('Candidate assigned to project!')
    },
    onError: (error) => {
      toast.error('Failed to assign: ' + error.message)
    }
  })

  const availableJobs = jobs.filter(job => !appliedJobIds.includes(job.id))
  const filteredJobs = selectedCategory
    ? availableJobs.filter(job => job.category === selectedCategory)
    : availableJobs

  const categories = [...new Set(jobs.map(j => j.category))]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Assign {candidate.name} to a Project
        </h3>
        <select
          className="input text-sm py-1"
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
        >
          <option value="">All Categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
      </div>

      {filteredJobs.length === 0 ? (
        <EmptyState
          icon={Building}
          tone="indigo"
          title={availableJobs.length === 0 ? 'Already assigned everywhere' : 'No projects in this category'}
          description={availableJobs.length === 0
            ? 'This candidate is already linked to every available project.'
            : 'Try a different category or clear the filter.'}
          compact
        />
      ) : (
        <div className="space-y-3 max-h-[420px] overflow-y-auto scrollbar-thin pr-2 -mr-2">
          {filteredJobs.map(job => {
            const remaining = Math.max(0, (job.positions_available || 0) - (job.positions_filled || 0))
            const total = job.positions_available || 0
            const filledPct = total > 0 ? Math.min(100, Math.round(((job.positions_filled || 0) / total) * 100)) : 0
            const remainingTone = remaining === 0 ? 'rose' : remaining <= 2 ? 'amber' : 'emerald'
            const remainingClass = {
              emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200 ring-emerald-200 dark:ring-emerald-900',
              amber:   'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200 ring-amber-200 dark:ring-amber-900',
              rose:    'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-200 ring-rose-200 dark:ring-rose-900',
            }[remainingTone]
            return (
              <div
                key={job.id}
                className="relative rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4 transition-all hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md bg-white dark:bg-zinc-900 before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-1 before:rounded-r before:bg-gradient-to-b before:from-indigo-500 before:to-purple-500"
              >
                <div className="flex justify-between items-start gap-3 mb-3 pl-2">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold shrink-0 ring-2 ring-white dark:ring-zinc-900 shadow-sm">
                      {job.title?.charAt(0)?.toUpperCase() || 'J'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 truncate">{job.title}</h4>
                      <div className="flex flex-wrap gap-2 mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {job.category && (
                          <span className="inline-flex items-center gap-1">
                            <Briefcase size={11} /> {job.category}
                          </span>
                        )}
                        {job.location && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin size={11} /> {job.location}
                          </span>
                        )}
                        {job.salary_range && (
                          <span className="inline-flex items-center gap-1">
                            <DollarSign size={11} /> {job.salary_range}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <span className={`text-xs font-semibold px-2 py-1 rounded-full ring-1 ring-inset whitespace-nowrap shrink-0 ${remainingClass}`}>
                    {remaining} open
                  </span>
                </div>

                {/* Positions progress */}
                <div className="pl-2 mb-3">
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Positions filled</span>
                    <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{job.positions_filled || 0} / {total}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/70 dark:bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-500"
                      style={{ width: `${filledPct}%` }}
                    />
                  </div>
                </div>

                {job.description && (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3 line-clamp-2 pl-2">{job.description}</p>
                )}

                <div className="flex justify-end pl-2">
                  <Button
                    size="sm"
                    onClick={() => allocateMutation.mutate(job.id)}
                    loading={allocateMutation.isPending}
                    disabled={remaining === 0}
                    className="gap-1"
                  >
                    <CheckCircle size={14} /> Assign
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
