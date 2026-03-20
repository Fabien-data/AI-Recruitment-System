import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
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
import { updateApplication, transferApplication, getJobs, rejectToPool, batchCertifyApplications } from '../api'
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
    const [showTransferModal, setShowTransferModal] = useState(false)
    const [showRejectModal, setShowRejectModal] = useState(false)
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
                    <h2 className="text-xl font-semibold text-gray-900 mb-2">Job Not Found</h2>
                    <p className="text-gray-600 mb-4">The job you're looking for doesn't exist or has been removed.</p>
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
                    className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3"
                >
                    <ArrowLeft size={16} />
                    Back to Jobs
                </Link>
                <div className="flex justify-between items-start">
                    <div>
                        <h1 className="text-3xl font-bold text-gray-900">{job.title}</h1>
                        <div className="flex items-center gap-4 mt-2">
                            <span className="text-gray-600 flex items-center gap-1">
                                <Briefcase size={16} />
                                {job.category}
                            </span>
                            <Badge status={job.status} />
                            <span className="text-gray-600">
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

            {/* Candidates List */}
            <div className="card overflow-hidden">
                <div className="p-4 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
                    <h2 className="font-semibold text-gray-900">
                        Assigned Candidates ({filteredCandidates.length})
                    </h2>
                    {statusFilter && (
                        <Button variant="secondary" size="sm" onClick={() => setStatusFilter('')}>
                            Clear Filter
                        </Button>
                    )}
                </div>

                {filteredCandidates.length === 0 ? (
                    <div className="py-12 text-center text-gray-500">
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
                                onTransfer={() => {
                                    setSelectedCandidate(candidateData)
                                    setShowTransferModal(true)
                                }}
                                onReject={() => {
                                    setSelectedCandidate(candidateData)
                                    setShowRejectModal(true)
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
                    <button onClick={() => setSelectedIds(new Set())} className="text-gray-400 hover:text-white text-sm">
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
                        queryClient.invalidateQueries(['job-candidates', jobId])
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
        </div>
    )
}

function StatCard({ label, value, icon: Icon, color, onClick, active }) {
    const colorClasses = {
        blue: 'bg-blue-50 text-blue-700 border-blue-200',
        green: 'bg-green-50 text-green-700 border-green-200',
        amber: 'bg-amber-50 text-amber-700 border-amber-200',
        purple: 'bg-purple-50 text-purple-700 border-purple-200',
        gray: 'bg-gray-50 text-gray-700 border-gray-200'
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
            toast.success(`${result.certified || candidates.length} candidates certified!`)
            onSuccess()
        },
        onError: (err) => {
            toast.error(err?.response?.data?.error || 'Batch certify failed')
        }
    })

    return (
        <Modal onClose={onClose} title="Batch Certify Candidates">
            <div className="space-y-4">
                <div className="bg-gray-50 rounded-xl p-3 max-h-40 overflow-y-auto">
                    <p className="text-xs font-medium text-gray-500 mb-2">{candidates.length} candidates selected</p>
                    {candidates.map(c => (
                        <div key={c.application_id} className="flex items-center gap-2 py-1 text-sm">
                            <CheckCircle size={12} className="text-green-500 flex-shrink-0" />
                            <span className="font-medium text-gray-800">{c.candidate.name}</span>
                            <span className="text-gray-400">{c.candidate.phone}</span>
                        </div>
                    ))}
                </div>

                <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Pre-Screening (optional)</p>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs text-gray-500 mb-1">Date</label>
                            <input
                                type="date"
                                value={prescreeningDate}
                                onChange={e => setPrescreeningDate(e.target.value)}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-xs text-gray-500 mb-1">Time</label>
                            <input
                                type="time"
                                value={prescreeningTime}
                                onChange={e => setPrescreeningTime(e.target.value)}
                                className="w-full border rounded-lg px-3 py-2 text-sm"
                            />
                        </div>
                    </div>
                    <div className="mt-2">
                        <label className="block text-xs text-gray-500 mb-1">Location</label>
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
                    <label className="block text-xs text-gray-500 mb-1">Notes (optional)</label>
                    <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        placeholder="Internal certification notes..."
                        rows={2}
                        className="w-full border rounded-lg px-3 py-2 text-sm resize-none"
                    />
                </div>

                <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Notify via</p>
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

function CandidateRow({ data, job, isSelected, onToggleSelect, onSelect, onCertify, onTransfer, onReject }) {
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
        <div className={`p-4 hover:bg-gray-50 transition-colors ${isSelected ? 'bg-primary-50' : ''}`}>
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
                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white font-bold text-lg flex-shrink-0">
                            {candidate.name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="font-semibold text-gray-900 truncate">{candidate.name}</h3>
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
                            <div className="flex items-center gap-3 text-sm text-gray-500">
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
                                <span key={i} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                                    {tag}
                                </span>
                            ))}
                            {candidate.tags.length > 4 && (
                                <span className="text-xs text-gray-400">+{candidate.tags.length - 4}</span>
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
                    <p className="text-xs text-gray-500 mt-1">{getScoreLabel(match_score)} Match</p>
                </div>

                {/* Actions */}
                <div className="flex gap-2 flex-shrink-0">
                    <Button variant="secondary" size="sm" onClick={onSelect} className="gap-1">
                        <Eye size={14} />
                        Quick View
                    </Button>
                    {application_status !== 'certified' && application_status !== 'rejected' ? (
                        <>
                            <Button size="sm" onClick={onCertify} className="gap-1">
                                <CheckCircle size={14} />
                                Certify
                            </Button>
                            <Button variant="secondary" size="sm" onClick={onTransfer} className="gap-1">
                                <ArrowRightLeft size={14} />
                                Transfer
                            </Button>
                            <Button variant="danger" size="sm" onClick={onReject} className="gap-1" style={{ backgroundColor: '#ef4444', color: 'white', border: 'none' }}>
                                <UserX size={14} />
                                Reject
                            </Button>
                        </>
                    ) : application_status === 'certified' ? (
                        <span className="text-xs text-green-600 flex items-center gap-1 px-2 font-medium">
                            <CheckCircle2 size={12} />
                            Certified {certified_at && new Date(certified_at).toLocaleDateString()}
                        </span>
                    ) : (
                        <span className="text-xs text-red-500 flex items-center gap-1 px-2">
                            <XCircle size={12} />
                            Moved to Pool
                        </span>
                    )}
                </div>
            </div>
        </div>
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
                    <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-2xl font-bold">
                        {candidate.name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1">
                        <h3 className="text-xl font-bold text-gray-900">{candidate.name}</h3>
                        <div className="flex flex-wrap gap-3 mt-1 text-sm text-gray-600">
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
                    <h4 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                        <Target size={16} />
                        Compatibility Breakdown for {job.title}
                    </h4>
                    <div className="space-y-2">
                        {match_details.map((detail, i) => (
                            <div key={i} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                                <div className="flex items-center gap-2">
                                    <span className="capitalize font-medium text-gray-700">{detail.factor}</span>
                                    {detail.detail && (
                                        <span className="text-sm text-gray-500">({detail.detail})</span>
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
                        <h4 className="font-semibold text-gray-900 mb-3">Skills & Tags</h4>
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
                    <h4 className="font-semibold text-gray-900 mb-3">CV / Documents</h4>
                    <div className="p-4 border border-gray-200 rounded-lg bg-gray-50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <FileText className="text-primary-500" size={24} />
                            <div>
                                <span className="text-sm font-medium text-gray-700">
                                    {candidate.cv_filename || `${candidate.name}_CV.pdf`}
                                </span>
                                <p className="text-xs text-gray-500">Uploaded via {candidate.source}</p>
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
                        <h4 className="font-semibold text-gray-900 mb-3">Notes</h4>
                        <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                            {candidate.notes}
                        </div>
                    </div>
                )}

                {/* Actions */}
                <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
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
            <h4 className="font-semibold text-gray-900 mb-3 flex items-center gap-2"><Sparkles size={16}/> Also Suitable For</h4>
            <div className="space-y-2">{[1,2,3].map(i => <div key={i} className="h-14 animate-pulse rounded-xl bg-gray-100" />)}</div>
        </div>
    )

    if (!alternatives.length) return null

    const scoreColor = (s) => s >= 70 ? 'text-green-600 bg-green-50' : s >= 50 ? 'text-amber-600 bg-amber-50' : 'text-gray-600 bg-gray-50'

    return (
        <div>
            <h4 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Sparkles size={16} className="text-blue-500"/> Also Suitable For
            </h4>
            <div className="space-y-2">
                {alternatives.map(alt => (
                    <div key={alt.job_id} className="flex items-center gap-3 p-3 bg-blue-50/60 border border-blue-100 rounded-xl">
                        <div className="flex-1 min-w-0">
                            <p className="font-medium text-gray-900 text-sm truncate">{alt.job_title}</p>
                            {alt.project_name && <p className="text-xs text-gray-500 truncate">{alt.project_name}</p>}
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
    const [prescreeningDate, setPrescreeningDate] = useState('')
    const [prescreeningTime, setPrescreeningTime] = useState('')
    const [prescreeningLocation, setPrescreeningLocation] = useState('')
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

    const hasPrescreening = prescreeningDate && prescreeningTime && prescreeningLocation

    // Generate automatic message
    const generateMessage = () => {
        const prescreeningDateTimeStr = hasPrescreening
            ? new Date(`${prescreeningDate}T${prescreeningTime}`).toLocaleString('en-US', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            })
            : null

        if (hasPrescreening) {
            const messages = {
                en: `🎉 Dear ${candidate.name},

Congratulations! You have been certified for the position of ${job.title} and are invited for pre-screening!

📅 Pre-Screening Details:
📆 Date & Time: ${prescreeningDateTimeStr}
📍 Location: ${prescreeningLocation}

📋 Please bring the following:
1. Original NIC / Passport
2. Educational certificates
3. Work experience letters
4. Passport-size photographs (2 copies)

⚠️ Please arrive 15 minutes early for registration.

If you need to reschedule, please contact us immediately by replying to this message.

Best regards,
Dewan Recruitment Team`,
                si: `🎉 ආදරණීය ${candidate.name},

සුභ පැතුම්! ඔබ ${job.title} තනතුර සඳහා සහතික කර ඇති අතර පූර්ව පරීක්ෂණය සඳහා ආරාධනා කරනු ලැබේ!

📅 පූර්ව පරීක්ෂණ විස්තර:
📆 දිනය සහ වේලාව: ${prescreeningDateTimeStr}
📍 ස්ථානය: ${prescreeningLocation}

📋 කරුණාකර පහත දෑ රැගෙන එන්න:
1. මුල් හැඳුනුම්පත / විදේශ ගමන් බලපත්‍රය
2. අධ්‍යාපන සහතික
3. රැකියා අත්දැකීම් ලිපි
4. විදේශ ගමන් බලපත්‍ර ප්‍රමාණයේ ඡායාරූප (පිටපත් 2ක්)

⚠️ ලියාපදිංචිය සඳහා මිනිත්තු 15කට පෙර පැමිණෙන්න.

සුබ පැතුම්,
Dewan Recruitment Team`
            }
            return messages[candidate.preferred_language] || messages.en
        }

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
            const payload = {
                status: 'certified',
                certification_notes: notes,
                notify_channels: getChannels()
            }
            if (hasPrescreening) {
                payload.prescreening_datetime = `${prescreeningDate}T${prescreeningTime}`
                payload.prescreening_location = prescreeningLocation
            }
            return updateApplication(data.application_id, payload)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
            const channelNames = getChannels().map(c => c === 'whatsapp' ? '📱 WhatsApp' : c === 'sms' ? '📲 SMS' : '📧 Email')
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
                                    {hasPrescreening ? '📅 Pre-screening invitation sent' : '✅ Status updated'}
                                    {' via ' + channelNames.join(', ')}
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

                {/* Pre-Screening Date/Time/Location */}
                <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <h4 className="font-semibold text-blue-800 mb-3 flex items-center gap-2">
                        <Calendar size={16} />
                        Pre-Screening Schedule (Optional)
                    </h4>
                    <p className="text-xs text-blue-600 mb-3">
                        If you set a date/time, the candidate will receive a specific pre-screening invitation with the details below.
                    </p>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-xs font-medium text-blue-700 mb-1">Date</label>
                            <input
                                type="date"
                                className="input w-full text-sm"
                                value={prescreeningDate}
                                onChange={(e) => setPrescreeningDate(e.target.value)}
                                min={new Date().toISOString().split('T')[0]}
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-blue-700 mb-1">Time</label>
                            <input
                                type="time"
                                className="input w-full text-sm"
                                value={prescreeningTime}
                                onChange={(e) => setPrescreeningTime(e.target.value)}
                            />
                        </div>
                    </div>
                    <div className="mt-3">
                        <label className="block text-xs font-medium text-blue-700 mb-1 flex items-center gap-1">
                            <MapPinned size={12} />
                            Location / Venue
                        </label>
                        <input
                            type="text"
                            className="input w-full text-sm"
                            placeholder="e.g., Dewan Office, 123 Main St, Colombo"
                            value={prescreeningLocation}
                            onChange={(e) => setPrescreeningLocation(e.target.value)}
                        />
                    </div>
                </div>

                {/* Notification Channels */}
                <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                        <Send size={14} className="inline mr-1" />
                        Notification Channels
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        {/* WhatsApp */}
                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifyWhatsApp ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:border-gray-300'
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
                                <span className={`text-sm font-medium block ${notifyWhatsApp ? 'text-green-700' : 'text-gray-600'}`}>
                                    WhatsApp
                                </span>
                                <p className="text-xs text-gray-400 truncate">{candidate.phone}</p>
                            </div>
                        </label>

                        {/* SMS */}
                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifySMS ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
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
                                <span className={`text-sm font-medium block ${notifySMS ? 'text-blue-700' : 'text-gray-600'}`}>
                                    SMS
                                </span>
                                <p className="text-xs text-gray-400 truncate">{candidate.phone}</p>
                            </div>
                        </label>

                        {/* Email */}
                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all ${notifyEmail ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:border-gray-300'
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
                                <span className={`text-sm font-medium block ${notifyEmail ? 'text-purple-700' : 'text-gray-600'}`}>
                                    Email
                                </span>
                                <p className="text-xs text-gray-400 truncate">{candidate.email || 'No email'}</p>
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
                        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 relative">
                            <div className="flex items-center gap-2 mb-2">
                                <Sparkles size={14} className="text-amber-500" />
                                <span className="text-xs font-medium text-gray-500 uppercase">
                                    {hasPrescreening ? 'Pre-Screening Invitation' : 'Certification Message'}
                                </span>
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(generateMessage())
                                        toast.success('Message copied!')
                                    }}
                                    className="ml-auto text-gray-400 hover:text-gray-600"
                                >
                                    <Copy size={14} />
                                </button>
                            </div>
                            <div className="text-sm text-gray-700 whitespace-pre-line bg-white p-3 rounded border border-gray-100 max-h-64 overflow-y-auto">
                                {generateMessage()}
                            </div>
                        </div>
                    )}
                </div>

                {/* Internal Notes */}
                <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
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
                <div className="flex justify-end gap-2 pt-4 border-t border-gray-200">
                    <Button variant="secondary" onClick={onClose}>Cancel</Button>
                    <Button
                        onClick={() => certifyMutation.mutate()}
                        loading={certifyMutation.isPending}
                        className="gap-2"
                    >
                        <CheckCircle size={16} />
                        {hasPrescreening ? 'Certify & Send Invitation' : 'Certify & Notify'}
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
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
            queryClient.invalidateQueries({ queryKey: ['general-pool'] })
            toast.custom((t) => (
                <div className={`${t.visible ? 'animate-enter' : 'animate-leave'} max-w-md w-full bg-white shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5`}>
                    <div className="flex-1 w-0 p-4">
                        <div className="flex items-start">
                            <div className="flex-shrink-0 pt-0.5">
                                <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
                                    <UserX className="h-6 w-6 text-amber-600" />
                                </div>
                            </div>
                            <div className="ml-3 flex-1">
                                <p className="text-sm font-medium text-gray-900">Moved to General Pool</p>
                                <p className="mt-1 text-sm text-gray-500">
                                    {candidate.name} has been notified and moved to the general pool for future opportunities.
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
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
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
                    <label className="block text-sm font-semibold text-gray-700 mb-2">
                        <Send size={14} className="inline mr-1" />
                        Notify Candidate Via
                    </label>
                    <div className="flex gap-3">
                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all flex-1 ${notifyWhatsApp ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:border-gray-300'
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
                                <span className={`text-sm font-medium ${notifyWhatsApp ? 'text-green-700' : 'text-gray-600'}`}>WhatsApp</span>
                                <p className="text-xs text-gray-400">{candidate.phone}</p>
                            </div>
                        </label>

                        <label className={`flex items-center gap-2 p-3 rounded-lg border-2 cursor-pointer transition-all flex-1 ${notifySMS ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
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
                                <span className={`text-sm font-medium ${notifySMS ? 'text-blue-700' : 'text-gray-600'}`}>SMS</span>
                                <p className="text-xs text-gray-400">{candidate.phone}</p>
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
                        <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
                            <div className="flex items-center gap-2 mb-2">
                                <Sparkles size={14} className="text-amber-500" />
                                <span className="text-xs font-medium text-gray-500 uppercase">General Pool Notification</span>
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(generateMessage())
                                        toast.success('Message copied!')
                                    }}
                                    className="ml-auto text-gray-400 hover:text-gray-600"
                                >
                                    <Copy size={14} />
                                </button>
                            </div>
                            <div className="text-sm text-gray-700 whitespace-pre-line bg-white p-3 rounded border border-gray-100 max-h-48 overflow-y-auto">
                                {generateMessage()}
                            </div>
                        </div>
                    )}
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 pt-4 border-t border-gray-200">
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
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['job-candidates'] })
            toast.success(`${candidate.name} transferred successfully`)
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">Target Job</label>
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">Transfer Reason</label>
                    <textarea
                        className="input w-full h-20"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why are you transferring this candidate?"
                    />
                </div>

                <div className="flex justify-end gap-2 pt-4 border-t border-gray-200">
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
