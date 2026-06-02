import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  getCandidates, createCandidate, getDuplicateCandidates,
  mergeCandidates, getProjects, deleteCandidate, getJobs,
} from '../api'
import {
  Search, Plus, Users, GitMerge, AlertTriangle,
  ArrowUpDown, ArrowUp, ArrowDown, Pencil, Trash2, Eye,
  Briefcase, FolderKanban,
} from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Modal, ConfirmModal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { PageHeader } from '../components/ui/PageHeader'
import { CandidateReviewModal } from '../components/CandidateReviewModal'
import { EditCandidateModal } from '../components/EditCandidateModal'
import { SourceBadge } from '../components/SourceBadge'
import { useRole } from '../stores/authStore'
import toast from 'react-hot-toast'

const DEBOUNCE_MS = 300

const SORT_OPTIONS = [
  { value: 'created_at',    label: 'Date Added' },
  { value: 'name',          label: 'Name' },
  { value: 'job_title',     label: 'Job Applied' },
  { value: 'project_title', label: 'Project' },
  { value: 'status',        label: 'Status' },
]

export default function Candidates() {
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [language, setLanguage] = useState('')
  const [projectIds, setProjectIds] = useState([])
  const [jobId, setJobId] = useState('')
  const [sortBy, setSortBy] = useState('created_at')
  const [sortOrder, setSortOrder] = useState('desc')
  const [modalOpen, setModalOpen] = useState(false)
  const [reviewCandidateId, setReviewCandidateId] = useState(null)
  const [editCandidate, setEditCandidate] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [form, setForm] = useState({ name: '', phone: '', email: '', age: '', source: 'web', preferred_language: 'en', notes: '' })
  const [showDuplicates, setShowDuplicates] = useState(false)

  const queryClient = useQueryClient()
  const { canDeleteCandidate } = useRole()

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [searchInput])

  // Reset to page 1 when filters/sort change
  useEffect(() => { setPage(1) }, [search, status, language, projectIds, jobId, sortBy, sortOrder])

  const { data, isLoading } = useQuery({
    queryKey: ['candidates', { page, search, status, language, projectIds, jobId, sortBy, sortOrder }],
    queryFn: () =>
      getCandidates({
        page,
        search,
        status,
        language: language || undefined,
        project_ids: projectIds.length ? projectIds.join(',') : undefined,
        job_id: jobId || undefined,
        sort_by: sortBy,
        sort_order: sortOrder,
      })
  })

  const { data: activeProjectsData } = useQuery({
    queryKey: ['projects', 'active', 'candidate-filter'],
    queryFn: () => getProjects({ page: 1, limit: 200, status: 'active' }),
  })

  const { data: activeJobsData } = useQuery({
    queryKey: ['jobs', 'active', 'candidate-filter'],
    queryFn: () => getJobs({ page: 1, limit: 500, status: 'active' }),
  })

  const { data: duplicatesData = [], isLoading: duplicatesLoading, refetch: refetchDuplicates } = useQuery({
    queryKey: ['candidate-duplicates'],
    queryFn: getDuplicateCandidates,
    enabled: showDuplicates
  })

  const mergeMutation = useMutation({
    mutationFn: ({ keep_id, merge_id }) => mergeCandidates({ keep_id, merge_id }),
    onSuccess: () => {
      toast.success('Candidates merged')
      refetchDuplicates()
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Merge failed')
  })

  const createMutation = useMutation({
    mutationFn: createCandidate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      setModalOpen(false)
      setForm({ name: '', phone: '', email: '', age: '', source: 'web', preferred_language: 'en', notes: '' })
      toast.success('Candidate added')
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || 'Failed to add candidate')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteCandidate(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      toast.success('Candidate deleted')
      setDeleteTarget(null)
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Delete failed'),
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.name?.trim() || !form.phone?.trim()) {
      toast.error('Name and phone are required')
      return
    }
    const payload = {
      ...form,
      age: form.age === '' ? undefined : Number.parseInt(form.age, 10),
    }
    createMutation.mutate(payload)
  }

  const handleProjectFilterChange = (e) => {
    const values = Array.from(e.target.selectedOptions).map((opt) => opt.value)
    setProjectIds(values)
  }

  /** Toggle sort column or flip its direction. */
  const handleSortClick = (col) => {
    if (sortBy === col) {
      setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(col)
      // Sensible defaults: text columns asc, dates/status desc
      setSortOrder(['name', 'job_title', 'project_title'].includes(col) ? 'asc' : 'desc')
    }
  }

  const sortIcon = (col) => {
    if (sortBy !== col) return <ArrowUpDown size={12} className="opacity-40" />
    return sortOrder === 'asc'
      ? <ArrowUp size={12} className="text-primary-600 dark:text-primary-400" />
      : <ArrowDown size={12} className="text-primary-600 dark:text-primary-400" />
  }

  const candidatesList = data?.data || []
  const pagination = data?.pagination
  const activeProjects = activeProjectsData?.data || []
  const activeJobs = activeJobsData?.data || []

  const clearAdvancedFilters = () => {
    setStatus('')
    setLanguage('')
    setProjectIds([])
    setJobId('')
    setSortBy('created_at')
    setSortOrder('desc')
  }

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={Users}
        tone="blue"
        title="Candidates"
        subtitle="Manage and track all candidates"
        actions={
          <Button variant="primary" onClick={() => setModalOpen(true)}>
            <Plus size={18} aria-hidden />
            Add Candidate
          </Button>
        }
      />

      {/* Filters card */}
      <div className="card mb-6">
        <div className="grid gap-3 md:grid-cols-12">
          {/* Search */}
          <div className="md:col-span-5 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" size={18} aria-hidden />
            <input
              type="text"
              placeholder="Search by name or phone…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="input pl-10"
              aria-label="Search candidates"
            />
          </div>

          {/* Sort */}
          <div className="md:col-span-4 flex gap-2">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="input flex-1"
              aria-label="Sort candidates by"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>Sort by {opt.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
              className="input w-12 flex items-center justify-center hover:bg-zinc-50 dark:hover:bg-zinc-700"
              aria-label={`Sort ${sortOrder === 'asc' ? 'ascending' : 'descending'}`}
              title={sortOrder === 'asc' ? 'Ascending' : 'Descending'}
            >
              {sortOrder === 'asc' ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            </button>
          </div>

          {/* Status */}
          <div className="md:col-span-3">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="input"
              aria-label="Filter by status"
            >
              <option value="">All Status</option>
              <option value="new">New</option>
              <option value="screening">Screening</option>
              <option value="interview">Interview</option>
              <option value="hired">Hired</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>

          {/* Job filter */}
          <div className="md:col-span-4">
            <select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              className="input"
              aria-label="Filter by job"
            >
              <option value="">All Jobs</option>
              {activeJobs.map((job) => (
                <option key={job.id} value={job.id}>{job.title}</option>
              ))}
            </select>
          </div>

          {/* Project filter. The tall multi-select rendered as an empty box
              between the Job and Language filters when no active projects
              existed (B009) — show a placeholder option instead. */}
          <div className="md:col-span-5">
            <select
              value={projectIds}
              multiple
              onChange={handleProjectFilterChange}
              className="input h-24"
              aria-label="Filter by ongoing projects"
              disabled={activeProjects.length === 0}
            >
              {activeProjects.length === 0 ? (
                <option disabled>No active projects</option>
              ) : (
                activeProjects.map((project) => (
                  <option key={project.id} value={project.id}>{project.title}</option>
                ))
              )}
            </select>
          </div>

          {/* Language */}
          <div className="md:col-span-3 flex gap-2">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="input flex-1"
              aria-label="Filter by language"
            >
              <option value="">All Languages</option>
              <option value="en">English</option>
              <option value="si">Sinhala</option>
              <option value="ta">Tamil</option>
            </select>
            <button
              type="button"
              onClick={clearAdvancedFilters}
              className="px-3 text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              title="Clear filters"
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={8} cols={7} />
        ) : candidatesList.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 dark:text-zinc-400">
            <Users className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600 mb-2" aria-hidden />
            <p className="font-medium">No candidates found</p>
            <p className="text-sm mt-1">Add a candidate or adjust your filters.</p>
            <Button variant="primary" className="mt-4" onClick={() => setModalOpen(true)}>
              Add Candidate
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto -mx-5">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40">
                    <SortableTh label="Name"     col="name"          sortIcon={sortIcon} onClick={handleSortClick} />
                    <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Contact</th>
                    <SortableTh label="Job"      col="job_title"     sortIcon={sortIcon} onClick={handleSortClick} />
                    <SortableTh label="Project"  col="project_title" sortIcon={sortIcon} onClick={handleSortClick} />
                    <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Source</th>
                    <SortableTh label="Status"   col="status"        sortIcon={sortIcon} onClick={handleSortClick} />
                    <th className="text-right py-3 px-4 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {candidatesList.map((candidate) => (
                    <tr
                      key={candidate.id}
                      className="border-b border-zinc-100 dark:border-zinc-800/60 hover:bg-primary-50/40 dark:hover:bg-primary-950/20 transition-colors cursor-pointer group"
                      onClick={() => setReviewCandidateId(candidate.id)}
                    >
                      {/* Name + avatar */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-3 min-w-0">
                          <CandidateAvatar name={candidate.name} />
                          <div className="min-w-0">
                            <div className="font-semibold text-zinc-900 dark:text-zinc-50 truncate">
                              {candidate.name || 'Unknown'}
                            </div>
                            {candidate.age != null && (
                              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                                {candidate.age} years
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Contact */}
                      <td className="py-3 px-4 text-sm">
                        <div className="text-zinc-700 dark:text-zinc-300 truncate">{candidate.phone || '—'}</div>
                        {candidate.email && (
                          <div className="text-xs text-zinc-500 dark:text-zinc-500 truncate">{candidate.email}</div>
                        )}
                      </td>

                      {/* Job */}
                      <td className="py-3 px-4 text-sm">
                        {candidate.latest_job_title ? (
                          <div className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300 max-w-[200px]">
                            <Briefcase size={13} className="text-primary-500 shrink-0" />
                            <span className="truncate">{candidate.latest_job_title}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-400 dark:text-zinc-600 italic">—</span>
                        )}
                      </td>

                      {/* Project */}
                      <td className="py-3 px-4 text-sm">
                        {candidate.latest_project_title ? (
                          <div className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300 max-w-[180px]">
                            <FolderKanban size={13} className="text-violet-500 shrink-0" />
                            <span className="truncate">{candidate.latest_project_title}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-400 dark:text-zinc-600 italic">—</span>
                        )}
                      </td>

                      {/* Source */}
                      <td className="py-3 px-4">
                        <SourceBadge source={candidate.source} />
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        <Badge status={candidate.status} />
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                          <Link
                            to={`/candidates/${candidate.id}`}
                            className="p-2 rounded-lg text-zinc-500 hover:text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-950/40 dark:text-zinc-400 dark:hover:text-primary-300 transition-colors"
                            title="View details"
                          >
                            <Eye size={16} />
                          </Link>
                          <button
                            type="button"
                            onClick={() => setEditCandidate(candidate)}
                            className="p-2 rounded-lg text-zinc-500 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/40 dark:text-zinc-400 dark:hover:text-amber-300 transition-colors"
                            title="Edit candidate"
                          >
                            <Pencil size={16} />
                          </button>
                          {canDeleteCandidate && (
                            <button
                              type="button"
                              onClick={() => setDeleteTarget(candidate)}
                              className="p-2 rounded-lg text-zinc-500 hover:text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-950/40 dark:text-zinc-400 dark:hover:text-accent-300 transition-colors"
                              title="Delete candidate"
                            >
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pagination && (
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mt-6 pt-4 border-t border-zinc-200 dark:border-zinc-800">
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Showing {candidatesList.length} of {pagination.total} candidates
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page >= pagination.totalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Duplicate Detection Section */}
      <div className="card mt-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
            <GitMerge size={18} />
            Duplicate Detection
          </h2>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { setShowDuplicates(true); refetchDuplicates() }}
          >
            Scan for Duplicates
          </Button>
        </div>
        {showDuplicates && (
          duplicatesLoading ? (
            <p className="text-sm text-zinc-400 dark:text-zinc-500">Scanning…</p>
          ) : duplicatesData.length === 0 ? (
            <div className="py-6 text-center text-zinc-500 dark:text-zinc-400">
              <Users className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600 mb-2" />
              <p className="text-sm">No duplicate candidates found</p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">{duplicatesData.length} potential duplicate pair{duplicatesData.length !== 1 ? 's' : ''} found</p>
              {duplicatesData.map((pair, i) => (
                <div key={i} className="border border-orange-200 bg-orange-50 dark:border-orange-900/50 dark:bg-orange-950/30 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3 text-sm font-medium text-orange-700 dark:text-orange-300">
                    <AlertTriangle size={14} />
                    {pair.confidence}% confidence match
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div className="bg-white dark:bg-zinc-900 rounded-lg p-3 border border-zinc-200 dark:border-zinc-800">
                      <p className="font-semibold text-zinc-900 dark:text-zinc-50">{pair.candidate1?.name}</p>
                      <p className="text-zinc-500 dark:text-zinc-400">{pair.candidate1?.phone}</p>
                      <p className="text-zinc-500 dark:text-zinc-400">{pair.candidate1?.email || '—'}</p>
                    </div>
                    <div className="bg-white dark:bg-zinc-900 rounded-lg p-3 border border-zinc-200 dark:border-zinc-800">
                      <p className="font-semibold text-zinc-900 dark:text-zinc-50">{pair.candidate2?.name}</p>
                      <p className="text-zinc-500 dark:text-zinc-400">{pair.candidate2?.phone}</p>
                      <p className="text-zinc-500 dark:text-zinc-400">{pair.candidate2?.email || '—'}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3 justify-end">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => mergeMutation.mutate({ keep_id: pair.candidate1.id, merge_id: pair.candidate2.id })}
                      disabled={mergeMutation.isPending}
                    >
                      Keep Left, Merge Right
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => mergeMutation.mutate({ keep_id: pair.candidate2.id, merge_id: pair.candidate1.id })}
                      disabled={mergeMutation.isPending}
                    >
                      Keep Right, Merge Left
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>

      {/* Add Candidate modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add Candidate" size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Name"
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Full name"
          />
          <Input
            label="Phone"
            required
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            placeholder="Phone number"
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="email@example.com"
          />
          <Input
            label="Age"
            type="number"
            min="1"
            max="120"
            value={form.age}
            onChange={(e) => setForm((f) => ({ ...f, age: e.target.value }))}
            placeholder="Candidate age"
          />
          <div>
            <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight">Source</label>
            <select
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
              className="input"
            >
              <option value="web">Web</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="messenger">Messenger</option>
              <option value="email">Email</option>
              <option value="walkin">Walk-in</option>
              <option value="phone">Phone</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={createMutation.isPending}>
              Add Candidate
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Candidate modal */}
      <EditCandidateModal
        candidate={editCandidate}
        open={!!editCandidate}
        onClose={() => setEditCandidate(null)}
      />

      {/* Delete confirmation */}
      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        title="Delete candidate?"
        message={`This will permanently remove ${deleteTarget?.name || 'this candidate'} and all related records. This action cannot be undone.`}
        loading={deleteMutation.isPending}
        danger
      />

      {/* Candidate Review Modal — opens on row click */}
      <CandidateReviewModal
        candidateId={reviewCandidateId}
        open={!!reviewCandidateId}
        onClose={() => setReviewCandidateId(null)}
      />
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function SortableTh({ label, col, sortIcon, onClick }) {
  return (
    <th className="text-left py-3 px-4 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      <button
        type="button"
        onClick={() => onClick(col)}
        className="inline-flex items-center gap-1.5 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
      >
        {label}
        {sortIcon(col)}
      </button>
    </th>
  )
}

const AVATAR_COLORS = [
  'bg-indigo-500', 'bg-violet-500', 'bg-sky-500',
  'bg-emerald-500', 'bg-rose-500', 'bg-amber-500', 'bg-pink-500', 'bg-cyan-500',
]

function getInitials(name = '') {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'
}

function avatarColor(name = '') {
  const code = [...name].reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[code % AVATAR_COLORS.length]
}

function CandidateAvatar({ name }) {
  return (
    <div
      className={`${avatarColor(name)} w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 ring-2 ring-white dark:ring-zinc-900 shadow-sm`}
    >
      {getInitials(name)}
    </div>
  )
}
