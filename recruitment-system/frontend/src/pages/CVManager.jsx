import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  getCandidates,
  getCandidate,
  getJobs,
  getApplications,
  createApplication,
  updateApplication,
  transferApplication,
  updateCandidate,
  seedMockData,
  clearMockData,
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
  Trash2,
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
  Sparkles
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal, ConfirmModal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
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
  { id: 'excellent', label: 'Excellent Candidate', color: 'bg-green-500', icon: Star },
  { id: 'good', label: 'Good Fit', color: 'bg-blue-500', icon: CheckCircle2 },
  { id: 'potential', label: 'Has Potential', color: 'bg-amber-500', icon: Clock },
  { id: 'needs_review', label: 'Needs Review', color: 'bg-orange-500', icon: Eye },
  { id: 'not_qualified', label: 'Not Qualified', color: 'bg-red-500', icon: XCircle },
  { id: 'future_pool', label: 'Future Pool', color: 'bg-purple-500', icon: Database }
]

export default function CVManager() {
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

  const { data: candidatesData, isLoading: isLoadingCandidates, refetch } = useQuery({
    queryKey: ['candidates', { page, search, status: statusFilter, source: sourceFilter }],
    queryFn: () => getCandidates({ page, search, limit: 20, status: statusFilter || undefined, source: sourceFilter || undefined })
  })

  // Mutations for mock data
  const seedMutation = useMutation({
    mutationFn: seedMockData,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.success(`Mock data seeded: ${data.results.candidates.filter(c => c.status === 'created').length} candidates, ${data.results.jobs.filter(j => j.status === 'created').length} jobs`)
    },
    onError: (error) => {
      toast.error('Failed to seed mock data: ' + error.message)
    }
  })

  const clearMutation = useMutation({
    mutationFn: clearMockData,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      toast.success(`Cleared ${data.deleted_count} mock candidates`)
    },
    onError: (error) => {
      toast.error('Failed to clear mock data: ' + error.message)
    }
  })

  // Auto-assign all new candidates to matching jobs
  const autoAssignMutation = useMutation({
    mutationFn: () => batchAutoAssign(50, 'new'),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
      toast.custom((t) => (
        <div className={`${t.visible ? 'animate-enter' : 'animate-leave'} max-w-md w-full bg-white shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5`}>
          <div className="flex-1 w-0 p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0 pt-0.5">
                <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                  <Sparkles className="h-6 w-6 text-blue-600" />
                </div>
              </div>
              <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-gray-900">Auto-Assignment Complete!</p>
                <p className="mt-1 text-sm text-gray-500">
                  {data.assigned} assigned to jobs, {data.to_pool} moved to general pool
                </p>
              </div>
            </div>
          </div>
          <div className="flex border-l border-gray-200">
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
      <div className="mb-8 flex justify-between items-start">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">CV Manager</h1>
          <p className="text-gray-600 mt-1">Review, Remark, and Assign Candidates to Projects</p>
        </div>

        {/* Controls */}
        <div className="flex gap-2 flex-wrap justify-end">
          <Button
            variant="primary"
            size="sm"
            onClick={() => autoAssignMutation.mutate()}
            loading={autoAssignMutation.isPending}
            className="gap-1 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
          >
            <Sparkles size={16} />
            Auto-Assign All
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => seedMutation.mutate()}
            loading={seedMutation.isPending}
            className="gap-1"
          >
            <Database size={16} />
            Seed Mock
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => clearMutation.mutate()}
            loading={clearMutation.isPending}
            className="gap-1 text-red-600 hover:text-red-700"
          >
            <Trash2 size={16} />
            Clear
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => refetch()}
            className="gap-1"
          >
            <RefreshCw size={16} />
          </Button>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="card mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={20} />
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
          <div className="mt-4 pt-4 border-t border-gray-200 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
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
              <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
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
          <div className="py-12 text-center text-gray-500">
            <User className="mx-auto h-12 w-12 text-gray-300 mb-2" />
            <p className="font-medium">No candidates found</p>
            <p className="text-sm mt-1">Click "Seed Mock Data" to add sample candidates for testing</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Candidate</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Contact</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Skills</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Source</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {candidatesList.map((candidate) => (
                  <tr key={candidate.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white font-semibold">
                          {candidate.name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">{candidate.name}</p>
                          <p className="text-xs text-gray-500">ID: {candidate.id?.slice(0, 8)}...</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <p className="text-gray-900">{candidate.phone}</p>
                      <p className="text-sm text-gray-500">{candidate.email || 'No email'}</p>
                    </td>
                    <td className="py-4 px-4">
                      <div className="flex flex-wrap gap-1 max-w-[200px]">
                        {parseTags(candidate.tags || candidate.skills).slice(0, 3).map((skill, i) => (
                          <span key={i} className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">{skill}</span>
                        ))}
                        {parseTags(candidate.tags || candidate.skills).length > 3 && (
                          <span className="text-xs text-gray-500">+{parseTags(candidate.tags || candidate.skills).length - 3}</span>
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
          <div className="flex justify-between items-center px-4 py-3 border-t border-gray-200">
            <p className="text-sm text-gray-600">
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
          onClose={() => setSelectedCandidate(null)}
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
    gray: 'bg-gray-50 text-gray-700 border-gray-200'
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
    web: 'bg-gray-100 text-gray-700',
    manual: 'bg-gray-100 text-gray-700'
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
    { id: 'overview', label: 'Overview', icon: User },
    { id: 'ai_insights', label: 'AI Insights', icon: Sparkles },
    { id: 'remarks', label: 'Remarks & Notes', icon: MessageSquare },
    { id: 'applications', label: `Projects (${applications.length})`, icon: Briefcase },
    { id: 'allocate', label: 'Assign Project', icon: Building }
  ]

  return (
    <Modal open={true} onClose={onClose} title={`Review: ${candidate.name}`} size="lg">
      {/* Tab Navigation */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 overflow-x-auto">
        {tabs.map(tab => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap flex items-center gap-2 ${activeTab === tab.id
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          )
        })}
      </div>

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
          <ApplicationsTab applications={applications} />
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
    <div className="space-y-6">
      {/* Candidate Info Card */}
      <div className="bg-gradient-to-r from-primary-50 to-primary-100 rounded-lg p-6">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-2xl font-bold">
            {candidate.name?.charAt(0)?.toUpperCase() || '?'}
          </div>
          <div className="flex-1">
            <h3 className="text-xl font-semibold text-gray-900">{candidate.name}</h3>
            <div className="mt-2 flex flex-wrap gap-4 text-sm text-gray-600">
              <span className="flex items-center gap-1">📱 {candidate.phone}</span>
              <span className="flex items-center gap-1">📧 {candidate.email || 'No email'}</span>
              <span className="flex items-center gap-1">🌐 {candidate.preferred_language?.toUpperCase()}</span>
            </div>
          </div>
          <Badge status={candidate.status} />
        </div>
      </div>

      {/* Details Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <DetailCard label="Source" value={candidate.source} icon="📥" />
        <DetailCard label="Height" value={metadata.height_cm ? `${metadata.height_cm} cm` : 'N/A'} icon="📏" />
        <DetailCard label="Age" value={(candidate.age || metadata.age) ? `${candidate.age || metadata.age} years` : 'N/A'} icon="🎂" />
        <DetailCard label="Experience" value={(candidate.experience_years || metadata.experience_years) ? `${candidate.experience_years || metadata.experience_years} years` : 'N/A'} icon="💼" />
      </div>

      {/* Mismatches Alert */}
      {mismatches.length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
          <h4 className="flex items-center gap-2 text-orange-800 font-semibold mb-2">
            <AlertCircle size={18} /> Requirement Mismatches
          </h4>
          <ul className="list-disc list-inside text-sm text-orange-700 space-y-1">
            {mismatches.map((mismatch, idx) => (
              <li key={idx}>{mismatch}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Skills */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Skills & Tags</h4>
        <div className="flex flex-wrap gap-2">
          {parseTags(candidate.skills || candidate.tags).map((tag, i) => (
            <span key={i} className="px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-sm font-medium">
              {tag}
            </span>
          ))}
          {parseTags(candidate.skills || candidate.tags).length === 0 && (
            <span className="text-gray-500 text-sm">No skills/tags added yet</span>
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
            <div className="flex items-center justify-between px-4 py-2 border-b border-blue-100 bg-white">
              <span className="text-sm font-medium text-gray-700">CV Preview</span>
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
        <h4 className="text-sm font-semibold text-gray-700 mb-2">CV</h4>
        {cvDocuments && cvDocuments.length > 0 ? (
          <div className="space-y-3">
            {cvDocuments.map(cv => {
              // Resolve a proper HTTP URL; returns null for chatbot:// or missing URLs
              const rawUrl = getCvSourceUrl(cv)
              const resolvedUrl = resolveCvUrl(rawUrl)
              const isChatbotRecord = rawUrl.startsWith('chatbot://')
              const parsedInsights = safeParseJSON(cv.parsed_data)

              return (
                <div key={cv.id} className="border border-gray-200 rounded-lg bg-gray-50 overflow-hidden">
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="text-primary-500" size={24} />
                      <div>
                        <span className="text-sm font-medium text-gray-700">
                          {cv.file_name && !isChatbotRecord
                            ? cv.file_name
                            : isChatbotRecord
                              ? 'CV (processed via chatbot)'
                              : 'CV Document'}
                        </span>
                        <p className="text-xs text-gray-500">
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
                    <div className="px-4 py-3 bg-white border-t border-gray-100 text-sm">
                      <h5 className="font-semibold text-gray-900 mb-2 flex items-center gap-1">
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
        ) : (
          <div className="p-6 text-center border border-dashed border-gray-300 rounded-lg bg-gray-50">
            <FileText className="mx-auto h-8 w-8 text-gray-400 mb-2" />
            <p className="text-sm text-gray-500 font-medium">No CV uploaded</p>
          </div>
        )}
      </div>

      {/* Additional Documents */}
      <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2">Additional Documents</h4>
        {additionalDocuments && additionalDocuments.length > 0 ? (
          <div className="space-y-3">
            {additionalDocuments.map(doc => {
              const rawUrl = getCvSourceUrl(doc)
              const resolvedUrl = resolveCvUrl(rawUrl)
              const parsedInsights = safeParseJSON(doc.parsed_data)

              return (
                <div key={doc.id} className="border border-gray-200 rounded-lg bg-gray-50 overflow-hidden">
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <FileText className="text-primary-500" size={24} />
                      <div>
                        <span className="text-sm font-medium text-gray-700">
                          {doc.file_name || 'Additional Document'}
                        </span>
                        <p className="text-xs text-gray-500">
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
                    <div className="px-4 py-3 bg-white border-t border-gray-100 text-sm">
                      <h5 className="font-semibold text-gray-900 mb-2 flex items-center gap-1">
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
        ) : (
          <div className="p-6 text-center border border-dashed border-gray-300 rounded-lg bg-gray-50">
            <FileText className="mx-auto h-8 w-8 text-gray-400 mb-2" />
            <p className="text-sm text-gray-500 font-medium">No additional documents uploaded</p>
          </div>
        )}
      </div>

      {/* Quick Notes Preview */}
      {candidate.notes && (
        <div>
          <h4 className="text-sm font-semibold text-gray-700 mb-2">Quick Notes</h4>
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
            {candidate.notes}
          </div>
        </div>
      )}
    </div>
  )
}

function DetailCard({ label, value, icon }) {
  return (
    <div className="p-4 bg-gray-50 rounded-lg border border-gray-100">
      <div className="flex items-center gap-2 mb-1">
        <span>{icon}</span>
        <span className="text-xs text-gray-500 uppercase tracking-wide">{label}</span>
      </div>
      <p className="font-semibold text-gray-900">{value}</p>
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

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Match Score */}
      {matchScore != null && (
        <div className="flex items-center gap-6 p-5 bg-gradient-to-r from-blue-50 to-blue-100 rounded-xl">
          <div className="relative w-20 h-20 flex-shrink-0">
            <svg className="w-20 h-20 -rotate-90" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="#dbeafe" strokeWidth="3.8"/>
              <circle cx="18" cy="18" r="15.9" fill="none" stroke={matchScore >= 70 ? '#22c55e' : matchScore >= 50 ? '#f59e0b' : '#ef4444'}
                strokeWidth="3.8" strokeDasharray={`${matchScore} 100`} strokeLinecap="round"/>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-lg font-bold text-gray-900">{matchScore}%</span>
            </div>
          </div>
          <div>
            <p className="font-semibold text-gray-900 text-lg">Match Score</p>
            <p className="text-sm text-gray-600">
              {matchScore >= 70 ? 'Excellent match for this role'
               : matchScore >= 50 ? 'Moderate match — review required'
               : 'Low match — consider alternatives'}
            </p>
          </div>
        </div>
      )}

      {/* Critical Mismatches */}
      {criticalMismatches.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-1">
            <AlertCircle size={15}/> Critical Mismatches
          </h4>
          <div className="space-y-2">
            {criticalMismatches.map((m, i) => (
              <div key={i} className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-sm">
                <XCircle size={15} className="text-red-500 mt-0.5 flex-shrink-0"/>
                <div>
                  {m.field && <span className="font-medium text-red-700">{m.field}: </span>}
                  <span className="text-red-600">{m.reason || m.field || m}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Other Mismatches */}
      {otherMismatches.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-orange-700 mb-2 flex items-center gap-1">
            <AlertCircle size={15}/> Other Mismatches
          </h4>
          <div className="space-y-1">
            {otherMismatches.map((m, i) => (
              <div key={i} className="flex items-start gap-2 p-2.5 bg-orange-50 border border-orange-100 rounded-lg text-sm text-orange-700">
                <AlertCircle size={13} className="mt-0.5 flex-shrink-0"/>
                <span>{m.reason || m.field || m}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Strengths */}
      {strengths.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-green-700 mb-2 flex items-center gap-1">
            <CheckCircle2 size={15}/> Strengths
          </h4>
          <div className="space-y-1">
            {strengths.map((s, i) => (
              <div key={i} className="flex items-center gap-2 p-2.5 bg-green-50 border border-green-100 rounded-lg text-sm text-green-700">
                <CheckCircle size={13} className="flex-shrink-0"/>
                <span>{s.label || s}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!matchScore && criticalMismatches.length === 0 && strengths.length === 0 && (
        <div className="py-10 text-center text-gray-400">
          <Sparkles size={36} className="mx-auto mb-3 opacity-30"/>
          <p className="text-sm">AI insights will appear here after auto-assign processing</p>
        </div>
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
        <h4 className="text-sm font-semibold text-gray-700 mb-3">Quick Evaluation</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {REMARK_TYPES.map(type => {
            const Icon = type.icon
            const isSelected = selectedRemarkType === type.id
            return (
              <button
                key={type.id}
                onClick={() => setSelectedRemarkType(isSelected ? null : type.id)}
                className={`p-3 rounded-lg border-2 transition-all flex items-center gap-2 ${isSelected
                  ? 'border-primary-500 bg-primary-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
                  }`}
              >
                <span className={`w-8 h-8 rounded-full ${type.color} flex items-center justify-center`}>
                  <Icon size={16} className="text-white" />
                </span>
                <span className="text-sm font-medium text-gray-700">{type.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Tags */}
      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">
          <Tag size={14} className="inline mr-1" /> Skills & Tags (comma separated)
        </label>
        <input
          type="text"
          className="input w-full"
          placeholder="e.g., English, Security, Height OK, Experienced"
          value={customTags}
          onChange={(e) => setCustomTags(e.target.value)}
        />
        <p className="text-xs text-gray-500 mt-1">
          Current tags will be visible in the candidate list for quick reference
        </p>
      </div>

      {/* Detailed Notes */}
      <div>
        <label className="block text-sm font-semibold text-gray-700 mb-2">
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
      <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
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

function ApplicationsTab({ applications }) {
  const queryClient = useQueryClient()
  const [certifyId, setCertifyId] = useState(null)
  const [transferId, setTransferId] = useState(null)

  const certifyMutation = useMutation({
    mutationFn: ({ id, notes }) => updateApplication(id, { status: 'certified', certification_notes: notes }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      setCertifyId(null)
      // Show detailed notification success
      toast.custom((t) => (
        <div className={`${t.visible ? 'animate-enter' : 'animate-leave'} max-w-md w-full bg-white shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5`}>
          <div className="flex-1 w-0 p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0 pt-0.5">
                <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="h-6 w-6 text-green-600" />
                </div>
              </div>
              <div className="ml-3 flex-1">
                <p className="text-sm font-medium text-gray-900">Candidate Certified!</p>
                <p className="mt-1 text-sm text-gray-500">
                  {data.notification_queued ? '📱 WhatsApp notification sent' : 'Status updated successfully'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex border-l border-gray-200">
            <button
              onClick={() => toast.dismiss(t.id)}
              className="w-full border border-transparent rounded-none rounded-r-lg p-4 flex items-center justify-center text-sm font-medium text-primary-600 hover:text-primary-500"
            >
              Close
            </button>
          </div>
        </div>
      ), { duration: 4000 })
    },
    onError: (error) => {
      toast.error('Failed to certify: ' + error.message)
    }
  })

  if (applications.length === 0) {
    return (
      <div className="text-center py-12">
        <Briefcase className="mx-auto h-16 w-16 text-gray-300 mb-4" />
        <p className="font-semibold text-gray-700">No Project Assignments</p>
        <p className="text-gray-500 mt-1">Go to "Assign Project" tab to allocate this candidate to a job</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {applications.map(app => (
        <div key={app.id} className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h4 className="font-semibold text-gray-900 text-lg">{app.job_title}</h4>
              <p className="text-sm text-gray-500 flex items-center gap-2">
                <Briefcase size={14} /> {app.job_category}
              </p>
            </div>
            <Badge status={app.status} />
          </div>

          <div className="flex items-center gap-6 text-sm text-gray-600 mb-4">
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

          <div className="flex gap-2 border-t border-gray-100 pt-3">
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
              <span className="text-sm text-gray-500 italic flex items-center gap-1">
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
          onConfirm={(notes) => certifyMutation.mutate({ id: certifyId, notes })}
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
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            <Bell size={14} className="inline mr-1" /> Notification Channels
          </label>
          <div className="flex gap-3">
            <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifyWhatsApp ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:border-gray-300'
              }`}>
              <input
                type="checkbox"
                checked={notifyWhatsApp}
                onChange={(e) => setNotifyWhatsApp(e.target.checked)}
                className="sr-only"
              />
              <Smartphone size={18} className={notifyWhatsApp ? 'text-green-600' : 'text-gray-400'} />
              <span className={`text-sm font-medium ${notifyWhatsApp ? 'text-green-700' : 'text-gray-600'}`}>
                WhatsApp
              </span>
              {notifyWhatsApp && <CheckCircle2 size={16} className="text-green-500 ml-auto" />}
            </label>

            <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifyEmail ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
              }`}>
              <input
                type="checkbox"
                checked={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.checked)}
                className="sr-only"
              />
              <Send size={18} className={notifyEmail ? 'text-blue-600' : 'text-gray-400'} />
              <span className={`text-sm font-medium ${notifyEmail ? 'text-blue-700' : 'text-gray-600'}`}>
                Email
              </span>
              {notifyEmail && <CheckCircle2 size={16} className="text-blue-500 ml-auto" />}
            </label>
          </div>
        </div>

        {/* Certification Remarks */}
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
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
          <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare size={14} className="text-gray-500" />
              <span className="text-xs font-medium text-gray-500 uppercase">Message Preview</span>
            </div>
            <div className="text-sm text-gray-700 whitespace-pre-line bg-white p-3 rounded border border-gray-100">
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
        <div className="flex justify-end gap-2 pt-4 border-t border-gray-200">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => onConfirm(notes)}
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Target Project</label>
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
            <label className="block text-sm font-medium text-gray-700 mb-1">Transfer Reason</label>
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
        <h3 className="text-sm font-semibold text-gray-700">
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
        <div className="text-center py-12 bg-gray-50 rounded-lg">
          <Building className="mx-auto h-12 w-12 text-gray-300 mb-3" />
          <p className="text-gray-500">
            {availableJobs.length === 0
              ? 'Candidate is already assigned to all available projects'
              : 'No projects match the selected category'}
          </p>
        </div>
      ) : (
        <div className="space-y-3 max-h-[350px] overflow-y-auto pr-2">
          {filteredJobs.map(job => (
            <div
              key={job.id}
              className="border border-gray-200 rounded-lg p-4 hover:border-primary-300 hover:shadow-md transition-all bg-white"
            >
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <h4 className="font-semibold text-gray-900">{job.title}</h4>
                  <div className="flex flex-wrap gap-3 mt-1 text-sm text-gray-500">
                    <span className="flex items-center gap-1">
                      <Briefcase size={14} /> {job.category}
                    </span>
                    {job.location && (
                      <span className="flex items-center gap-1">
                        <MapPin size={14} /> {job.location}
                      </span>
                    )}
                    {job.salary_range && (
                      <span className="flex items-center gap-1">
                        <DollarSign size={14} /> {job.salary_range}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">
                  {job.positions_available - (job.positions_filled || 0)} positions
                </span>
              </div>

              {job.description && (
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">{job.description}</p>
              )}

              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={() => allocateMutation.mutate(job.id)}
                  loading={allocateMutation.isPending}
                  className="gap-1"
                >
                  <CheckCircle size={14} /> Assign to Project
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
