import { useState, useEffect, useMemo } from 'react'
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
    Clock,
    Sparkles,
    CheckCircle,
    Layers,
    Tag,
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Modal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Card } from '../components/ui/Card'
import { Table } from '../components/ui/Table'
import { EmptyState } from '../components/ui/EmptyState'
import { Pagination } from '../components/ui/Pagination'
import { apiClient, getJobs, createApplication, getCandidateJobMatches } from '../api'
import { useSectionAccess } from '../stores/authStore'
import { resolveDocumentUrl, isImageDocument, PENDING_URL } from '../utils/documents'
import { DocumentPreview } from '../components/documents/DocumentPreview'
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

    const pageStats = useMemo(() => {
        const withSkills = candidates.filter((c) => (c.tags || []).length > 0).length
        const withRemarks = candidates.filter((c) => Boolean(c.remarks)).length
        return { withSkills, withRemarks }
    }, [candidates])

    return (
        <div className="p-6 lg:p-8 animate-fade-in space-y-6">
            <PageHeader
                icon={Database}
                tone="mixed"
                title="Future Pool"
                subtitle="One backup talent pool (Future Pool = General Pool) — every candidate parked for later, with their details, CV, and best-fit job matches."
                actions={
                    <Button variant="secondary" onClick={() => refetch()}>
                        <RefreshCw size={16} />
                        Refresh
                    </Button>
                }
            />

            {/* Info Banner */}
            <div className="rounded-2xl section-grad-purple ring-1 ring-inset ring-purple-200/60 dark:ring-purple-900/60 p-4">
                <div className="flex items-start gap-3">
                    <div className="rounded-xl bg-purple-100 dark:bg-purple-900/60 p-2 text-purple-700 dark:text-purple-200 shadow-sm">
                        <Sparkles size={18} aria-hidden />
                    </div>
                    <div>
                        <h3 className="font-semibold text-purple-900 dark:text-purple-100">About General Pool</h3>
                        <p className="text-sm text-purple-800 dark:text-purple-200 mt-1">
                            <span className="font-semibold">General Pool = Future Pool.</span> These candidates didn't match any
                            active job during automatic assessment, so they sit here until they're manually or auto-assigned. As
                            soon as you assign one to a job, they drop out of this list.
                        </p>
                    </div>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <PoolStat tone="purple"  icon={Database} label="Total in Pool" value={pagination?.total || 0} />
                <PoolStat tone="emerald" icon={Tag}      label="With Skills (page)" value={pageStats.withSkills} subtitle="on this page" />
                <PoolStat tone="blue"    icon={Layers}   label="With Remarks (page)" value={pageStats.withRemarks} subtitle="on this page" />
            </div>

            {/* Search */}
            <Card className="p-4">
                <div className="relative max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" size={18} />
                    <input
                        type="text"
                        placeholder="Search candidates by name, phone, or email..."
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        className="input pl-9 w-full"
                    />
                </div>
            </Card>

            {/* Candidates List */}
            <Card className="overflow-hidden p-0">
                <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/60">
                    <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
                        Pool Candidates <span className="text-zinc-500 dark:text-zinc-400 font-normal">({filteredCandidates.length})</span>
                    </h2>
                </div>

                {isLoading ? (
                    <div className="p-5"><TableSkeleton rows={8} cols={5} /></div>
                ) : filteredCandidates.length === 0 ? (
                    <EmptyState
                        icon={Database}
                        tone="purple"
                        title={candidates.length === 0 ? 'All candidates matched' : 'No candidates match your search'}
                        description={candidates.length === 0
                            ? 'Every candidate has been assigned to a job. New unmatched leads will appear here automatically.'
                            : 'Try a different name, phone, or email.'}
                    />
                ) : (
                    <Table>
                        <Table.Head>
                            <Table.Tr hover={false}>
                                <Table.Th icon={User}>Candidate</Table.Th>
                                <Table.Th icon={Phone}>Contact</Table.Th>
                                <Table.Th icon={Tag}>Skills</Table.Th>
                                <Table.Th icon={Calendar}>Added</Table.Th>
                                <Table.Th align="right">Actions</Table.Th>
                            </Table.Tr>
                        </Table.Head>
                        <Table.Body>
                            {filteredCandidates.map((candidate) => (
                                <Table.Tr key={candidate.id} accent="purple">
                                    <Table.Td className="min-w-[220px]">
                                        <div className="flex items-center gap-3">
                                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white font-bold ring-2 ring-white dark:ring-zinc-900 shadow-sm shrink-0">
                                                {candidate.name?.charAt(0)?.toUpperCase() || '?'}
                                            </div>
                                            <div className="min-w-0">
                                                <p className="font-semibold text-zinc-900 dark:text-zinc-50 truncate">{candidate.name}</p>
                                                <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                                                    via {candidate.source || 'unknown'}
                                                </p>
                                            </div>
                                        </div>
                                    </Table.Td>
                                    <Table.Td>
                                        <p className="text-sm text-zinc-700 dark:text-zinc-300 inline-flex items-center gap-1">
                                            <Phone size={12} className="text-zinc-400 dark:text-zinc-500" />
                                            {candidate.phone || '—'}
                                        </p>
                                        {candidate.email && (
                                            <p className="text-xs text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1 mt-0.5">
                                                <Mail size={12} className="text-zinc-400 dark:text-zinc-500" />
                                                {candidate.email}
                                            </p>
                                        )}
                                    </Table.Td>
                                    <Table.Td>
                                        <div className="flex flex-wrap gap-1 max-w-[220px]">
                                            {(candidate.tags || []).slice(0, 3).map((skill, i) => (
                                                <span key={i} className="inline-flex items-center text-xs bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 px-2 py-0.5 rounded-full ring-1 ring-inset ring-purple-200 dark:ring-purple-900/60">
                                                    {skill}
                                                </span>
                                            ))}
                                            {(candidate.tags || []).length > 3 && (
                                                <span className="inline-flex items-center text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-2 py-0.5 rounded-full">
                                                    +{(candidate.tags || []).length - 3}
                                                </span>
                                            )}
                                            {(candidate.tags || []).length === 0 && (
                                                <span className="text-xs text-zinc-400 dark:text-zinc-500 italic">No skills tagged</span>
                                            )}
                                        </div>
                                        {candidate.remarks && (
                                            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 truncate max-w-[220px]" title={candidate.remarks}>
                                                {candidate.remarks}
                                            </p>
                                        )}
                                    </Table.Td>
                                    <Table.Td className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                                        {new Date(candidate.updated_at || candidate.created_at).toLocaleDateString()}
                                    </Table.Td>
                                    <Table.Td align="right">
                                        <div className="inline-flex gap-1.5">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => setSelectedCandidate(candidate)}
                                                className="gap-1"
                                            >
                                                <Eye size={13} />
                                                View
                                            </Button>
                                            <Button
                                                variant="primary"
                                                size="sm"
                                                onClick={() => setSelectedCandidate({ ...candidate, showAssign: true })}
                                                className="gap-1"
                                            >
                                                <ArrowRight size={13} />
                                                Assign
                                            </Button>
                                        </div>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Body>
                    </Table>
                )}

                {pagination && pagination.totalPages > 1 && (
                    <Pagination
                        page={pagination.page || page}
                        totalPages={pagination.totalPages}
                        total={pagination.total}
                        pageSize={pagination.limit || 20}
                        onChange={setPage}
                    />
                )}
            </Card>

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

const POOL_STAT_TONES = {
    purple:  { wrap: 'section-grad-purple ring-purple-200/60 dark:ring-purple-900/60',   label: 'text-purple-700 dark:text-purple-300',   value: 'text-purple-900 dark:text-purple-100',   icon: 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-200' },
    emerald: { wrap: 'section-grad-emerald ring-emerald-200/60 dark:ring-emerald-900/60', label: 'text-emerald-700 dark:text-emerald-300', value: 'text-emerald-900 dark:text-emerald-100', icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200' },
    blue:    { wrap: 'section-grad-blue ring-blue-200/60 dark:ring-blue-900/60',         label: 'text-blue-700 dark:text-blue-300',       value: 'text-blue-900 dark:text-blue-100',       icon: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200' },
}

function PoolStat({ tone = 'purple', icon: Icon, label, value, subtitle }) {
    const t = POOL_STAT_TONES[tone] || POOL_STAT_TONES.purple
    return (
        <div className={`relative overflow-hidden rounded-2xl ring-1 ring-inset bg-white dark:bg-zinc-900 p-4 ${t.wrap}`}>
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className={`text-[10px] font-semibold uppercase tracking-wider ${t.label}`}>{label}</p>
                    <p className={`mt-1 text-3xl font-bold tracking-tight ${t.value}`}>{value}</p>
                    {subtitle && <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5">{subtitle}</p>}
                </div>
                {Icon && (
                    <div className={`rounded-2xl p-3 shadow-sm ${t.icon}`}>
                        <Icon size={20} aria-hidden />
                    </div>
                )}
            </div>
        </div>
    )
}

function PoolCandidateModal({ candidate, showAssignTab, onClose }) {
    const [activeTab, setActiveTab] = useState(showAssignTab ? 'assign' : 'overview')
    const queryClient = useQueryClient()

    const metadata = typeof candidate.metadata === 'string'
        ? JSON.parse(candidate.metadata || '{}')
        : (candidate.metadata || {})

    // Resolved, browser-openable CV link (backend already normalises the raw
    // storage path to an https GCS URL). Null when the CV is missing OR still
    // syncing from the chatbot — cv_status disambiguates the two (B001/B002).
    const cvUrl = (() => {
        const u = resolveDocumentUrl({ file_url: candidate.cv_url, file_name: candidate.cv_filename })
        return u && u !== PENDING_URL ? u : null
    })()
    const cvProcessing = !cvUrl && candidate.cv_status === 'placeholder_unresolved'

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

                    {/* CV — inline preview so image CVs actually render instead
                        of a dead "Preview" button popping a blank tab, with an
                        explicit "processing" state for chatbot uploads still
                        syncing (B001/B002). */}
                    <div>
                        <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">CV / Documents</h4>
                        {cvUrl ? (
                            <DocumentPreview
                                url={cvUrl}
                                isImage={isImageDocument({ file_name: candidate.cv_filename })}
                                fileName={candidate.cv_filename || `${candidate.name}_CV`}
                                className="h-80"
                            />
                        ) : cvProcessing ? (
                            <div className="p-4 border border-dashed border-amber-300 dark:border-amber-700/60 rounded-lg bg-amber-50/60 dark:bg-amber-900/10 text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2">
                                <Clock size={16} className="shrink-0" />
                                CV is still syncing from the chatbot — try again in a moment.
                            </div>
                        ) : (
                            <div className="p-4 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 text-sm text-zinc-500 dark:text-zinc-400">
                                No CV uploaded for this candidate.
                            </div>
                        )}
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
    // Auto-assign hits /api/auto-assign which now requires applications.create;
    // hide the whole auto-assign block for roles (e.g. project_handler) that
    // would otherwise get a 403. Manual assign below is unaffected.
    const canAutoAssign = useSectionAccess('applications', 'create')

    const { data: jobsData } = useQuery({
        queryKey: ['jobs', { status: 'active' }],
        queryFn: () => getJobs({ status: 'active' })
    })

    const jobs = jobsData?.data || []

    // Smart backup plan: best-fit jobs for this pooled candidate across the whole
    // board (semantic match). Read-only suggestion — assignment still uses the
    // CV-gated path below.
    const { data: jobMatches } = useQuery({
        queryKey: ['candidate-job-matches', candidate.id],
        queryFn: () => getCandidateJobMatches(candidate.id, { limit: 5 }),
        staleTime: 60_000,
    })
    const topMatches = Array.isArray(jobMatches?.jobs) ? jobMatches.jobs : []

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
            {canAutoAssign && (
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
            )}

            {/* Smart backup matches — best-fit jobs across the whole board */}
            {topMatches.length > 0 && (
                <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/20 p-4">
                    <div className="flex items-center gap-2 mb-2">
                        <Sparkles size={16} className="text-emerald-600" />
                        <h3 className="font-semibold text-emerald-900 dark:text-emerald-200">Best-fit jobs (smart match)</h3>
                    </div>
                    <p className="text-xs text-emerald-700 dark:text-emerald-300 mb-3">
                        Top matches for this candidate across all open roles — your quick backup plan. Click one to select it below.
                    </p>
                    <div className="space-y-2">
                        {topMatches.map((m) => (
                            <button
                                key={m.job_id}
                                type="button"
                                onClick={() => setSelectedJobId(m.job_id)}
                                className={`w-full text-left flex items-center gap-3 p-2.5 rounded-lg border transition-colors ${
                                    selectedJobId === m.job_id
                                        ? 'border-emerald-500 bg-emerald-100/70 dark:bg-emerald-900/30'
                                        : 'border-emerald-200 dark:border-emerald-900/50 bg-white dark:bg-zinc-900 hover:border-emerald-300'
                                }`}
                            >
                                <span className="inline-flex items-center justify-center w-12 h-7 rounded-md bg-emerald-600 text-white text-xs font-bold flex-shrink-0">
                                    {m.match_percent}%
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-50 truncate">{m.title}</span>
                                    {Array.isArray(m.why_matched) && m.why_matched.length > 0 && (
                                        <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                                            Matches: {m.why_matched.slice(0, 5).join(', ')}
                                        </span>
                                    )}
                                </span>
                                {selectedJobId === m.job_id && <CheckCircle size={16} className="text-emerald-600 flex-shrink-0" />}
                            </button>
                        ))}
                    </div>
                </div>
            )}

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
