import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { useDropzone } from 'react-dropzone'
import {
  Briefcase, FolderKanban, Plus, Sparkles, UploadCloud, RefreshCw, Loader2,
  Search, MoreHorizontal, Pencil, Trash2, Eye, Users,
} from 'lucide-react'
import { getJobs, extractJobFlyers, refreshJobKnowledgeBase } from '../api'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Card } from '../components/ui/Card'
import { PageHeader } from '../components/ui/PageHeader'
import { CreateJobModal } from '../components/CreateJobModal'
import { EditJobModal } from '../components/EditJobModal'
import { DeleteJobConfirm } from '../components/DeleteJobConfirm'
import { FlyerReviewQueue } from '../components/FlyerReviewQueue'
import { UrgencyPill, URGENCY_OPTIONS } from '../components/jobs/UrgencyPill'
import { DomainPill, DOMAIN_OPTIONS } from '../components/jobs/DomainPill'
import { CountrySelect } from '../components/jobs/CountrySelect'
import { CountryFlag } from '../components/jobs/CountryFlag'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'

const MAX_FLYERS_PER_BATCH = 20

const STATUS_FILTERS = [
  { value: 'active',   label: 'Active' },
  { value: 'future',   label: 'Future' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'complete', label: 'Complete' },
]

const SORT_OPTIONS = [
  { value: 'recent',   label: 'Most recent' },
  { value: 'project',  label: 'By project' },
  { value: 'title',    label: 'By title' },
  { value: 'deadline', label: 'By deadline' },
  { value: 'urgency',  label: 'By urgency' },
]

