import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
    Database,
    Search,
    User,
    Phone,
    Mail,
    FileText,
    Eye,
    Download,
    RefreshCw,
    ArrowRight,
    Briefcase,
    Filter,
    ChevronDown,
    Calendar,
    Sparkles,
    CheckCircle
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Modal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { apiClient, getJobs, createApplication } from '../api'
import toast from 'react-hot-toast'

// API function for general pool
const getGeneralPool = (params) =>
    apiClient.get('/api/auto-assign/pool', { params }).then(res => res.data)

const autoAssignCandidate = (candidateId, threshold) =>
    apiClient.post(`/api/auto-assign/candidate/${candidateId}`, { threshold }).then(res => res.data)

export default function GeneralPool() {
    const [page, setPage] = useState(1)
    const [searchInput, setSearchInput] = useState('')
    const [search, setSearch] = useState('')
    const [selectedCandidate, setSelectedCandidate] = useState(null)
    const queryClient = useQueryClient()

    useEffect(() => {
        const t = setTimeout(() => setSearch(searchInput), 300)
        return () => clearTimeout(t)
    }, [searchInput])

    const { data, isLoading, refetch } = useQuery({
        queryKey: ['general-pool', { page, search }],
        queryFn: () => getGeneralPool({ page, limit: 20 })
    })

    const candidates = data?.data || []
    const pagination = data?.pagination

    // Filter locally if search is active
    const filteredCandidates = search
        ? candidates.filter(c =>
            c.name?.toLowerCase().includes(search.toLowerCase()) ||
            c.phone?.includes(search) ||
            c.email?.toLowerCase().includes(search.toLowerCase())
        )
        : candidates

    return (
        <div className="p-6 lg:p-8 animate-fade-in">
            <PageHeader
                icon={Database}
                tone="blue"
                title="General Pool"
                subtitle="Candidates for future job opportunities"
                actions={
                    <Button variant="secondary" onClick={() => refetch()}>
                        <RefreshCw size={16} />
                        Refresh
                    </Button>
                }
            />

            {/* Info Banner */}
            <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-4 mb-6">
                <div className="flex items-start gap-3">
                    <Sparkles className="text-purple-500 mt-0.5" size={20} />
                    <div>
                        <h3 className="font-semibold text-purple-900">About General Pool</h3>
                        <p className="text-sm text-purple-700 mt-1">
                            These candidates didn't match any active job positions during the automatic assessment.
                            They are stored here for future opportunities. When new jobs are created, you can
                            re-evaluate these candidates or manually assign them.
                        </p>
                    </div>
                </div>
            </div>

            {/* Search */}
            <div className="card mb-6">
                <div className="relative max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" size={20} />
                    <input
                        type="text"
                        placeholder="Search candidates by name, phone, or email..."
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        className="input pl-10 w-full"
                    />
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="card py-4 px-6 bg-purple-50 border border-purple-200">
                    <p className="text-3xl font-bold text-purple-700">{pagination?.total || 0}</p>
                    <p className="text-sm text-purple-600">Total in Pool</p>
                </div>
                <div className="card py-4 px-6 bg-blue-50 border border-blue-200">
                    <p className="text-3xl font-bold text-blue-700">
                        {candidates.filter(c => {
                            const date = new Date(c.updated_at || c.created_at)
                            const week = new Date()
                            week.setDate(week.getDate() - 7)
                            return date > week
                        }).length}
                    </p>
                    <p className="text-sm text-blue-600">Added This Week</p>
                </div>
                <div className="card py-4 px-6 bg-green-50 border border-green-200">
                    <p className="text-3xl font-bold text-green-700">
                        {candidates.filter(c => (c.tags || []).length > 0).length}
                    </p>
                    <p className="text-sm text-green-600">With Skills</p>
                </div>
            </div>

            {/* Candidates List */}
            <div className="card overflow-hidden">
                <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60">
                    <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
                        Pool Candidates ({filteredCandidates.length})
                    </h2>
                </div>

                {isLoading ? (
                    <TableSkeleton rows={8} cols={5} />
                ) : filteredCandidates.length === 0 ? (
                    <div className="py-12 text-center text-zinc-500 dark:text-zinc-400">
                        <Database className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600 mb-2" />
                        <p className="font-medium">No candidates in pool</p>
                        <p className="text-sm mt-1">
                            {candidates.length === 0
                                ? 'All candidates have been matched to jobs'
                                : 'No candidates match your search'}
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="overflow-x-auto">
                            <table className="w-full">
                                <thead>
                                    <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60">
                                        <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Candidate</th>
                                        <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Contact</th>
                                        <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Skills</th>
                                        <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Added</th>
                                        <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredCandidates.map((candidate) => (
                                        <tr key={candidate.id} className="border-b border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                                            <td className="py-4 px-4">
                                                <div className="flex items-center gap-3">
                                                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white font-semibold">
                                                        {candidate.name?.charAt(0)?.toUpperCase() || '?'}
                                                    </div>
                                                    <div>
                                                        <p className="font-medium text-zinc-900 dark:text-zinc-50">{candidate.name}</p>
                                                        <p className="text-xs text-zinc-500 dark:text-zinc-400">via {candidate.source}</p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="py-4 px-4">
                                                <p className="text-zinc-900 dark:text-zinc-50 flex items-center gap-1">
                                                    <Phone size={12} className="text-zinc-400 dark:text-zinc-500" />
                                                    {candidate.phone}
                                                </p>
                                                {candidate.email && (
                                                    <p className="text-sm text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                                                        <Mail size={12} className="text-zinc-400 dark:text-zinc-500" />
                                                        {candidate.email}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="py-4 px-4">
                                                <div className="flex flex-wrap gap-1 max-w-[200px]">
                                                    {(candidate.tags || []).slice(0, 3).map((skill, i) => (
                                                        <span key={i} className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
                                                            {skill}
                                                        </span>
                                                    ))}
                                                    {(candidate.tags || []).length === 0 && (
                                                        <span className="text-xs text-zinc-400 dark:text-zinc-500 italic">No skills tagged</span>
                                                    )}
                                                </div>
                                                {candidate.remarks && (
                                                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 truncate max-w-[200px]" title={candidate.remarks}>
                                                        📝 {candidate.remarks}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="py-4 px-4">
                                                <span className="text-sm text-zinc-600 dark:text-zinc-400 flex items-center gap-1">
                                                    <Calendar size={12} />
                                                    {new Date(candidate.updated_at || candidate.created_at).toLocaleDateString()}
                                                </span>
                                            </td>
                                            <td className="py-4 px-4">
                                                <div className="flex gap-2">
                                                    <Button
                                                        variant="secondary"
                                                        size="sm"
                                                        onClick={() => setSelectedCandidate(candidate)}
                                                        className="gap-1"
                                                    >
                                                        <Eye size={14} />
                                                        View
                                                    </Button>
                                                    <Button
                                                        variant="primary"
                                                        size="sm"
                                                        onClick={() => setSelectedCandidate({ ...candidate, showAssign: true })}
                                                        className="gap-1"
                                                    >
                                                        <ArrowRight size={14} />
                                                        Assign
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Pagination */}
                        {pagination && pagination.totalPages > 1 && (
                            <div className="flex justify-between items-center px-4 py-3 border-t border-zinc-200 dark:border-zinc-800">
                                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                    Showing {((page - 1) * 20) + 1} to {Math.min(page * 20, pagination.total)} of {pagination.total}
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
                    </>
                )}
            </div>

            {/* Candidate Modal */}
            {selectedCandidate && (
                <PoolCandidateModal
                    candidate={selectedCandidate}
                    showAssignTab={selectedCandidate.showAssign}
                    onClose={() => setSelectedCandidate(null)}
                />
            )}
        </div>
    )
}

function PoolCandidateModal({ candidate, showAssignTab, onClose }) {
    const [activeTab, setActiveTab] = useState(showAssignTab ? 'assign' : 'overview')
    const queryClient = useQueryClient()

    const metadata = typeof candidate.metadata === 'string'
        ? JSON.parse(candidate.metadata || '{}')
        : (candidate.metadata || {})

    // Auto-assign mutation
    const autoAssignMutation = useMutation({
        mutationFn: (threshold) => autoAssignCandidate(candidate.id, threshold),
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ['general-pool'] })
            if (data.assignments.length > 0) {
                toast.success(`Assigned to ${data.assignments.length} jobs!`)
                onClose()
            } else {
                toast.error('No matching jobs found')
            }
        },
        onError: (error) => {
            toast.error('Auto-assign failed: ' + error.message)
        }
    })

    return (
        <Modal open={true} onClose={onClose} title={`Pool Candidate: ${candidate.name}`} size="lg">
            {/* Tab Navigation */}
            <div className="flex gap-1 mb-6 border-b border-zinc-200 dark:border-zinc-800">
                <button
                    className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors ${activeTab === 'overview'
                            ? 'border-primary-600 text-primary-600'
                            : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:text-zinc-300'
                        }`}
                    onClick={() => setActiveTab('overview')}
                >
                    <User size={14} className="inline mr-1" />
                    Overview
                </button>
                <button
                    className={`pb-3 px-4 text-sm font-medium border-b-2 transition-colors ${activeTab === 'assign'
                            ? 'border-primary-600 text-primary-600'
                            : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:text-zinc-300'
                        }`}
                    onClick={() => setActiveTab('assign')}
                >
                    <Briefcase size={14} className="inline mr-1" />
                    Assign to Job
                </button>
            </div>

            {activeTab === 'overview' ? (
                <div className="space-y-6">
                    {/* Basic Info */}
                    <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg p-6">
                        <div className="flex items-start gap-4">
                            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white text-2xl font-bold">
                                {candidate.name?.charAt(0)?.toUpperCase() || '?'}
                            </div>
                            <div className="flex-1">
                                <h3 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{candidate.name}</h3>
                                <div className="mt-2 flex flex-wrap gap-4 text-sm text-zinc-600 dark:text-zinc-400">
                                    <span className="flex items-center gap-1">
                                        <Phone size={14} />
                                        {candidate.phone}
                                    </span>
                                    <span className="flex items-center gap-1">
                                        <Mail size={14} />
                                        {candidate.email || 'No email'}
                                    </span>
                                </div>
                            </div>
                            <Badge status="future_pool" />
                        </div>
                    </div>

                    {/* Details */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="p-4 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg">
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 uppercase">Source</p>
                            <p className="font-semibold text-zinc-900 dark:text-zinc-50">{candidate.source}</p>
                        </div>
                        <div className="p-4 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg">
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 uppercase">Experience</p>
                            <p className="font-semibold text-zinc-900 dark:text-zinc-50">{metadata.experience_years || 0} years</p>
                        </div>
                        <div className="p-4 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg">
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 uppercase">Height</p>
                            <p className="font-semibold text-zinc-900 dark:text-zinc-50">{metadata.height_cm ? `${metadata.height_cm} cm` : 'N/A'}</p>
                        </div>
                        <div className="p-4 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg">
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 uppercase">Age</p>
                            <p className="font-semibold text-zinc-900 dark:text-zinc-50">{metadata.age ? `${metadata.age} years` : 'N/A'}</p>
                        </div>
                    </div>

                    {/* Skills */}
                    <div>
                        <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Skills & Tags</h4>
                        <div className="flex flex-wrap gap-2">
                            {(candidate.tags || []).map((tag, i) => (
                                <span key={i} className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm font-medium">
                                    {tag}
                                </span>
                            ))}
                            {(!candidate.tags || candidate.tags.length === 0) && (
                                <span className="text-zinc-500 dark:text-zinc-400 text-sm">No skills/tags added</span>
                            )}
                        </div>
                    </div>

                    {/* CV */}
                    <div>
                        <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">CV / Documents</h4>
                        <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <FileText className="text-purple-500" size={24} />
                                <div>
                                    <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{candidate.name}_CV.pdf</span>
                                    <p className="text-xs text-zinc-500 dark:text-zinc-400">Uploaded via {candidate.source}</p>
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <Button variant="secondary" size="sm" className="gap-1">
                                    <Eye size={14} />
                                    Preview
                                </Button>
                                <Button variant="secondary" size="sm" className="gap-1">
                                    <Download size={14} />
                                    Download
                                </Button>
                            </div>
                        </div>
                    </div>

                    {/* Notes */}
                    {candidate.notes && (
                        <div>
                            <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Notes</h4>
                            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                                {candidate.notes}
                            </div>
                        </div>
                    )}

                    {/* Chatbot Remarks — saved when the WhatsApp bot routed this lead to the general pool */}
                    {candidate.remarks && (
                        <div>
                            <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">Chatbot Remarks</h4>
                            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-blue-900 text-sm whitespace-pre-wrap">
                                {candidate.remarks}
                            </div>
                        </div>
                    )}

                    {/* Preferences Timeline — every preference the candidate declared, when */}
                    {Array.isArray(candidate.preferences_log) && candidate.preferences_log.length > 0 && (
                        <div>
                            <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                                Preferences History ({candidate.preferences_log.length})
                            </h4>
                            <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg divide-y divide-gray-100">
                                {candidate.preferences_log.map((entry, i) => (
                                    <div key={i} className="px-4 py-2 text-sm flex items-start justify-between gap-3">
                                        <div className="text-zinc-700 dark:text-zinc-300">
                                            <span className="font-medium">{entry.job_role || '—'}</span>
                                            {entry.country && <span className="text-zinc-500 dark:text-zinc-400"> · {entry.country}</span>}
                                            {entry.experience_years != null && <span className="text-zinc-500 dark:text-zinc-400"> · {entry.experience_years}y</span>}
                                            {entry.source && <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-2">({entry.source})</span>}
                                        </div>
                                        {entry.ts && (
                                            <span className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
                                                {new Date(entry.ts).toLocaleString()}
                                            </span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex justify-end gap-3 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                        <Button variant="secondary" onClick={onClose}>Close</Button>
                        <Button onClick={() => setActiveTab('assign')} className="gap-1">
                            <ArrowRight size={16} />
                            Assign to Job
                        </Button>
                    </div>
                </div>
            ) : (
                <AssignTab
                    candidate={candidate}
                    onClose={onClose}
                    onAutoAssign={(threshold) => autoAssignMutation.mutate(threshold)}
                    isAutoAssigning={autoAssignMutation.isPending}
                />
            )}
        </Modal>
    )
}

function AssignTab({ candidate, onClose, onAutoAssign, isAutoAssigning }) {
    const [selectedJobId, setSelectedJobId] = useState('')
    const [assignmentThreshold, setAssignmentThreshold] = useState(50)
    const queryClient = useQueryClient()

    const { data: jobsData } = useQuery({
        queryKey: ['jobs', { status: 'active' }],
        queryFn: () => getJobs({ status: 'active' })
    })

    const jobs = jobsData?.data || []

    const manualAssignMutation = useMutation({
        mutationFn: () => createApplication({ candidate_id: candidate.id, job_id: selectedJobId }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['general-pool'] })
            queryClient.invalidateQueries({ queryKey: ['applications'] })
            toast.success('Candidate assigned to job!')
            onClose()
        },
        onError: (error) => {
            toast.error('Assignment failed: ' + error.message)
        }
    })

    return (
        <div className="space-y-6">
            {/* Auto-Assign Option */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5">
                <div className="flex items-start gap-3">
                    <Sparkles className="text-blue-500 mt-0.5" size={24} />
                    <div className="flex-1">
                        <h3 className="font-semibold text-blue-900">Auto-Assign to Matching Jobs</h3>
                        <p className="text-sm text-blue-700 mt-1 mb-4">
                            Let the system automatically find and assign this candidate to all matching job positions based on skills, experience, and requirements.
                        </p>

                        <div className="flex items-center gap-4">
                            <div className="flex items-center gap-2">
                                <label className="text-sm font-medium text-blue-800">Min Match Score:</label>
                                <select
                                    className="input py-1 px-2 text-sm"
                                    value={assignmentThreshold}
                                    onChange={(e) => setAssignmentThreshold(parseInt(e.target.value))}
                                >
                                    <option value={50}>50% (Fair)</option>
                                    <option value={60}>60% (Good)</option>
                                    <option value={80}>80% (Excellent)</option>
                                </select>
                            </div>
                            <Button
                                onClick={() => onAutoAssign(assignmentThreshold)}
                                loading={isAutoAssigning}
                                className="gap-1"
                            >
                                <Sparkles size={16} />
                                Auto-Assign Now
                            </Button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Manual Assignment */}
            <div>
                <h3 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-3">Or Manually Assign to a Job</h3>

                {jobs.length === 0 ? (
                    <div className="text-center py-8 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg">
                        <Briefcase className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600 mb-2" />
                        <p className="text-zinc-500 dark:text-zinc-400">No active jobs available</p>
                    </div>
                ) : (
                    <div className="space-y-3 max-h-[300px] overflow-y-auto pr-2">
                        {jobs.map(job => (
                            <label
                                key={job.id}
                                className={`flex items-center gap-4 p-4 border rounded-lg cursor-pointer transition-all ${selectedJobId === job.id
                                        ? 'border-primary-500 bg-primary-50'
                                        : 'border-zinc-200 dark:border-zinc-800 hover:border-gray-300'
                                    }`}
                            >
                                <input
                                    type="radio"
                                    name="job"
                                    value={job.id}
                                    checked={selectedJobId === job.id}
                                    onChange={(e) => setSelectedJobId(e.target.value)}
                                    className="sr-only"
                                />
                                <div className="flex-1">
                                    <h4 className="font-medium text-zinc-900 dark:text-zinc-50">{job.title}</h4>
                                    <p className="text-sm text-zinc-500 dark:text-zinc-400">{job.category} • {job.positions_available - (job.positions_filled || 0)} positions available</p>
                                </div>
                                {selectedJobId === job.id && (
                                    <CheckCircle className="text-primary-500" size={20} />
                                )}
                            </label>
                        ))}
                    </div>
                )}
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button
                    onClick={() => manualAssignMutation.mutate()}
                    loading={manualAssignMutation.isPending}
                    disabled={!selectedJobId}
                    className="gap-1"
                >
                    <ArrowRight size={16} />
                    Assign to Selected Job
                </Button>
            </div>
        </div>
    )
}
