import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { showNotificationToast } from '../utils/notificationToast'
import {
    ArrowLeft,
    Users,
    CheckCircle,
    CheckCircle2,
    Phone,
    Mail,
    FileText,
    Star,
    TrendingUp,
    AlertCircle,
    AlertTriangle,
    Briefcase,
    Clock,
    Eye,
    Award,
    ArrowRightLeft,
    Percent,
    Target,
    MapPin,
    Send,
    MessageSquare,
    Copy,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    Sparkles,
    Download,
    XCircle,
    Calendar,
    MapPinned,
    Smartphone,
    MailIcon,
    UserX
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { Skeleton } from '../components/ui/Skeleton'
import { apiClient } from '../api'
import { updateApplication, transferApplication, getJobs, rejectToPool, batchCertifyApplications, batchAutoAssign } from '../api'
import toast from 'react-hot-toast'

// API functions for auto-assign
const getJobCandidates = (jobId) =>
    apiClient.get(`/api/auto-assign/job/${jobId}/candidates`).then(res => res.data)

export default function JobCandidates() {
    const { jobId } = useParams()
    const navigate = useNavigate()
    const queryClient = useQueryClient()

    const [selectedCandidate, setSelectedCandidate] = useState(null)
    const [showCertifyModal, setShowCertifyModal] = useState(false)
    const [showPreScreenModal, setShowPreScreenModal] = useState(false)
    const [showScheduleModal, setShowScheduleModal] = useState(false)
    const [showTransferModal, setShowTransferModal] = useState(false)
    const [showRejectModal, setShowRejectModal] = useState(false)
    const [showApproveModal, setShowApproveModal] = useState(false)
    const [showMessagePreview, setShowMessagePreview] = useState(false)
    const [statusFilter, setStatusFilter] = useState('')
    const [selectedIds, setSelectedIds] = useState(new Set())
    const [showBatchCertifyModal, setShowBatchCertifyModal] = useState(false)

    const { data, isLoading, error } = useQuery({
        queryKey: ['job-candidates', jobId],
        queryFn: () => getJobCandidates(jobId)
    })

    const job = data?.job
    const candidates = data?.candidates || []
    const stats = data?.stats || {}

    const filteredCandidates = statusFilter
        ? candidates.filter(c => {
            if (statusFilter === 'excellent') return c.match_score >= 80
            if (statusFilter === 'good') return c.match_score >= 60 && c.match_score < 80
            if (statusFilter === 'fair') return c.match_score >= 50 && c.match_score < 60
            if (statusFilter === 'certified') return c.application_status === 'certified'
            if (statusFilter === 'pending') return ['auto_assigned', 'applied', 'reviewing'].includes(c.application_status)
            return true
        })
        : candidates

    if (isLoading) {
        return (
            <div className="p-6 lg:p-8 animate-fade-in">
                <Skeleton className="h-8 w-48 mb-4" />
                <Skeleton className="h-4 w-96 mb-8" />
                <div className="grid grid-cols-5 gap-4 mb-6">
                    {[...Array(5)].map((_, i) => (
                        <Skeleton key={i} className="h-24 rounded-xl" />
                    ))}
                </div>
                <Skeleton className="h-96 rounded-xl" />
            </div>
        )
    }

    if (error || !job) {
        return (
            <div className="p-6 lg:p-8 animate-fade-in">
                <div className="card p-12 text-center">
                    <AlertCircle className="mx-auto h-12 w-12 text-red-400 mb-4" />
                    <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50 mb-2">Job Not Found</h2>
                    <p className="text-zinc-600 dark:text-zinc-400 mb-4">The job you're looking for doesn't exist or has been removed.</p>
                    <Button onClick={() => navigate('/jobs')}>Back to Jobs</Button>
                </div>
            </div>
        )
    }

    return (
        <div className="p-6 lg:p-8 animate-fade-in">
            {/* Header */}
            <div className="mb-6">
                <Link
                    to="/jobs"
                    className="inline-flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:text-zinc-300 mb-3"
                >
                    <ArrowLeft size={16} />
                    Back to Jobs
                </Link>
                <div className="flex justify-between items-start">
                    <div>
                        <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">{job.title}</h1>
                        <div className="flex items-center gap-4 mt-2">
                            <span className="text-zinc-600 dark:text-zinc-400 flex items-center gap-1">
                                <Briefcase size={16} />
                                {job.category}
                            </span>
                            <Badge status={job.status} />
                            <span className="text-zinc-600 dark:text-zinc-400">
                                {job.positions_filled || 0} / {job.positions_available} filled
                            </span>
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => navigate(`/jobs/${jobId}`)}>
                            View Job Details
                        </Button>
                    </div>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
                <StatCard
                    label="Total Candidates"
                    value={candidates.length}
                    icon={Users}
                    color="blue"
                    onClick={() => setStatusFilter('')}
                    active={statusFilter === ''}
                />
                <StatCard
                    label="Excellent Match"
                    value={stats.excellent || 0}
                    icon={Star}
                    color="green"
                    onClick={() => setStatusFilter('excellent')}
                    active={statusFilter === 'excellent'}
                />
                <StatCard
                    label="Good Match"
                    value={stats.good || 0}
                    icon={TrendingUp}
                    color="amber"
                    onClick={() => setStatusFilter('good')}
                    active={statusFilter === 'good'}
                />
                <StatCard
                    label="Certified"
                    value={stats.certified || 0}
                    icon={CheckCircle2}
                    color="purple"
                    onClick={() => setStatusFilter('certified')}
                    active={statusFilter === 'certified'}
                />
                <StatCard
                    label="Pending Review"
                    value={stats.pending || 0}
                    icon={Clock}
                    color="gray"
                    onClick={() => setStatusFilter('pending')}
                    active={statusFilter === 'pending'}
                />
            </div>

            {/* Diagnostic banner: empty pipeline for a freshly-created (AI-ingested
                or otherwise) job. The "View Candidates not working" complaint
                is almost always this: auto-assign never ran for the new job, so
                no applications exist. Surface the cause + one-click fix. */}
            {candidates.length === 0 && (
                <EmptyPipelineBanner jobId={jobId} onScanned={() => queryClient.invalidateQueries({ queryKey: ['job-candidates', jobId] })} />
            )}

            {/* Candidates List */}
            <div className="card overflow-hidden">
                <div className="p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 flex justify-between items-center">
                    <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">
                        Assigned Candidates ({filteredCandidates.length})
                    </h2>
                    {statusFilter && (
                        <Button variant="secondary" size="sm" onClick={() => setStatusFilter('')}>
                            Clear Filter
                        </Button>
                    )}
                </div>

                {filteredCandidates.length === 0 ? (
                    <div className="py-12 text-center text-zinc-500 dark:text-zinc-400">
                        <Users className="mx-auto h-12 w-12 text-gray-300 mb-2" />
                        <p className="font-medium">No candidates found</p>
                        <p className="text-sm mt-1">
                            {candidates.length === 0
                                ? 'No candidates have been auto-assigned to this job yet'
                                : 'No candidates match the selected filter'}
                        </p>
                    </div>
                ) : (
                    <div className="divide-y divide-gray-100">
                        {filteredCandidates.map(candidateData => (
                            <CandidateRow
                                key={candidateData.application_id}
                                data={candidateData}
                                job={job}
                                isSelected={selectedIds.has(candidateData.application_id)}
                                onToggleSelect={() => setSelectedIds(prev => {
                                    const next = new Set(prev)
                                    if (next.has(candidateData.application_id)) next.delete(candidateData.application_id)
                                    else next.add(candidateData.application_id)
                                    return next
                                })}
                                onSelect={() => setSelectedCandidate(candidateData)}
                                onCertify={() => {
                                    setSelectedCandidate(candidateData)
                                    setShowCertifyModal(true)
                                }}
                                onPreScreen={() => {
                                    setSelectedCandidate(candidateData)
                                    setShowPreScreenModal(true)
                                }}
                                onSchedule={() => {
                                    setSelectedCandidate(candidateData)
                                    setShowScheduleModal(true)
                                }}
                                onTransfer={() => {
                                    setSelectedCandidate(candidateData)
                                    setShowTransferModal(true)
                                }}
                                onReject={() => {
                                    setSelectedCandidate(candidateData)
                                    setShowRejectModal(true)
                                }}
                                onApprove={() => {
                                    setSelectedCandidate(candidateData)
                                    setShowApproveModal(true)
                                }}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Floating Batch Action Bar */}
            {selectedIds.size > 0 && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-4">
                    <span className="text-sm font-medium">{selectedIds.size} candidate{selectedIds.size > 1 ? 's' : ''} selected</span>
                    <Button
                        size="sm"
                        onClick={() => setShowBatchCertifyModal(true)}
                        className="bg-green-500 hover:bg-green-400 text-white border-0"
                    >
                        <CheckCircle size={14} className="mr-1" />
                        Batch Certify
                    </Button>
                    <button onClick={() => setSelectedIds(new Set())} className="text-zinc-400 dark:text-zinc-500 hover:text-white text-sm">
                        Clear
                    </button>
                </div>
            )}

            {/* Batch Certify Modal */}
            {showBatchCertifyModal && (
                <BatchCertifyModal
                    selectedIds={selectedIds}
                    candidates={filteredCandidates.filter(c => selectedIds.has(c.application_id))}
                    onClose={() => {
                        setShowBatchCertifyModal(false)
                        setSelectedIds(new Set())
                    }}
                    onSuccess={() => {
                        setShowBatchCertifyModal(false)
                        setSelectedIds(new Set())
                        queryClient.invalidateQueries({ queryKey: ['job-candidates', jobId] })
                    }}
                />
            )}

            {/* Candidate Quick View Modal */}
            {selectedCandidate && !showCertifyModal && !showTransferModal && !showRejectModal && (
                <CandidateQuickViewModal
                    data={selectedCandidate}
                    job={job}
                    onClose={() => setSelectedCandidate(null)}
                    onCertify={() => setShowCertifyModal(true)}
                    onTransfer={() => setShowTransferModal(true)}
                    onReject={() => setShowRejectModal(true)}
                />
            )}

            {/* Certify Modal */}
            {showCertifyModal && selectedCandidate && (
                <CertifyModal
                    data={selectedCandidate}
                    job={job}
                    onClose={() => {
                        setShowCertifyModal(false)
                        setSelectedCandidate(null)
                    }}
                />
            )}

            {/* Mark Pre-Screened Modal */}
            {showPreScreenModal && selectedCandidate && (
                <MarkPreScreenedModal
                    data={selectedCandidate}
                    job={job}
                    onClose={() => {
                        setShowPreScreenModal(false)
                        setSelectedCandidate(null)
                    }}
                />
            )}

            {/* Schedule Interview Modal */}
            {showScheduleModal && selectedCandidate && (
                <ScheduleInterviewModal
                    data={selectedCandidate}
                    job={job}
                    onClose={() => {
                        setShowScheduleModal(false)
                        setSelectedCandidate(null)
                    }}
                />
            )}

            {/* Transfer Modal */}
            {showTransferModal && selectedCandidate && (
                <TransferModal
                    data={selectedCandidate}
                    currentJob={job}
                    onClose={() => {
                        setShowTransferModal(false)
                        setSelectedCandidate(null)
                    }}
                />
            )}

            {/* Reject to Pool Modal */}
            {showRejectModal && selectedCandidate && (
                <RejectToPoolModal
                    data={selectedCandidate}
                    job={job}
                    onClose={() => {
                        setShowRejectModal(false)
                        setSelectedCandidate(null)
                    }}
                />
            )}

            {/* Approve Modal — fills 1 position, auto-completes job when last seat fills */}
            {showApproveModal && selectedCandidate && (
                <ApproveModal
                    data={selectedCandidate}
                    job={job}
                    positionsRemaining={Math.max(0, (job.positions_available || 0) - (job.positions_filled || 0))}
                    onClose={() => {
                        setShowApproveModal(false)
                        setSelectedCandidate(null)
                    }}
                    onSuccess={() => {
                        queryClient.invalidateQueries({ queryKey: ['job-candidates', jobId] })
                        queryClient.invalidateQueries({ queryKey: ['job', jobId] })
                        queryClient.invalidateQueries({ queryKey: ['jobs'] })
                    }}
                />
            )}
        </div>
    )
}

// ──────────────────────────────────────────────────────────────────────────
// EmptyPipelineBanner — "View Candidates not working" turns out to be
// auto-assign never having run for this job. Offer a one-click scan.
// ──────────────────────────────────────────────────────────────────────────
function EmptyPipelineBanner({ jobId, onScanned }) {
    const [scanning, setScanning] = useState(false)
    return (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/30">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600 dark:text-amber-400" />
                    <div className="text-sm text-amber-900 dark:text-amber-200">
                        <p className="font-medium">No candidates have been auto-assigned to this job yet.</p>
                        <p className="mt-1 text-amber-800/80 dark:text-amber-200/80">
                            Run an auto-assignment scan to match existing candidates against this job's requirements.
                        </p>
                    </div>
                </div>
                <Button
                    variant="secondary"
                    onClick={async () => {
                        setScanning(true)
                        try {
                            const result = await batchAutoAssign(50, 'new')
                            toast.success(`Scan complete — ${result.assigned || 0} candidates assigned`)
                            onScanned?.()
                        } catch (err) {
                            toast.error(err.response?.data?.error || 'Auto-assignment scan failed')
                        } finally {
                            setScanning(false)
                        }
                    }}
                    disabled={scanning}
                >
                    {scanning ? 'Scanning…' : 'Auto-Assign Now'}
                </Button>
            </div>
        </div>
    )
}

// ──────────────────────────────────────────────────────────────────────────
// ApproveModal — sets application.status='selected'. Backend cascade
// auto-completes the job when the last seat fills (see applications.js).
// ──────────────────────────────────────────────────────────────────────────
function ApproveModal({ data, job, positionsRemaining, onClose, onSuccess }) {
    const candidate = data.candidate || {}
    const [submitting, setSubmitting] = useState(false)

    const disabled = job.status !== 'active' || positionsRemaining <= 0 || data.application_status === 'selected'

    const handleApprove = async () => {
        if (disabled) return
        setSubmitting(true)
        try {
            await updateApplication(data.application_id, {
                status: 'selected',
                notify_channels: ['whatsapp'],
            })
            toast.success(`${candidate.name} approved for ${job.title}`)
            onSuccess?.()
            onClose()
        } catch (err) {
            toast.error(err.response?.data?.error || 'Failed to approve candidate')
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <Modal open onClose={onClose} title="Approve candidate for this job" size="md">
            <div className="space-y-4">
                <div className="rounded-xl bg-zinc-50 dark:bg-zinc-800/40 p-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-emerald-500 to-emerald-700 flex items-center justify-center text-white text-sm font-bold">
                            {candidate.name?.charAt(0)?.toUpperCase() || 'C'}
                        </div>
                        <div className="min-w-0">
                            <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{candidate.name}</p>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{candidate.phone || candidate.email}</p>
                        </div>
                    </div>
                </div>
                <p className="text-sm text-zinc-700 dark:text-zinc-300">
                    Approving will fill <strong>1 of {positionsRemaining}</strong> remaining position{positionsRemaining === 1 ? '' : 's'}
                    {' '}for <strong>{job.title}</strong> and notify the candidate via WhatsApp.
                </p>
                {disabled && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                        {job.status !== 'active'
                            ? `Job is ${job.status}. Set it back to Active before approving.`
                            : data.application_status === 'selected'
                                ? 'This candidate has already been approved.'
                                : 'No positions remain on this job.'}
                    </div>
                )}
                <div className="flex justify-end gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                    <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
                    <Button onClick={handleApprove} disabled={disabled || submitting}>
                        {submitting ? 'Approving…' : 'Approve Candidate'}
                    </Button>
                </div>
            </div>
        </Modal>
    )
}

function StatCard({ label, value, icon: Icon, color, onClick, active }) {
    const colorClasses = {
        blue: 'bg-blue-50 text-blue-700 border-blue-200',
        green: 'bg-green-50 text-green-700 border-green-200',
        amber: 'bg-amber-50 text-amber-700 border-amber-200',
        purple: 'bg-purple-50 text-purple-700 border-purple-200',
        gray: 'bg-zinc-50 dark:bg-zinc-900/60 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-800'
    }

    return (
        <button
            onClick={onClick}
            className={`card py-3 px-4 border-2 text-left transition-all ${active
                ? 'border-primary-500 ring-2 ring-primary-200'
                : `${colorClasses[color]} hover:border-gray-300`
                }`}
        >
            <div className="flex items-center gap-2 mb-1">
                <Icon size={16} />
                <span className="text-xs opacity-80 uppercase tracking-wide">{label}</span>
            </div>
            <p className="text-2xl font-bold">{value}</p>
        </button>
    )
}

function BatchCertifyModal({ selectedIds, candidates, onClose, onSuccess }) {
    const [prescreeningDate, setPrescreeningDate] = useState('')
    const [prescreeningTime, setPrescreeningTime] = useState('')
    const [prescreeningLocation, setPrescreeningLocation] = useState('')
    const [notes, setNotes] = useState('')
    const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)
    const [notifyEmail, setNotifyEmail] = useState(false)

    const getChannels = () => {
        const ch = []
        if (notifyWhatsApp) ch.push('whatsapp')
        if (notifyEmail) ch.push('email')
        return ch.length > 0 ? ch : ['whatsapp']
    }

    const mutation = useMutation({
        mutationFn: () => batchCertifyApplications({
            application_ids: Array.from(selectedIds),
            prescreening_datetime: prescreeningDate && prescreeningTime ? `${prescreeningDate}T${prescreeningTime}` : undefined,
            prescreening_location: prescreeningLocation || undefined,
            certification_notes: notes || undefined,
            notify_channels: getChannels()
        }),
        onSuccess: (result) => {
            const count = result?.success_count ?? result?.certified ?? candidates.length
            // Aggregate per-candidate notification results so we can surface partial failures
            const aggregated = { success: [], failed: [] }
            const perResults = result?.results?.success || []
            perResults.forEach((r) => {
                if (r?.notification?.success) aggregated.success.push(...r.notification.success)
                if (r?.notification?.failed) aggregated.failed.push(...r.notification.failed)
            })
            if (aggregated.failed.length > 0) {
                showNotificationToast(aggregated, `${count} candidate(s) certified`)
            } else {
                toast.success(`${count} candidate(s) certified!`)
            }
            onSuccess()
        },
        onError: (err) => {
            toast.error(err?.response?.data?.error || 'Batch certify failed')
        }
    })

    return (
        <Modal onClose={onClose} title="Batch Certify Candidates">
            <div className="space-y-4">
                <div className="bg-zinc-50 dark:bg-zinc-900/60 rounded-xl p-3 max-h-40 overflow-y-auto">
                    <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2">{candidates.length} candidates selected</p>
                    {candidates.map(c => (
                        <div key={c.application_id} className="flex items-center gap-2 py-1 text-sm">
                            <CheckCircle size={12} className="text-green-500 flex-shrink-0" />
                            <span className="font-medium text-gray-800">{c.candidate.name}</span>
                            <span className="text-zinc-400 dark:text-zinc-500">{c.candidate.phone}</span>
                        </div>
                    ))}
                </div>

                <div>
                    <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Pre-Screening (optional)</p>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">Date</label>
                            <input
                                type="date"
                                value={prescreeningDate}
                                onChange={e => setPrescreeningDate(e.target.value)}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">Time</label>
                            <input
                                type="time"
                                value={prescreeningTime}
                                onChange={e => setPrescreeningTime(e.target.value)}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                    </div>
                    <div className="mt-2">
                        <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">Location</label>
                        <input
                            type="text"
                            placeholder="e.g. Head Office, Colombo 3"
                            value={prescreeningLocation}
                            onChange={e => setPrescreeningLocation(e.target.value)}
                            className="w-full border rounded-lg px-3 py-2 text-sm"
                        />
                    </div>
                </div>

                <div>
                    <label className="block text-xs text-zinc-500 dark:text-zinc-400 mb-1">Notes (optional)</label>
                    <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        placeholder="Internal certification notes..."
                        rows={2}
                        className="w-full border rounded-lg px-3 py-2 text-sm resize-none"
                    />
                </div>

                <div>
                    <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">Notify via</p>
                    <div className="flex gap-4">
                        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                            <input type="checkbox" checked={notifyWhatsApp} onChange={e => setNotifyWhatsApp(e.target.checked)} className="accent-primary-600" />
                            WhatsApp
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                            <input type="checkbox" checked={notifyEmail} onChange={e => setNotifyEmail(e.target.checked)} className="accent-primary-600" />
                            Email
                        </label>
                    </div>
                </div>

                <div className="flex gap-3 pt-2">
                    <Button variant="secondary" onClick={onClose} className="flex-1">Cancel</Button>
                    <Button
                        onClick={() => mutation.mutate()}
                        disabled={mutation.isLoading}
                        className="flex-1"
                    >
                        {mutation.isLoading ? 'Certifying...' : `Certify ${candidates.length} Candidates`}
                    </Button>
                </div>
            </div>
        </Modal>
    )
}

function CandidateRow({ data, job, isSelected, onToggleSelect, onSelect, onCertify, onTransfer, onReject, onApprove, onPreScreen, onSchedule }) {
    const { candidate, match_score, match_details, application_status, certified_at } = data

    const getScoreColor = (score) => {
        if (score >= 80) return 'text-green-600 bg-green-100'
        if (score >= 60) return 'text-amber-600 bg-amber-100'
        if (score >= 50) return 'text-orange-600 bg-orange-100'
        return 'text-red-600 bg-red-100'
    }

    const getScoreLabel = (score) => {
        if (score >= 80) return 'Excellent'
        if (score >= 60) return 'Good'
        if (score >= 50) return 'Fair'
        return 'Low'
    }

    return (
        <div className={`p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors ${isSelected ? 'bg-primary-50' : ''}`}>
            <div className="flex items-start gap-4">
                {/* Checkbox */}
                <div className="flex-shrink-0 pt-1">
                    <input
                        type="checkbox"
                        className="w-4 h-4 rounded accent-primary-600 cursor-pointer"
                        checked={!!isSelected}
                        onChange={onToggleSelect}
                        onClick={e => e.stopPropagation()}
                    />
                </div>
                {/* Avatar & Basic Info */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white font-bold text-lg flex-shrink-0 overflow-hidden">
                            {candidate.photo_url
                              ? <img src={`${import.meta.env.VITE_API_URL || ''}${candidate.photo_url}`} alt={candidate.name} className="w-full h-full object-cover" />
                              : candidate.name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="font-semibold text-zinc-900 dark:text-zinc-50 truncate">{candidate.name}</h3>
                                {application_status === 'certified' && (
                                    <span className="inline-flex items-center gap-1 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">
                                        <CheckCircle2 size={12} />
                                        Certified
                                    </span>
                                )}
                                {application_status === 'rejected' && (
                                    <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                                        <XCircle size={12} />
                                        General Pool
                                    </span>
                                )}
                                {(() => {
                                    const meta = typeof candidate.metadata === 'object' ? candidate.metadata : {}
                                    const critCount = (meta.mismatches || []).filter(m => m.severity === 'critical').length
                                    return critCount > 0 ? (
                                        <span className="flex items-center gap-1 text-xs font-medium text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
                                            <AlertTriangle size={11} /> {critCount} critical mismatch
                                        </span>
                                    ) : null
                                })()}
                            </div>
                            <div className="flex items-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
                                <span className="flex items-center gap-1">
                                    <Phone size={12} />
                                    {candidate.phone}
                                </span>
                                {candidate.email && (
                                    <span className="flex items-center gap-1">
                                        <Mail size={12} />
                                        {candidate.email}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Skills Tags */}
                    {candidate.tags && candidate.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2 ml-15">
                            {candidate.tags.slice(0, 4).map((tag, i) => (
                                <span key={i} className="text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 px-2 py-0.5 rounded-full">
                                    {tag}
                                </span>
                            ))}
                            {candidate.tags.length > 4 && (
                                <span className="text-xs text-zinc-400 dark:text-zinc-500">+{candidate.tags.length - 4}</span>
                            )}
                        </div>
                    )}
                </div>

                {/* Match Score */}
                <div className="text-center flex-shrink-0">
                    <div className={`inline-flex items-center gap-1 px-3 py-2 rounded-xl font-bold text-lg ${getScoreColor(match_score)}`}>
                        <Percent size={16} />
                        {match_score}%
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{getScoreLabel(match_score)} Match</p>
                </div>

                {/* Actions — driven by lifecycle status */}
                <div className="flex flex-wrap gap-2 flex-shrink-0 justify-end">
                    <Button variant="secondary" size="sm" onClick={onSelect} className="gap-1">
                        <Eye size={14} />
                        Quick View
                    </Button>
                    <LifecycleActions
                        status={application_status}
                        certifiedAt={certified_at}
                        onCertify={onCertify}
                        onPreScreen={onPreScreen}
                        onSchedule={onSchedule}
                        onApprove={onApprove}
                        onTransfer={onTransfer}
                        onReject={onReject}
                    />
                </div>
            </div>
        </div>
    )
}

// Status-aware action button cluster. Mirrors the candidate lifecycle the
// product spec describes: Applied → Certified → Pre Screened → Scheduled →
// Selected | Rejected. Each step exposes only the legal next actions so
// recruiters can't skip steps or trigger the wrong notification by accident.
function LifecycleActions({ status, certifiedAt, onCertify, onPreScreen, onSchedule, onApprove, onTransfer, onReject }) {
    if (status === 'selected' || status === 'placed') {
        return (
            <span className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1 px-2 font-medium">
                <Award size={12} /> Approved
            </span>
        )
    }
    if (status === 'rejected') {
        return (
            <span className="text-xs text-red-500 flex items-center gap-1 px-2">
                <XCircle size={12} /> Moved to Pool
            </span>
        )
    }
    if (status === 'pre_screened') {
        return (
            <>
                <Button size="sm" onClick={onSchedule} className="gap-1 bg-indigo-600 hover:bg-indigo-700 text-white">
                    <Calendar size={14} /> Schedule Interview
                </Button>
                <Button variant="danger" size="sm" onClick={onReject} className="gap-1" style={{ backgroundColor: '#ef4444', color: 'white', border: 'none' }}>
                    <UserX size={14} /> Reject
                </Button>
            </>
        )
    }
    if (status === 'interview_scheduled' || status === 'interviewed') {
        return (
            <>
                <Button size="sm" onClick={onApprove} className="gap-1 bg-emerald-600 hover:bg-emerald-700 text-white">
                    <Award size={14} /> Mark Selected
                </Button>
                <Button variant="danger" size="sm" onClick={onReject} className="gap-1" style={{ backgroundColor: '#ef4444', color: 'white', border: 'none' }}>
                    <UserX size={14} /> Reject
                </Button>
            </>
        )
    }
    if (status === 'certified') {
        return (
            <>
                <Button size="sm" onClick={onPreScreen} className="gap-1 bg-teal-600 hover:bg-teal-700 text-white">
                    <CheckCircle2 size={14} /> Mark Pre-Screened
                </Button>
                <span className="text-xs text-green-600 flex items-center gap-1 px-2 font-medium">
                    <CheckCircle2 size={12} />
                    Certified {certifiedAt && new Date(certifiedAt).toLocaleDateString()}
                </span>
                <Button variant="danger" size="sm" onClick={onReject} className="gap-1" style={{ backgroundColor: '#ef4444', color: 'white', border: 'none' }}>
                    <UserX size={14} /> Reject
                </Button>
            </>
        )
    }
    // Default = applied / auto_assigned / reviewing / screening
    return (
        <>
            <Button variant="secondary" size="sm" onClick={onCertify} className="gap-1">
                <CheckCircle size={14} /> Certify
            </Button>
            <Button variant="secondary" size="sm" onClick={onTransfer} className="gap-1">
                <ArrowRightLeft size={14} /> Transfer
            </Button>
            <Button variant="danger" size="sm" onClick={onReject} className="gap-1" style={{ backgroundColor: '#ef4444', color: 'white', border: 'none' }}>
                <UserX size={14} /> Reject
            </Button>
        </>
    )
}

function CandidateQuickViewModal({ data, job, onClose, onCertify, onTransfer, onReject }) {
    const { candidate, match_score, match_details, application_status } = data

    const getScoreColor = (score) => {
        if (score >= 80) return 'text-green-600 bg-green-50 border-green-200'
        if (score >= 60) return 'text-amber-600 bg-amber-50 border-amber-200'
        return 'text-orange-600 bg-orange-50 border-orange-200'
    }

    return (
        <Modal open={true} onClose={onClose} title="Candidate Quick View" size="lg">
            <div className="space-y-6">
                {/* Header with match score */}
                <div className="flex items-start gap-4 p-4 bg-gradient-to-r from-primary-50 to-blue-50 rounded-xl">
                    <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-2xl font-bold overflow-hidden">
                        {candidate.photo_url
                          ? <img src={`${import.meta.env.VITE_API_URL || ''}${candidate.photo_url}`} alt={candidate.name} className="w-full h-full object-cover" />
                          : candidate.name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1">
                        <h3 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">{candidate.name}</h3>
                        <div className="flex flex-wrap gap-3 mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                            <span className="flex items-center gap-1">
                                <Phone size={14} />
                                {candidate.phone}
                            </span>
                            {candidate.email && (
                                <span className="flex items-center gap-1">
                                    <Mail size={14} />
                                    {candidate.email}
                                </span>
                            )}
                            <span className="flex items-center gap-1">
                                <MapPin size={14} />
                                {candidate.source}
                            </span>
                        </div>
                    </div>
                    <div className={`text-center p-4 rounded-xl border-2 ${getScoreColor(match_score)}`}>
                        <div className="text-3xl font-bold">{match_score}%</div>
                        <div className="text-sm">Compatible</div>
                    </div>
                </div>

                {/* Match Breakdown */}
                <div>
                    <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-3 flex items-center gap-2">
                        <Target size={16} />
                        Compatibility Breakdown for {job.title}
                    </h4>
                    <div className="space-y-2">
                        {match_details.map((detail, i) => (
                            <div key={i} className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg">
                                <div className="flex items-center gap-2">
                                    <span className="capitalize font-medium text-zinc-700 dark:text-zinc-300">{detail.factor}</span>
                                    {detail.detail && (
                                        <span className="text-sm text-zinc-500 dark:text-zinc-400">({detail.detail})</span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="w-24 bg-gray-200 rounded-full h-2">
                                        <div
                                            className={`h-2 rounded-full ${parseFloat(detail.score) > 10 ? 'bg-green-500' : parseFloat(detail.score) > 5 ? 'bg-amber-500' : 'bg-red-400'}`}
                                            style={{ width: `${Math.min(100, (parseFloat(detail.score) / 20) * 100)}%` }}
                                        />
                                    </div>
                                    <span className="text-sm font-medium w-12 text-right">
                                        {parseFloat(detail.score).toFixed(0)}pts
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Skills */}
                {candidate.tags && candidate.tags.length > 0 && (
                    <div>
                        <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-3">Skills & Tags</h4>
                        <div className="flex flex-wrap gap-2">
                            {candidate.tags.map((tag, i) => (
                                <span key={i} className="px-3 py-1 bg-primary-100 text-primary-700 rounded-full text-sm font-medium">
                                    {tag}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* CV Preview */}
                <div>
                    <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-3">CV / Documents</h4>
                    <div className="p-4 border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <FileText className="text-primary-500" size={24} />
                            <div>
                                <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                    {candidate.cv_filename || `${candidate.name}_CV.pdf`}
                                </span>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400">Uploaded via {candidate.source}</p>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                size="sm"
                                className="gap-1"
                                onClick={() => {
                                    if (candidate.cv_url) {
                                        window.open(candidate.cv_url, '_blank')
                                    } else {
                                        toast.error('CV not available')
                                    }
                                }}
                            >
                                <Eye size={14} />
                                Preview
                            </Button>
                            <Button
                                variant="secondary"
                                size="sm"
                                className="gap-1"
                                onClick={() => {
                                    if (candidate.cv_url) {
                                        const link = document.createElement('a')
                                        link.href = candidate.cv_url
                                        link.download = candidate.cv_filename || 'cv.pdf'
                                        link.click()
                                    } else {
                                        toast.error('CV not available for download')
                                    }
                                }}
                            >
                                <Download size={14} />
                                Download
                            </Button>
                        </div>
                    </div>
                </div>

                {/* Alternative Jobs Panel */}
                <AlternativeJobsPanel candidateId={candidate.id} currentJobId={job.id} />

                {/* Notes */}
                {candidate.notes && (
                    <div>
                        <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-3">Notes</h4>
                        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                            {candidate.notes}
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="flex justify-end gap-3 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                    <Button variant="secondary" onClick={onClose}>Close</Button>
                    {application_status !== 'certified' && application_status !== 'rejected' && (
                        <>
                            <button
                                onClick={onReject}
                                className="inline-flex items-center gap-1 px-4 py-2 text-sm font-medium rounded-lg text-red-700 bg-red-50 border border-red-200 hover:bg-red-100 transition-colors"
                            >
                                <UserX size={16} />
                                Reject to Pool
                            </button>
                            <Button variant="secondary" onClick={onTransfer} className="gap-1">
                                <ArrowRightLeft size={16} />
                                Transfer to Another Job
                            </Button>
                            <Button onClick={onCertify} className="gap-1">
                                <CheckCircle size={16} />
                                Certify Candidate
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </Modal>
    )
}

// ─── Alternative Jobs Panel ───────────────────────────────────────────────
function AlternativeJobsPanel({ candidateId, currentJobId }) {
    const { data, isLoading } = useQuery({
        queryKey: ['candidate-alternatives', candidateId],
        queryFn: () => apiClient.get(`/api/auto-assign/candidate/${candidateId}/alternatives?threshold=40`).then(r => r.data),
        enabled: !!candidateId
    })

    const alternatives = (data?.alternatives || []).filter(a => a.job_id !== currentJobId).slice(0, 3)

    if (isLoading) return (
        <div>
            <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-3 flex items-center gap-2"><Sparkles size={16}/> Also Suitable For</h4>
            <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-14 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
        </div>
    )

    if (!alternatives.length) return null

    const scoreColor = (s) => s >= 70 ? 'text-green-600 bg-green-50' : s >= 50 ? 'text-amber-600 bg-amber-50' : 'text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900/60'

    return (
        <div>
            <h4 className="font-semibold text-zinc-900 dark:text-zinc-50 mb-3 flex items-center gap-2">
                <Sparkles size={16} className="text-blue-500"/> Also Suitable For
            </h4>
            <div className="space-y-2">
                {alternatives.map(alt => (
                    <div key={alt.job_id} className="flex items-center gap-3 p-3 bg-blue-50/60 border border-blue-100 rounded-xl">
                        <div className="flex-1 min-w-0">
                            <p className="font-medium text-zinc-900 dark:text-zinc-50 text-sm truncate">{alt.job_title}</p>
                            {alt.project_name && <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{alt.project_name}</p>}
                            {alt.reason && <p className="text-xs text-blue-600 mt-0.5">{alt.reason}</p>}
                        </div>
                        <span className={`text-xs font-bold px-2 py-1 rounded-full ${scoreColor(alt.match_score)}`}>
                            {alt.match_score}%
                        </span>
                    </div>
                ))}
            </div>
        </div>
    )
}

function CertifyModal({ data, job, onClose }) {
    const [notes, setNotes] = useState('')
    const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)
    const [notifySMS, setNotifySMS] = useState(false)
    const [notifyEmail, setNotifyEmail] = useState(false)
    const [showPreview, setShowPreview] = useState(false)
    const queryClient = useQueryClient()

    const { candidate } = data

    // Get selected notification channels
    const getChannels = () => {
        const channels = []
        if (notifyWhatsApp) channels.push('whatsapp')
        if (notifySMS) channels.push('sms')
        if (notifyEmail) channels.push('email')
        return channels.length > 0 ? channels : ['whatsapp']
    }

    // Generate automatic message — simple "you've been certified" since the
    // pre-screen date/time is now a separate step.
    const generateMessage = () => {
        const messages = {
            en: `🎉 Dear ${candidate.name},

Congratulations! You have successfully passed our pre-screening process for the position of ${job.title}.

📋 Your Profile Summary:
• Match Score: ${data.match_score}%
• Skills: ${(candidate.tags || []).slice(0, 3).join(', ')}

📅 Next Steps:
1. Our team will contact you shortly to schedule an interview
2. Please keep your documents ready (ID, certificates)
3. Make sure your phone is reachable

If you have any questions, feel free to reply to this message.

Best regards,
Dewan Recruitment Team`,
            si: `🎉 ආදරණීය ${candidate.name},

සුභ පැතුම්! ඔබ ${job.title} තනතුර සඳහා අපගේ පූර්ව පරීක්ෂණය සාර්ථකව සම්පූර්ණ කර ඇත.

📋 ඔබගේ පැතිකඩ සාරාංශය:
• ගැලපුම් ලකුණු: ${data.match_score}%

📅 ඊළඟ පියවර:
1. සම්මුඛ පරීක්ෂණයක් සැලසුම් කිරීමට අපගේ කණ්ඩායම ඔබව ඉක්මනින් සම්බන්ධ කර ගනු ඇත
2. ඔබේ ලේඛන සූදානම්ව තබා ගන්න
3. ඔබේ දුරකථනය ළඟා විය හැකි බව සහතික කරන්න

සුබ පැතුම්,
Dewan Recruitment Team`
        }
        return messages[candidate.preferred_language] || messages.en
    }

    const certifyMutation = useMutation({
        mutationFn: () => {
            return updateApplication(data.application_id, {
                status: 'certified',
                certification_notes: notes,
                notify_channels: getChannels(),
            })
        },
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
            const notif = result?.notification
            const headline = 'Candidate certified'
            if (notif && Array.isArray(notif.failed) && notif.failed.length > 0) {
                // At least one channel failed — show honest partial-failure toast.
                showNotificationToast(notif, headline)
            } else {
                const channelNames = getChannels().map(c => c === 'whatsapp' ? '📱 WhatsApp' : c === 'sms' ? '📲 SMS' : '📧 Email')
                toast.custom((t) => (
                    <div className={`${t.visible ? 'animate-enter' : 'animate-leave'} max-w-md w-full bg-white dark:bg-zinc-900 shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5`}>
                        <div className="flex-1 w-0 p-4">
                            <div className="flex items-start">
                                <div className="flex-shrink-0 pt-0.5">
                                    <div className="h-10 w-10 rounded-full bg-green-100 flex items-center justify-center">
                                        <CheckCircle2 className="h-6 w-6 text-green-600" />
                                    </div>
                                </div>
                                <div className="ml-3 flex-1">
                                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Candidate Certified!</p>
                                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                                        ✅ Status updated{' via ' + channelNames.join(', ')}
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
            }
            onClose()
        },
        onError: (error) => {
            toast.error('Failed to certify: ' + error.message)
        }
    })

    return (
        <Modal open={true} onClose={onClose} title="Certify Candidate" size="lg">
            <div className="space-y-4">
                {/* Success Header */}
                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg border border-green-200">
                    <Award className="text-green-500 mt-0.5 flex-shrink-0" size={24} />
                    <div>
                        <h4 className="font-semibold text-green-800">
                            Certify {candidate.name} for {job.title}
                        </h4>
                        <p className="text-sm text-green-700 mt-1">
                            Match Score: <strong>{data.match_score}%</strong> - This will approve the candidate and send a notification.
                        </p>
                    </div>
                </div>

                {/* Certify is now just the status flip — pre-screening
                    scheduling and interview scheduling are separate steps
                    handled by the Mark Pre-Screened and Schedule Interview
                    buttons that appear after certification. */}
                <div className="p-3 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg border border-zinc-200 dark:border-zinc-800 text-sm text-zinc-600 dark:text-zinc-400">
                    Certifying marks the candidate as approved for pre-screening and sends them a "you've been certified, pre-screen coming next" message. After they attend pre-screen, use <strong>Mark Pre-Screened</strong>; once they've passed, use <strong>Schedule Interview</strong>.
                </div>

                {/* Notification Channels */}
                <div>
                    <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                        <Send size={14} className="inline mr-1" />
                        Notification Channels
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        {/* WhatsApp */}
                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifyWhatsApp ? 'border-green-500 bg-green-50' : 'border-zinc-200 dark:border-zinc-800 hover:border-gray-300'
                            }`}>
                            <input
                                type="checkbox"
                                checked={notifyWhatsApp}
                                onChange={(e) => setNotifyWhatsApp(e.target.checked)}
                                className="sr-only"
                            />
                            <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                                <MessageSquare size={14} className="text-white" />
                            </div>
                            <div className="min-w-0">
                                <span className={`text-sm font-medium block ${notifyWhatsApp ? 'text-green-700' : 'text-zinc-600 dark:text-zinc-400'}`}>
                                    WhatsApp
                                </span>
                                <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{candidate.phone}</p>
                            </div>
                        </label>

                        {/* SMS */}
                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifySMS ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 dark:border-zinc-800 hover:border-gray-300'
                            }`}>
                            <input
                                type="checkbox"
                                checked={notifySMS}
                                onChange={(e) => setNotifySMS(e.target.checked)}
                                className="sr-only"
                            />
                            <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
                                <Smartphone size={14} className="text-white" />
                            </div>
                            <div className="min-w-0">
                                <span className={`text-sm font-medium block ${notifySMS ? 'text-blue-700' : 'text-zinc-600 dark:text-zinc-400'}`}>
                                    SMS
                                </span>
                                <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{candidate.phone}</p>
                            </div>
                        </label>

                        {/* Email */}
                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifyEmail ? 'border-purple-500 bg-purple-50' : 'border-zinc-200 dark:border-zinc-800 hover:border-gray-300'
                            } ${!candidate.email ? 'opacity-50 cursor-not-allowed' : ''}`}>
                            <input
                                type="checkbox"
                                checked={notifyEmail}
                                onChange={(e) => candidate.email && setNotifyEmail(e.target.checked)}
                                className="sr-only"
                                disabled={!candidate.email}
                            />
                            <div className="w-8 h-8 rounded-full bg-purple-500 flex items-center justify-center flex-shrink-0">
                                <MailIcon size={14} className="text-white" />
                            </div>
                            <div className="min-w-0">
                                <span className={`text-sm font-medium block ${notifyEmail ? 'text-purple-700' : 'text-zinc-600 dark:text-zinc-400'}`}>
                                    Email
                                </span>
                                <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate">{candidate.email || 'No email'}</p>
                            </div>
                        </label>
                    </div>
                </div>

                {/* Message Preview */}
                <div>
                    <button
                        type="button"
                        onClick={() => setShowPreview(!showPreview)}
                        className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1 mb-2"
                    >
                        {showPreview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        {showPreview ? 'Hide' : 'Preview'} Auto-Generated Message
                    </button>

                    {showPreview && (
                        <div className="p-4 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg border border-zinc-200 dark:border-zinc-800 relative">
                            <div className="flex items-center gap-2 mb-2">
                                <Sparkles size={14} className="text-amber-500" />
                                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase">
                                    Certification Message
                                </span>
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(generateMessage())
                                        toast.success('Message copied!')
                                    }}
                                    className="ml-auto text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:text-zinc-400"
                                >
                                    <Copy size={14} />
                                </button>
                            </div>
                            <div className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-line bg-white dark:bg-zinc-900 p-3 rounded border border-zinc-100 dark:border-zinc-800/60 max-h-64 overflow-y-auto">
                                {generateMessage()}
                            </div>
                        </div>
                    )}
                </div>

                {/* Internal Notes */}
                <div>
                    <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                        Internal Notes (Optional)
                    </label>
                    <textarea
                        className="input w-full h-20"
                        placeholder="Add any internal notes about this certification..."
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                    />
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                    <Button
                        onClick={() => certifyMutation.mutate()}
                        loading={certifyMutation.isPending}
                        className="gap-2"
                    >
                        <CheckCircle size={16} />
                        Certify & Notify
                    </Button>
                </div>
            </div>
        </Modal>
    )
}

function RejectToPoolModal({ data, job, onClose }) {
    const [reason, setReason] = useState('')
    const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)
    const [notifySMS, setNotifySMS] = useState(false)
    const [showPreview, setShowPreview] = useState(false)
    const queryClient = useQueryClient()

    const { candidate } = data

    const generateMessage = () => {
        const messages = {
            en: `Dear ${candidate.name},

Thank you for your interest in working with Dewan Recruitment.

We have carefully reviewed your profile. Unfortunately, we do not have a position that matches your qualifications at this time.

However, we have added your profile to our talent pool. We will contact you as soon as a suitable opportunity becomes available.

Please keep your contact details up to date so we can reach you.

We wish you all the best!

Best regards,
Dewan Recruitment Team`,
            si: `ආදරණීය ${candidate.name},

Dewan Recruitment සමඟ සේවය කිරීමට ඔබේ උනන්දුවට ස්තුතිය.

අපි ඔබේ පැතිකඩ ප්‍රවේශමෙන් සමාලෝචනය කර ඇත. අවාසනාවකට, මේ වන විට ඔබේ සුදුසුකම්වලට ගැළපෙන තනතුරක් අප සතුව නොමැත.

කෙසේ වෙතත්, ඔබේ පැතිකඩ අපගේ දක්ෂතා එකතුවට එක් කර ඇත. සුදුසු අවස්ථාවක් ලැබුණු වහාම අපි ඔබව සම්බන්ධ කර ගනිමු.

ඔබට සුභ පතනවා!

සුබ පැතුම්,
Dewan Recruitment Team`,
            ta: `அன்புள்ள ${candidate.name},

Dewan Recruitment நிறுவனத்தில் பணிபுரிய உங்கள் ஆர்வத்திற்கு நன்றி.

உங்கள் சுயவிவரத்தை நாங்கள் கவனமாக மதிப்பாய்வு செய்துள்ளோம். துரதிர்ஷ்டவசமாக, இந்த நேரத்தில் உங்கள் தகுதிகளுக்கு பொருந்தக்கூடிய பதவி எங்களிடம் இல்லை.

இருப்பினும், உங்கள் சுயவிவரத்தை எங்கள் திறமை குழுவில் சேர்த்துள்ளோம். பொருத்தமான வாய்ப்பு கிடைத்தவுடன் நாங்கள் உங்களை தொடர்பு கொள்வோம்.

உங்களுக்கு அனைத்து வாழ்த்துக்களும்!

வாழ்த்துக்கள்,
Dewan Recruitment Team`
        }
        return messages[candidate.preferred_language] || messages.en
    }

    const rejectMutation = useMutation({
        mutationFn: () => {
            const channels = []
            if (notifyWhatsApp) channels.push('whatsapp')
            if (notifySMS) channels.push('sms')
            return rejectToPool(data.application_id, {
                rejection_reason: reason || `Not suitable for ${job.title} - moved to general pool`,
                notify_channels: channels.length > 0 ? channels : ['whatsapp']
            })
        },
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
            queryClient.invalidateQueries({ queryKey: ['general-pool'] })
            const notif = result?.notification
            if (notif && Array.isArray(notif.failed) && notif.failed.length > 0) {
                showNotificationToast(notif, `${candidate.name} moved to general pool`)
            } else {
                toast.custom((t) => (
                    <div className={`${t.visible ? 'animate-enter' : 'animate-leave'} max-w-md w-full bg-white dark:bg-zinc-900 shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5`}>
                        <div className="flex-1 w-0 p-4">
                            <div className="flex items-start">
                                <div className="flex-shrink-0 pt-0.5">
                                    <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
                                        <UserX className="h-6 w-6 text-amber-600" />
                                    </div>
                                </div>
                                <div className="ml-3 flex-1">
                                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Moved to General Pool</p>
                                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                                        {candidate.name} has been notified and moved to the general pool for future opportunities.
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
                ), { duration: 4000 })
            }
            onClose()
        },
        onError: (error) => {
            toast.error('Failed to reject: ' + error.message)
        }
    })

    return (
        <Modal open={true} onClose={onClose} title="Move to General Pool" size="md">
            <div className="space-y-4">
                {/* Warning Header */}
                <div className="flex items-start gap-3 p-4 bg-gradient-to-r from-amber-50 to-orange-50 rounded-lg border border-amber-200">
                    <UserX className="text-amber-500 mt-0.5 flex-shrink-0" size={24} />
                    <div>
                        <h4 className="font-semibold text-amber-800">
                            Move {candidate.name} to General Pool
                        </h4>
                        <p className="text-sm text-amber-700 mt-1">
                            This candidate will be removed from <strong>{job.title}</strong> and moved to the general pool for future opportunities. They will be notified automatically.
                        </p>
                    </div>
                </div>

                {/* Rejection Reason */}
                <div>
                    <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                        Reason (Optional)
                    </label>
                    <textarea
                        className="input w-full h-20"
                        placeholder="Why is this candidate being moved to the general pool?"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                    />
                </div>

                {/* Notification Channels */}
                <div>
                    <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                        <Send size={14} className="inline mr-1" />
                        Notify Candidate Via
                    </label>
                    <div className="flex gap-3">
                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all flex-1 ${notifyWhatsApp ? 'border-green-500 bg-green-50' : 'border-zinc-200 dark:border-zinc-800 hover:border-gray-300'
                            }`}>
                            <input
                                type="checkbox"
                                checked={notifyWhatsApp}
                                onChange={(e) => setNotifyWhatsApp(e.target.checked)}
                                className="sr-only"
                            />
                            <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                                <MessageSquare size={14} className="text-white" />
                            </div>
                            <div>
                                <span className={`text-sm font-medium ${notifyWhatsApp ? 'text-green-700' : 'text-zinc-600 dark:text-zinc-400'}`}>WhatsApp</span>
                                <p className="text-xs text-zinc-400 dark:text-zinc-500">{candidate.phone}</p>
                            </div>
                        </label>

                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all flex-1 ${notifySMS ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 dark:border-zinc-800 hover:border-gray-300'
                            }`}>
                            <input
                                type="checkbox"
                                checked={notifySMS}
                                onChange={(e) => setNotifySMS(e.target.checked)}
                                className="sr-only"
                            />
                            <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center flex-shrink-0">
                                <Smartphone size={14} className="text-white" />
                            </div>
                            <div>
                                <span className={`text-sm font-medium ${notifySMS ? 'text-blue-700' : 'text-zinc-600 dark:text-zinc-400'}`}>SMS</span>
                                <p className="text-xs text-zinc-400 dark:text-zinc-500">{candidate.phone}</p>
                            </div>
                        </label>
                    </div>
                </div>

                {/* Message Preview */}
                <div>
                    <button
                        type="button"
                        onClick={() => setShowPreview(!showPreview)}
                        className="text-sm text-primary-600 hover:text-primary-700 flex items-center gap-1 mb-2"
                    >
                        {showPreview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        {showPreview ? 'Hide' : 'Preview'} Notification Message
                    </button>

                    {showPreview && (
                        <div className="p-4 bg-zinc-50 dark:bg-zinc-900/60 rounded-lg border border-zinc-200 dark:border-zinc-800">
                            <div className="flex items-center gap-2 mb-2">
                                <Sparkles size={14} className="text-amber-500" />
                                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase">General Pool Notification</span>
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(generateMessage())
                                        toast.success('Message copied!')
                                    }}
                                    className="ml-auto text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:text-zinc-400"
                                >
                                    <Copy size={14} />
                                </button>
                            </div>
                            <div className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-line bg-white dark:bg-zinc-900 p-3 rounded border border-zinc-100 dark:border-zinc-800/60 max-h-48 overflow-y-auto">
                                {generateMessage()}
                            </div>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                    <button
                        onClick={() => rejectMutation.mutate()}
                        disabled={rejectMutation.isPending}
                        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 transition-colors"
                    >
                        {rejectMutation.isPending ? (
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        ) : (
                            <UserX size={16} />
                        )}
                        Move to Pool & Notify
                    </button>
                </div>
            </div>
        </Modal>
    )
}

function TransferModal({ data, currentJob, onClose }) {
    const [targetJobId, setTargetJobId] = useState('')
    const [reason, setReason] = useState('')
    const queryClient = useQueryClient()

    const { candidate } = data

    const { data: jobsData } = useQuery({
        queryKey: ['jobs', { status: 'active' }],
        queryFn: () => getJobs({ status: 'active' })
    })

    const jobs = (jobsData?.data || []).filter(j => j.id !== currentJob.id)

    const transferMutation = useMutation({
        mutationFn: () => transferApplication(data.application_id, {
            target_job_id: targetJobId,
            transfer_reason: reason
        }),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
            showNotificationToast(result?.notification, `${candidate.name} transferred successfully`)
            onClose()
        },
        onError: (error) => {
            toast.error('Transfer failed: ' + error.message)
        }
    })

    return (
        <Modal open={true} onClose={onClose} title="Transfer Candidate" size="sm">
            <div className="space-y-4">
                <div className="flex items-start gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
                    <ArrowRightLeft className="text-amber-500 mt-0.5" size={20} />
                    <div className="text-sm text-amber-800">
                        Transfer <strong>{candidate.name}</strong> from <strong>{currentJob.title}</strong> to another job position.
                    </div>
                </div>

                <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Target Job</label>
                    <select
                        className="input w-full"
                        value={targetJobId}
                        onChange={(e) => setTargetJobId(e.target.value)}
                    >
                        <option value="">Select a job...</option>
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

                <div className="flex justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                    <Button
                        onClick={() => transferMutation.mutate()}
                        loading={transferMutation.isPending}
                        disabled={!targetJobId}
                        className="gap-1"
                    >
                        <ArrowRightLeft size={16} />
                        Transfer
                    </Button>
                </div>
            </div>
        </Modal>
    )
}

// ──────────────────────────────────────────────────────────────────────────
// MarkPreScreenedModal — records the outcome of the in-person pre-screen
// and transitions certified → pre_screened. The chatbot sends the candidate
// a "you passed pre-screening" WhatsApp via the new pre_screened_passed
// notification template.
// ──────────────────────────────────────────────────────────────────────────
function MarkPreScreenedModal({ data, job, onClose }) {
    const queryClient = useQueryClient()
    const candidate = data.candidate || {}
    const [notes, setNotes] = useState('')
    const [rating, setRating] = useState(0)
    const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)

    const mutation = useMutation({
        mutationFn: () => updateApplication(data.application_id, {
            status: 'pre_screened',
            prescreening_notes: notes || undefined,
            prescreening_rating: rating || undefined,
            notify_channels: notifyWhatsApp ? ['whatsapp'] : [],
        }),
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
            const notif = result?.notification
            if (notif && Array.isArray(notif.failed) && notif.failed.length > 0) {
                showNotificationToast(notif, 'Pre-screen recorded')
            } else {
                toast.success(`${candidate.name} marked as Pre Screened`)
            }
            onClose()
        },
        onError: (err) => toast.error(err?.response?.data?.error || 'Failed to mark pre-screened'),
    })

    return (
        <Modal open onClose={onClose} title="Mark Pre-Screened" size="md">
            <div className="space-y-4">
                <div className="rounded-xl bg-teal-50 dark:bg-teal-950/30 border border-teal-200 dark:border-teal-900/50 p-4 flex items-start gap-3">
                    <CheckCircle2 className="text-teal-600 mt-0.5 flex-shrink-0" size={20} />
                    <div>
                        <h4 className="font-semibold text-teal-800 dark:text-teal-200">
                            Confirm pre-screen for {candidate.name}
                        </h4>
                        <p className="text-sm text-teal-700 dark:text-teal-300 mt-1">
                            Records the outcome of the in-person pre-screen for <strong>{job.title}</strong> and notifies the candidate. After this, you can schedule the formal interview.
                        </p>
                    </div>
                </div>

                <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                        Pre-screen rating (optional, 1–5)
                    </label>
                    <div className="flex gap-2">
                        {[1, 2, 3, 4, 5].map((r) => (
                            <button
                                type="button"
                                key={r}
                                onClick={() => setRating(rating === r ? 0 : r)}
                                className={`h-9 w-9 rounded-lg text-sm font-semibold border ${rating >= r
                                    ? 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700'
                                    : 'bg-white text-zinc-500 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:border-zinc-800'}`}
                            >
                                <Star size={14} className="mx-auto" />
                            </button>
                        ))}
                        {rating > 0 && (
                            <span className="text-sm text-zinc-500 dark:text-zinc-400 self-center ml-2">{rating} / 5</span>
                        )}
                    </div>
                </div>

                <div>
                    <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                        Pre-screen notes (optional)
                    </label>
                    <textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        rows={3}
                        placeholder="What stood out? Any concerns?"
                        className="input w-full"
                    />
                </div>

                <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={notifyWhatsApp}
                        onChange={(e) => setNotifyWhatsApp(e.target.checked)}
                        className="accent-primary-600"
                    />
                    Send "you passed pre-screening" WhatsApp message
                </label>

                <div className="flex justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                    <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
                    <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} className="gap-2 bg-teal-600 hover:bg-teal-700 text-white">
                        <CheckCircle2 size={16} />
                        {mutation.isPending ? 'Saving…' : 'Mark Pre-Screened'}
                    </Button>
                </div>
            </div>
        </Modal>
    )
}

// ──────────────────────────────────────────────────────────────────────────
// ScheduleInterviewModal — creates an interview_schedules row via POST
// /api/interviews. That endpoint already sets application.status to
// interview_scheduled and dispatches the interview-scheduled WhatsApp,
// so we don't need a separate updateApplication call.
// ──────────────────────────────────────────────────────────────────────────
function ScheduleInterviewModal({ data, job, onClose }) {
    const queryClient = useQueryClient()
    const candidate = data.candidate || {}
    const [date, setDate] = useState('')
    const [time, setTime] = useState('')
    const [location, setLocation] = useState('')
    const [duration, setDuration] = useState(30)
    const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)

    const mutation = useMutation({
        mutationFn: async () => {
            if (!date || !time) throw new Error('Date and time are required')
            const scheduledDatetime = `${date}T${time}`
            const channels = []
            if (notifyWhatsApp) channels.push('whatsapp')
            return apiClient.post('/api/interviews', {
                application_id: data.application_id,
                scheduled_datetime: scheduledDatetime,
                location: location || null,
                duration_minutes: Number(duration) || 30,
                notify_channels: channels.length > 0 ? channels : ['whatsapp'],
            }).then((res) => res.data)
        },
        onSuccess: (result) => {
            queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
            queryClient.invalidateQueries({ queryKey: ['interviews'] })
            const notif = result?.notification
            if (notif && Array.isArray(notif.failed) && notif.failed.length > 0) {
                showNotificationToast(notif, 'Interview scheduled')
            } else {
                toast.success(`Interview scheduled for ${candidate.name}`)
            }
            onClose()
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
                            Interview for {candidate.name} — {job.title}
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