// useDebouncedValue — simple debounce hook for the search box.
function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export default function Jobs() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin' || user?.role === 'sourcing_department'

  // URL-driven filters — recruiters can share links and the back button works.
  const statusesFromUrl = (searchParams.get('status') || 'active')
    .split(',').map(s => s.trim()).filter(Boolean)
  const urgenciesFromUrl = (searchParams.get('urgency_level') || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const domainFromUrl = searchParams.get('domain') || ''
  const countryCodeFromUrl = searchParams.get('country_code') || ''
  const countryFromUrl = searchParams.get('country') || ''
  const sortFromUrl = searchParams.get('sort') || 'recent'
  const categoryFromUrl = searchParams.get('category') || ''
  const includePending = isAdmin && searchParams.get('include_pending_review') === 'true'

  const [searchInput, setSearchInput] = useState(searchParams.get('q') || '')
  const debouncedSearch = useDebouncedValue(searchInput, 300)

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editJob, setEditJob] = useState(null)
  const [deleteJob, setDeleteJob] = useState(null)
  const [reviewQueue, setReviewQueue] = useState(null) // { files: [{ fileName, extraction }] }

  // Sync debounced search → URL
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    if (debouncedSearch) next.set('q', debouncedSearch)
    else next.delete('q')
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch])

  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams)
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      next.delete(key)
    } else {
      next.set(key, Array.isArray(value) ? value.join(',') : value)
    }
    setSearchParams(next, { replace: true })
  }

  const toggleStatus = (value) => {
    const set = new Set(statusesFromUrl)
    if (set.has(value)) set.delete(value)
    else set.add(value)
    setParam('status', Array.from(set))
  }
  const toggleUrgency = (value) => {
    const set = new Set(urgenciesFromUrl)
    if (set.has(value)) set.delete(value)
    else set.add(value)
    setParam('urgency_level', Array.from(set))
  }

  const queryParams = {
    status: statusesFromUrl.join(',') || undefined,
    urgency_level: urgenciesFromUrl.length ? urgenciesFromUrl.join(',') : undefined,
    domain: domainFromUrl || undefined,
    country_code: countryCodeFromUrl || undefined,
    country: countryFromUrl || undefined,
    category: categoryFromUrl || undefined,
    q: debouncedSearch || undefined,
    sort: sortFromUrl,
    include_pending_review: includePending ? 'true' : undefined,
  }

  const { data, isLoading } = useQuery({
    queryKey: ['jobs', queryParams],
    queryFn: () => getJobs(queryParams),
  })

  const refreshMutation = useMutation({
    mutationFn: refreshJobKnowledgeBase,
    onSuccess: (result) => toast.success(`Knowledge base refreshed for ${result.total || 0} active jobs`),
    onError: () => toast.error('Failed to refresh knowledge base'),
  })

  // ── AI ingestion: extract first, then open review queue ───────────────────
  const [uploadState, setUploadState] = useState({ isProcessing: false, filenames: [] })

  const handleFlyerUpload = useCallback(async (acceptedFiles) => {
    if (!acceptedFiles?.length) return
    const filenames = acceptedFiles.map((file) => file.name)
    setUploadState({ isProcessing: true, filenames })

    const formData = new FormData()
    acceptedFiles.forEach((file) => formData.append('flyer', file))

    try {
      const result = await extractJobFlyers(formData)
      setUploadState({ isProcessing: false, filenames })
      // Pass the original File objects too so the review modal can show
      // a thumbnail of the source flyer next to the extracted fields.
      const fileMap = new Map(acceptedFiles.map((f) => [f.name, f]))
      const filesWithBlobs = (result.files || []).map((f) => ({
        ...f,
        sourceFile: fileMap.get(f.fileName),
      }))
      setReviewQueue({ files: filesWithBlobs, failures: result.failures || [] })
      if ((result.failures || []).length > 0) {
        toast.error(`${result.failures.length} flyer(s) could not be parsed`)
      }
    } catch (error) {
      setUploadState((prev) => ({ ...prev, isProcessing: false }))
      toast.error(error.response?.data?.error || 'Failed to extract flyer')
    }
  }, [])

  const handleDropRejected = useCallback((rejections) => {
    if (!rejections?.length) return
    const tooMany = rejections.some((item) => item.errors?.some((e) => e.code === 'too-many-files'))
    if (tooMany) {
      toast.error(`You can upload up to ${MAX_FLYERS_PER_BATCH} flyers at once.`)
      return
    }
    toast.error('Some files were rejected. Please upload image files only (JPG, PNG, WEBP).')
  }, [])

  const { getRootProps, getInputProps, isDragActive, open: openDropzone } = useDropzone({
    onDrop: handleFlyerUpload,
    onDropRejected: handleDropRejected,
    accept: { 'image/*': ['.jpeg', '.jpg', '.png', '.webp'] },
    multiple: true,
    maxFiles: MAX_FLYERS_PER_BATCH,
    noClick: true,
    noKeyboard: true,
  })

  const jobsList = data?.data || []

  const onReviewQueueDone = () => {
    setReviewQueue(null)
    queryClient.invalidateQueries({ queryKey: ['jobs'] })
    queryClient.invalidateQueries({ queryKey: ['projects'] })
  }

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={Briefcase}
        tone="blue"
        title="Jobs"
        subtitle="View and manage job listings. Drop a flyer to AI-extract roles; you review each one before it goes live."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => refreshMutation.mutate()}
              loading={refreshMutation.isPending}
            >
              {!refreshMutation.isPending && <RefreshCw size={16} />}
              Refresh Knowledge Base
            </Button>
            <Button variant="secondary" onClick={() => setIsCreateModalOpen(true)}>
              <Plus size={16} />
              Create Job Manually
            </Button>
            <Button variant="primary" onClick={openDropzone}>
              <Sparkles size={16} />
              Magic Create Flyers
            </Button>
          </>
        }
      />

      <Card className="mb-6 overflow-hidden">
        <div
          {...getRootProps()}
          className={`group relative rounded-3xl border border-dashed p-6 md:p-8 transition-all duration-300 ${
            isDragActive
              ? 'border-zinc-900 bg-zinc-50'
              : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 hover:border-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/40/70'
          }`}
        >
          <input {...getInputProps()} />
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white">
                <Sparkles size={12} />
                AI ingestion
              </div>
              <h2 className="mt-4 text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                Magic Create from job flyers
              </h2>
              <p className="mt-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                Upload one or many posters, social images, or flyers. The AI extracts each role.
                You review every job (filling country, domain, salary, project) before it saves —
                nothing reaches the chatbot until you click Save.
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1 font-medium">Review queue</span>
                <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1 font-medium">Required-field guard</span>
                <span className="rounded-full bg-zinc-100 dark:bg-zinc-800 px-3 py-1 font-medium">Pick or create project per file</span>
              </div>
            </div>

            <div className="flex flex-col items-start gap-3 lg:items-end">
              <div className="flex items-center gap-3 rounded-3xl bg-zinc-950 px-4 py-3 text-white shadow-lg">
                <div className="rounded-2xl bg-white/10 p-2">
                  <UploadCloud size={18} />
                </div>
                <div>
                  <p className="text-sm font-semibold">Drop files here</p>
                  <p className="text-xs text-zinc-300">JPG, PNG, or WEBP. Up to {MAX_FLYERS_PER_BATCH} files per batch.</p>
                </div>
              </div>
              <Button variant="secondary" onClick={openDropzone}>Choose files</Button>
            </div>
          </div>

          {uploadState.isProcessing && (
            <div className="absolute inset-0 flex items-center justify-center rounded-3xl bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm">
              <div className="flex items-center gap-3 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-4 py-3 shadow-lg">
                <Loader2 className="h-5 w-5 animate-spin text-zinc-900 dark:text-zinc-100" />
                <div>
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">AI is analyzing the flyer</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">Opening review queue when ready…</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Filters */}
      <div className="card mb-6 space-y-4">
        {/* Row 1: search + sort */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              type="text"
              placeholder="Search jobs by title, category, project or location"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="input pl-9"
            />
          </div>
          <div className="sm:w-56">
            <select
              value={sortFromUrl}
              onChange={(e) => setParam('sort', e.target.value)}
              className="input w-full"
              aria-label="Sort jobs"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>Sort: {opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Row 2: status pills */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Status</span>
          {STATUS_FILTERS.map((s) => {
            const active = statusesFromUrl.includes(s.value)
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => toggleStatus(s.value)}
                className={`rounded-full border px-3 py-1 text-sm transition ${
                  active
                    ? 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                    : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700 dark:hover:bg-zinc-800'
                }`}
              >
                {s.label}
              </button>
            )
          })}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setParam('include_pending_review', includePending ? '' : 'true')}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                includePending
                  ? 'bg-amber-500 text-white border-amber-500'
                  : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700 dark:hover:bg-zinc-800'
              }`}
              title="Admin only — include AI-ingested jobs awaiting agent review"
            >
              Pending Review
            </button>
          )}
        </div>

        {/* Row 3: urgency pills */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Urgency</span>
          {URGENCY_OPTIONS.map((opt) => {
            const active = urgenciesFromUrl.includes(opt.value)
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleUrgency(opt.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  active
                    ? 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                    : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700 dark:hover:bg-zinc-800'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>

        {/* Row 4: region / country / category */}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">Domain</label>
            <select
              value={domainFromUrl}
              onChange={(e) => setParam('domain', e.target.value)}
              className="input w-full"
            >
              {DOMAIN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">Country</label>
            <CountrySelect
              value={countryCodeFromUrl || countryFromUrl}
              onChange={(c) => {
                if (!c) {
                  setParam('country_code', '')
                  setParam('country', '')
                } else {
                  setParam('country_code', c.code)
                  setParam('country', '')
                }
              }}
              placeholder="Any country"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1">Category</label>
            <input
              type="text"
              placeholder="e.g. security, hospitality"
              value={categoryFromUrl}
              onChange={(e) => setParam('category', e.target.value)}
              className="input w-full"
            />
          </div>
        </div>

        {(statusesFromUrl.length > 0 || urgenciesFromUrl.length > 0 || domainFromUrl || countryCodeFromUrl || categoryFromUrl || debouncedSearch || sortFromUrl !== 'recent') && (
          <div className="flex justify-end">
            <button
              type="button"
              className="text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 underline-offset-2 hover:underline"
              onClick={() => {
                setSearchParams({ status: 'active' }, { replace: true })
                setSearchInput('')
              }}
            >
              Reset filters
            </button>
          </div>
        )}
      </div>

      {/* Jobs List */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : jobsList.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 dark:text-zinc-400">
            <Briefcase className="mx-auto h-12 w-12 text-zinc-300 dark:text-zinc-600 mb-2" aria-hidden />
            <p className="font-medium">No jobs found</p>
            <p className="text-sm mt-1">Adjust your filters or create a new job.</p>
            <div className="mt-4 flex justify-center">
              <Button variant="primary" onClick={() => setIsCreateModalOpen(true)}>
                <Plus size={16} />
                Create Job Manually
              </Button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60">
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Title</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Category</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Project</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Region</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Positions</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-zinc-700 dark:text-zinc-300">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobsList.map((job) => (
                  <tr key={job.id} className="border-b border-zinc-100 dark:border-zinc-800/60 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
                    <td className="py-3 px-4 font-medium text-zinc-900 dark:text-zinc-50">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{job.title}</span>
                        <UrgencyPill level={job.urgency_level} />
                      </div>
                    </td>
                    <td className="py-3 px-4 text-zinc-600 dark:text-zinc-400">{job.category}</td>
                    <td className="py-3 px-4">
                      {job.project_title ? (
                        <Link
                          to={`/projects/${job.project_id}`}
                          className="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400"
                        >
                          <FolderKanban size={14} />
                          <span>{job.project_title}</span>
                        </Link>
                      ) : (
                        <span className="text-zinc-400 dark:text-zinc-500 text-sm">-</span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex flex-col gap-1">
                        <DomainPill domain={job.domain} />
                        {(job.country || job.country_code) && (
                          <CountryFlag code={job.country_code} name={job.country} />
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <Badge status={job.status} />
                    </td>
                    <td className="py-3 px-4 text-zinc-600 dark:text-zinc-400">
                      {(job.positions_filled ?? 0)} / {job.positions_available ?? 1}
                    </td>
                    <td className="py-3 px-4">
                      <RowActions
                        job={job}
                        isAdmin={isAdmin}
                        onEdit={() => setEditJob(job)}
                        onDelete={() => setDeleteJob(job)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateJobModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
      />
      {editJob && (
        <EditJobModal
          isOpen={!!editJob}
          job={editJob}
          onClose={() => setEditJob(null)}
        />
      )}
      {deleteJob && (
        <DeleteJobConfirm
          isOpen={!!deleteJob}
          job={deleteJob}
          onClose={() => setDeleteJob(null)}
        />
      )}
      {reviewQueue && (
        <FlyerReviewQueue
          files={reviewQueue.files}
          onClose={onReviewQueueDone}
        />
      )}
    </div>
  )
}

// Per-row action menu (popover): Details, View Candidates, Edit, Delete (admin only).
function RowActions({ job, isAdmin, onEdit, onDelete }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Actions <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900 py-1">
          <MenuLink to={`/jobs/${job.id}`} icon={Eye} label="Details" />
          <MenuLink to={`/jobs/${job.id}/candidates`} icon={Users} label="View Candidates" />
          <MenuButton icon={Pencil} label="Edit" onClick={() => { setOpen(false); onEdit() }} />
          {isAdmin && (
            <MenuButton icon={Trash2} label="Delete" tone="danger" onClick={() => { setOpen(false); onDelete() }} />
          )}
        </div>
      )}
    </div>
  )
}

function MenuLink({ to, icon: Icon, label }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
    >
      <Icon size={14} /> {label}
    </Link>
  )
}

function MenuButton({ icon: Icon, label, onClick, tone }) {
  const danger = tone === 'danger'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
        danger ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-700 dark:text-zinc-300'
      }`}
    >
      <Icon size={14} /> {label}
    </button>
  )
}
