import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  getApplications, getJobs, getProjects, apiClient, getInterviewers,
  previewInterviewAllocation, bulkScheduleInterviews,
  updateApplication, rejectToPool, batchCertifyApplications, batchRejectToPool,
  getCandidate, getPendingInterviewSends, downloadUnreachableCsv, setCandidateStage,
  getApplicationStatusTotals,
} from '../api'
import {
  CalendarDays, FileText, FolderKanban, Briefcase, ListFilter, Plus,
  MoreHorizontal, Eye, Pencil, ArrowRightLeft, Trash2, User,
  ChevronDown, ChevronRight, Send, MapPinned, X, Clock,
  Search, ArrowDownWideNarrow, ChevronsDownUp, ChevronsUpDown,
  Inbox, Check, Archive, Star, Phone, Loader2, Upload, ListChecks, RotateCcw, AlertTriangle,
  MessageSquare,
} from 'lucide-react'
import { DEFAULT_INTERVIEW_MESSAGE, DEFAULT_INTERVIEW_MESSAGE_KEY } from '../constants/interviewMessage'
import { Modal } from '../components/ui/Modal'
import { showNotificationToast, showErrorToast } from '../utils/notificationToast'
import toast from 'react-hot-toast'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { TableSkeleton } from '../components/ui/Skeleton'
import { PageHeader } from '../components/ui/PageHeader'
import { Table } from '../components/ui/Table'
import { EmptyState } from '../components/ui/EmptyState'
import { Pagination } from '../components/ui/Pagination'
import { CreateApplicationModal } from '../components/applications/CreateApplicationModal'
import { EditApplicationModal } from '../components/applications/EditApplicationModal'
import { DeleteApplicationConfirm } from '../components/applications/DeleteApplicationConfirm'
import { TransferApplicationModal } from '../components/applications/TransferApplicationModal'
import { useAuthStore } from '../stores/authStore'
import { useViewMode, ViewToggle } from '../components/ui/ViewToggle'
import { CVReviewModal } from './CVManager'
import SavedViews from '../components/SavedViews'
import { DocumentPreview } from '../components/documents/DocumentPreview'
import { getDocumentCategory } from '../utils/documents'
import { STATUS_FILTER_OPTIONS, normalizeStatus, STATUS_LABELS, STATUS_COLORS } from '../constants/lifecycle'
import { useRealtime } from '../hooks/useRealtime'

// How many collapsed project rows to show per page of the project list.
const PROJECTS_PER_PAGE = 15

// Live-update triggers: another agent (or the chatbot) creating/accepting/
// rejecting/transferring an application broadcasts one of these — refetch the
// list + candidate caches so the page stays current without a manual refresh.
// Module-level consts → stable references for useRealtime's mount-once contract.
const APP_REALTIME_EVENTS = ['application_changed', 'candidate_stage_changed']
const APP_REALTIME_KEYS = [['applications'], ['candidates']]

// Remove one application row from a React Query cache entry, tolerating BOTH
// shapes getApplications returns ({ data: [...] } and a bare [...]) so the
// optimistic inbox update works whichever the endpoint sends.
function removeAppFromCache(old, id) {
  if (Array.isArray(old?.data)) return { ...old, data: old.data.filter((a) => a.id !== id) }
  if (Array.isArray(old)) return old.filter((a) => a.id !== id)
  return old
}

export default function Applications() {
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useAuthStore((s) => s.user)
  const isAdmin = user?.role === 'admin'

  const [projectId, setProjectId] = useState(searchParams.get('project_id') || '')
  const [jobId, setJobId] = useState(searchParams.get('job_id') || '')
  const [status, setStatus] = useState(searchParams.get('status') || '')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || '')
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || '')
  // Candidate name / phone search (debounced → backend ?search=).
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '')
  const [search, setSearch] = useState(searchParams.get('search') || '')
  const [page, setPage] = useState(Math.max(parseInt(searchParams.get('page') || '1', 10), 1))
  // Card vs Table view — persisted in localStorage by useViewMode. The legacy
  // ?view=expanded URL param still flips to Card mode so old bookmarks work.
  const [viewMode, setViewMode] = useViewMode(
    'applications.view',
    searchParams.get('view') === 'expanded' ? 'card' : 'card',
  )
  const isTable = viewMode === 'table'

  // Top-level tab: the existing grouped "All applications" browser vs. the
  // focused "Inbox" for triaging pending (screening) applications. Persisted
  // so an agent who lives in the inbox lands back there on reload.
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('apps.view') === 'inbox' ? 'inbox' : 'all' }
    catch { return 'all' }
  })
  const selectTab = (next) => {
    setTab(next)
    try { localStorage.setItem('apps.view', next) } catch { /* ignore */ }
  }

  // Modal state
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  // CV Manager opened in-place over the Applications list (no navigation).
  const [cvCandidate, setCvCandidate] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [transferTarget, setTransferTarget] = useState(null)

  // Multi-select: project handlers tick the applications they want to
  // process together (schedule interview + notify all in one go).
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkScheduleOpen, setBulkScheduleOpen] = useState(false)
  // "Quick select 100" — applications still awaiting their interview message.
  // We keep the fetched details (name/job) separately so the schedule modal can
  // display them even when they're not on the currently-rendered project page.
  const [quickPending, setQuickPending] = useState(null) // { applications:[], total_pending }
  const queryClient = useQueryClient()

  // Real-time: refetch when any agent/chatbot changes an application anywhere.
  useRealtime({ events: APP_REALTIME_EVENTS, invalidateKeys: APP_REALTIME_KEYS })

  const toggleSelected = (id) => setSelectedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const clearSelected = () => setSelectedIds(new Set())
  const selectAllInGroup = (ids) => setSelectedIds((prev) => {
    const next = new Set(prev)
    for (const id of ids) next.add(id)
    return next
  })
  const unselectAllInGroup = (ids) => setSelectedIds((prev) => {
    const next = new Set(prev)
    for (const id of ids) next.delete(id)
    return next
  })

  // "Quick select 100": pull the next batch of applications that still haven't
  // received their interview message (oldest-waiting first), select them, and
  // open the schedule modal. Pressing it again after a send returns the NEXT
  // batch, because a successful send drops a row out of the pending set.
  const quickSelectMutation = useMutation({
    mutationFn: () => getPendingInterviewSends({ project_id: projectId || undefined, limit: 100 }),
    onSuccess: (res) => {
      const apps = res?.applications || []
      if (apps.length === 0) {
        toast.success('All applications have already received the interview message 🎉')
        return
      }
      setSelectedIds(new Set(res.application_ids || apps.map((a) => a.application_id)))
      setQuickPending(res)
      setBulkScheduleOpen(true)
    },
    onError: (err) => showErrorToast(err, 'Could not load pending applications'),
  })

  // Project-list controls. All projects live on one paginated list of
  // collapsed rows; a free-text search narrows by project name/client, a
  // sort dropdown reorders them, and `expandedKeys` tracks which projects
  // are open (collapsed by default since there can be many projects).
  const [projectSearch, setProjectSearch] = useState('')
  const [sortMode, setSortMode] = useState('recent') // recent | most | name
  const [expandedKeys, setExpandedKeys] = useState(() => new Set())

  const toggleExpanded = (key) => setExpandedKeys((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  // Fetch ALL applications matching the filters in one go (limit: 0 → the
  // backend returns the full, unpaginated set). Pagination is then applied
  // per-project on the client: one project per page with all of its
  // applications, so each project's count is its true total.
  const queryParams = useMemo(() => ({
    limit: 0,
    project_id: projectId || undefined,
    job_id: jobId || undefined,
    status: status || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    search: search || undefined,
  }), [dateFrom, dateTo, jobId, projectId, status, search])

  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications', queryParams],
    queryFn: () => getApplications(queryParams),
    // This pulls the full (limit:0) set, so don't poll it tightly — sockets
    // (useRealtime above) are the primary live trigger; this is a long
    // self-heal in case a socket event is missed. Pauses on hidden tabs.
    refetchInterval: 120000,
  })

  const { data: jobsData } = useQuery({
    queryKey: ['jobs', 'applications-filter'],
    queryFn: () => getJobs({ status: 'active' }),
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', 'applications-filter'],
    queryFn: () => getProjects({}),
  })

  // Candidate-level per-stage totals — the SAME canonical counts the Messages
  // tabs show (shared backend builder), so this strip reads identically to the
  // Conversations panel. Distinct from the per-project application-row counts
  // below: this counts *candidates* by their single canonical status.
  const { data: stageTotals } = useQuery({
    queryKey: ['application-status-totals', projectId || ''],
    queryFn: () => getApplicationStatusTotals({ project_id: projectId || undefined }),
    refetchInterval: 120000,
  })

  const jobs = Array.isArray(jobsData?.data) ? jobsData.data : Array.isArray(jobsData) ? jobsData : []
  const projects = Array.isArray(projectsData?.data) ? projectsData.data : Array.isArray(projectsData) ? projectsData : []

  const list = Array.isArray(applications?.data)
    ? applications.data
    : Array.isArray(applications)
      ? applications
      : []
  // Group applications by project so each project appears as its own
  // section. Applications whose job has no project (legacy data) fall into
  // a single "No Project" bucket at the bottom. Order: projects with the
  // most recent application first, so the active work is at the top.
  const groupedByProject = useMemo(() => {
    const groups = new Map()
    for (const app of list) {
      const key = app.project_id || '__no_project__'
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          project_id: app.project_id || null,
          project_title: app.project_title || (app.project_id ? 'Project' : 'No Project'),
          project_client: app.project_client || null,
          applications: [],
          latest_applied_at: 0,
        })
      }
      const g = groups.get(key)
      g.applications.push(app)
      const t = app.applied_at ? new Date(app.applied_at).getTime() : 0
      if (t > g.latest_applied_at) g.latest_applied_at = t
    }
    return [...groups.values()].sort((a, b) => {
      // "No Project" always last; otherwise newest activity first.
      if (a.key === '__no_project__') return 1
      if (b.key === '__no_project__') return -1
      return b.latest_applied_at - a.latest_applied_at
    })
  }, [list])

  // Apply the project-name search and the chosen sort order to the grouped
  // projects. Search matches project title or client (case-insensitive);
  // the "No Project" bucket always stays pinned to the bottom.
  const visibleGroups = useMemo(() => {
    const q = projectSearch.trim().toLowerCase()
    const filtered = q
      ? groupedByProject.filter((g) =>
          g.project_title?.toLowerCase().includes(q) ||
          g.project_client?.toLowerCase().includes(q))
      : groupedByProject
    const sorted = [...filtered].sort((a, b) => {
      if (a.key === '__no_project__') return 1
      if (b.key === '__no_project__') return -1
      if (sortMode === 'most') return b.applications.length - a.applications.length
      if (sortMode === 'name') return (a.project_title || '').localeCompare(b.project_title || '')
      return b.latest_applied_at - a.latest_applied_at // 'recent'
    })
    return sorted
  }, [groupedByProject, projectSearch, sortMode])

  // The whole project list lives on one page, paginated as compact collapsed
  // rows (PROJECTS_PER_PAGE per page). Expanding a row reveals all of that
  // project's applications inline.
  const totalProjects = visibleGroups.length
  const totalApplications = list.length
  const totalPages = Math.max(Math.ceil(totalProjects / PROJECTS_PER_PAGE), 1)
  const safePage = Math.min(Math.max(page, 1), totalPages)
  const pageGroups = visibleGroups.slice(
    (safePage - 1) * PROJECTS_PER_PAGE,
    safePage * PROJECTS_PER_PAGE,
  )

  const expandAllOnPage = () => setExpandedKeys((prev) => {
    const next = new Set(prev)
    for (const g of pageGroups) next.add(g.key)
    return next
  })
  const collapseAll = () => setExpandedKeys(new Set())

  // Keep `page` (and the URL) in range when search/filters shrink the list.
  useEffect(() => {
    if (page !== safePage) {
      setPage(safePage)
      syncSearchParams({ nextPage: safePage })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safePage])

  // A new search resets to the first page so results aren't hidden off-page.
  useEffect(() => {
    setPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectSearch, sortMode])

  // Debounce the candidate search box → backend ?search=.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350)
    return () => clearTimeout(t)
  }, [searchInput])

  // Keep the URL in sync with the debounced candidate search.
  useEffect(() => {
    setPage(1)
    syncSearchParams({ nextPage: 1 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const syncSearchParams = ({ nextPage = 1 } = {}) => {
    const next = new URLSearchParams()
    if (projectId) next.set('project_id', projectId)
    if (jobId) next.set('job_id', jobId)
    if (status) next.set('status', status)
    if (dateFrom) next.set('date_from', dateFrom)
    if (dateTo) next.set('date_to', dateTo)
    if (search) next.set('search', search)
    if (nextPage > 1) next.set('page', String(nextPage))
    setSearchParams(next, { replace: true })
  }

  const applyFilters = () => {
    setPage(1)
    syncSearchParams({ nextPage: 1 })
  }

  const clearFilters = () => {
    setProjectId('')
    setJobId('')
    setStatus('')
    setDateFrom('')
    setDateTo('')
    setSearchInput('')
    setSearch('')
    setProjectSearch('')
    setSortMode('recent')
    setPage(1)
    setSearchParams(new URLSearchParams(), { replace: true })
  }

  const handlePageChange = (nextPage) => {
    setPage(nextPage)
    syncSearchParams({ nextPage })
  }

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={FileText}
        tone="blue"
        title="Applications"
        subtitle="Track candidate applications across jobs"
        actions={
          <>
            {tab === 'all' && <ViewToggle mode={viewMode} onChange={setViewMode} />}
            <Button
              variant="secondary"
              onClick={() => quickSelectMutation.mutate()}
              disabled={quickSelectMutation.isPending}
              title="Select the next 100 candidates who haven't received the interview message yet"
            >
              {quickSelectMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <ListChecks size={16} />}
              Quick select 100
            </Button>
            <Link to="/applications/import">
              <Button variant="secondary">
                <Upload size={16} />
                Bulk Import
              </Button>
            </Link>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} />
              New Application
            </Button>
          </>
        }
      />

      {/* Top-level view tabs: full browser vs. focused triage inbox. */}
      <div className="mb-6 inline-flex items-center gap-1 rounded-xl bg-zinc-100 dark:bg-zinc-800 p-1">
        <button
          type="button"
          onClick={() => selectTab('all')}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
            tab === 'all'
              ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-50 shadow'
              : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
          }`}
          aria-pressed={tab === 'all'}
        >
          <FileText size={15} /> All applications
        </button>
        <button
          type="button"
          onClick={() => selectTab('inbox')}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
            tab === 'inbox'
              ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-50 shadow'
              : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
          }`}
          aria-pressed={tab === 'inbox'}
        >
          <Inbox size={15} /> Inbox
        </button>
      </div>

      {/* Candidates by stage — canonical candidate-level counts, identical to the
          Messages tabs (shared backend builder). Distinct from the per-project
          application-row totals shown on each project card below. */}
      {stageTotals?.by_status && (
        <div className="mb-6">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1.5">
            Candidates by stage{projectId ? ' · this project' : ''}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {['new', 'screening', 'certified', 'interview_scheduled', 'future_pool', 'hired'].map((s) => (
              <span
                key={s}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${STATUS_COLORS[s] || 'bg-zinc-50 text-zinc-700 border-zinc-200 dark:bg-zinc-800/40 dark:text-zinc-300 dark:border-zinc-700/50'}`}
              >
                {STATUS_LABELS[s] || s}
                <span className="font-bold">{stageTotals.by_status[s] || 0}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {tab === 'inbox' && (
        <ApplicationsInbox projects={projects} />
      )}

      {tab === 'all' && (
      <>
      <Card className="p-4 sm:p-5 mb-6">
        <div className="flex items-center justify-between gap-3 text-zinc-800 dark:text-zinc-200 mb-4">
          <div className="flex items-center gap-2">
            <ListFilter size={18} aria-hidden />
            <h2 className="text-base font-semibold">Filters</h2>
          </div>
          <SavedViews
            pageKey="applications"
            currentFilters={{ projectId, jobId, status, dateFrom, dateTo, search }}
            onApply={(f) => {
              setProjectId(f.projectId || '')
              setJobId(f.jobId || '')
              setStatus(f.status || '')
              setDateFrom(f.dateFrom || '')
              setDateTo(f.dateTo || '')
              // Update both the visible input and the debounced query value so
              // the search box reflects the view AND results refresh at once.
              setSearchInput(f.search || '')
              setSearch(f.search || '')
              setPage(1)
            }}
          />
        </div>

        <div className="relative mb-3">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search candidate by name or phone…"
            className="input w-full pl-9"
            aria-label="Search candidate by name or phone"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="input w-full"
            aria-label="Filter by project"
          >
            <option value="">All Projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.title}</option>
            ))}
          </select>

          <select
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            className="input w-full"
            aria-label="Filter by job"
          >
            <option value="">All Jobs</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>{job.title}</option>
            ))}
          </select>

          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="input w-full"
            aria-label="Filter by application status"
          >
            {STATUS_FILTER_OPTIONS.map((option) => (
              <option key={option.value || 'all'} value={option.value}>{option.label}</option>
            ))}
          </select>

          <div className="relative">
            <CalendarDays size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="input w-full pl-9"
              aria-label="Filter from date"
            />
          </div>

          <div className="relative">
            <CalendarDays size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="input w-full pl-9"
              aria-label="Filter to date"
            />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={applyFilters}>Apply Filters</Button>
          <Button variant="secondary" size="sm" onClick={clearFilters}>Clear</Button>
        </div>
      </Card>

      {isLoading ? (
        <Card className="overflow-hidden p-0">
          <div className="p-5">
            <TableSkeleton rows={6} cols={6} />
          </div>
        </Card>
      ) : list.length === 0 ? (
        <Card className="overflow-hidden p-0">
          <EmptyState
            icon={FileText}
            tone="blue"
            title="No applications yet"
            description="Applications will appear here when candidates apply to jobs, or create one manually."
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={16} />
                New Application
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4 pb-24">
          {/* Project-list toolbar: search by name, sort, expand/collapse all,
              and a summary of how many projects / applications are in view. */}
          <Card className="p-3 sm:p-4">
            <div className="flex flex-col lg:flex-row lg:items-center gap-3">
              <div className="relative flex-1 min-w-0">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
                <input
                  type="text"
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  placeholder="Search projects by name or client…"
                  className="input w-full pl-9 pr-9"
                  aria-label="Search projects by name"
                />
                {projectSearch && (
                  <button
                    type="button"
                    onClick={() => setProjectSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                    aria-label="Clear project search"
                  >
                    <X size={15} />
                  </button>
                )}
              </div>

              <div className="relative">
                <ArrowDownWideNarrow size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" aria-hidden />
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value)}
                  className="input w-full lg:w-56 pl-9"
                  aria-label="Sort projects"
                >
                  <option value="recent">Recent activity</option>
                  <option value="most">Most applications</option>
                  <option value="name">Name (A–Z)</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={expandAllOnPage} className="gap-1">
                  <ChevronsUpDown size={15} /> Expand all
                </Button>
                <Button variant="secondary" size="sm" onClick={collapseAll} className="gap-1">
                  <ChevronsDownUp size={15} /> Collapse all
                </Button>
              </div>
            </div>

            <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">{totalProjects}</span>
              {' '}project{totalProjects === 1 ? '' : 's'}
              {' · '}
              <span className="font-semibold text-zinc-700 dark:text-zinc-300">{totalApplications}</span>
              {' '}application{totalApplications === 1 ? '' : 's'}
              {projectSearch && <> matching “{projectSearch}”</>}
            </p>
          </Card>

          {totalProjects === 0 ? (
            <Card className="overflow-hidden p-0">
              <EmptyState
                icon={Search}
                tone="zinc"
                title="No matching projects"
                description={`No project matches “${projectSearch}”. Try a different name or clear the search.`}
                action={
                  <Button variant="secondary" onClick={() => setProjectSearch('')}>
                    <X size={16} /> Clear search
                  </Button>
                }
              />
            </Card>
          ) : (
            pageGroups.map((group) => (
              <ProjectSection
                key={group.key}
                group={group}
                expanded={expandedKeys.has(group.key)}
                onToggleExpand={() => toggleExpanded(group.key)}
                isTable={isTable}
                isAdmin={isAdmin}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelected}
                onSelectAllInGroup={() => selectAllInGroup(group.applications.map(a => a.id))}
                onUnselectAllInGroup={() => unselectAllInGroup(group.applications.map(a => a.id))}
                onEdit={setEditTarget}
                onTransfer={setTransferTarget}
                onDelete={setDeleteTarget}
                onOpenCv={(app) => setCvCandidate({ id: app.candidate_id, name: app.candidate_name })}
              />
            ))
          )}

          {totalPages > 1 && (
            <Card className="p-0">
              <Pagination
                page={safePage}
                totalPages={totalPages}
                total={totalProjects}
                pageSize={PROJECTS_PER_PAGE}
                onChange={handlePageChange}
              />
            </Card>
          )}
        </div>
      )}

      {/* Floating bulk-action bar — appears when 1+ applications selected */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-4 max-w-[95vw]">
          <span className="text-sm font-medium">
            {selectedIds.size} candidate{selectedIds.size > 1 ? 's' : ''} selected
          </span>
          <Button
            size="sm"
            onClick={() => setBulkScheduleOpen(true)}
            className="bg-indigo-500 hover:bg-indigo-400 text-white border-0 gap-1"
          >
            <CalendarDays size={14} />
            Schedule Interview
          </Button>
          <button onClick={clearSelected} className="text-zinc-400 hover:text-white text-sm flex items-center gap-1">
            <X size={14} /> Clear
          </button>
        </div>
      )}

      {bulkScheduleOpen && (
        <BulkScheduleInterviewModal
          applicationIds={Array.from(selectedIds)}
          // Prefer the quick-select details (which may include candidates not on
          // the current project page); fall back to the loaded list otherwise.
          applicationDetails={
            quickPending?.applications?.length
              ? quickPending.applications.map(a => ({ id: a.application_id, candidate_name: a.candidate_name, job_title: a.job_title }))
              : list.filter(a => selectedIds.has(a.id))
          }
          pendingTotal={quickPending?.total_pending}
          projectId={projectId || undefined}
          onClose={() => { setBulkScheduleOpen(false); setQuickPending(null) }}
          onSuccess={() => {
            setBulkScheduleOpen(false)
            setQuickPending(null)
            clearSelected()
            queryClient.invalidateQueries({ queryKey: ['applications'] })
            queryClient.invalidateQueries({ queryKey: ['interviews'] })
          }}
        />
      )}
      </>
      )}

      <CreateApplicationModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <EditApplicationModal open={!!editTarget} application={editTarget} onClose={() => setEditTarget(null)} />
      <TransferApplicationModal open={!!transferTarget} application={transferTarget} onClose={() => setTransferTarget(null)} />
      <DeleteApplicationConfirm open={!!deleteTarget} application={deleteTarget} onClose={() => setDeleteTarget(null)} />

      {/* CV Manager in-place — opening/closing keeps the agent on the
          Applications list exactly where they were. */}
      {cvCandidate && (
        <CVReviewModal candidate={cvCandidate} onClose={() => setCvCandidate(null)} />
      )}
    </div>
  )
}

// Download the "couldn't reach on WhatsApp" call list as a CSV and trigger a
// browser save. Used after a bulk send so agents can phone the unreachable.
async function handleUnreachableCsv(projectId) {
  try {
    const blob = await downloadUnreachableCsv({ project_id: projectId || undefined })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `unreachable-candidates-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.URL.revokeObjectURL(url)
  } catch (err) {
    showErrorToast(err, 'Could not download the call list')
  }
}

// ── BulkScheduleInterviewModal ─────────────────────────────────────────────
// Drives POST /api/interviews/bulk-schedule. Single shared date/time/location
// across all selected candidates; each gets a WhatsApp invitation and the
// application status flips to interview_scheduled.
function BulkScheduleInterviewModal({ applicationIds, applicationDetails, onClose, onSuccess, pendingTotal, projectId }) {
  const [mode, setMode] = useState('fixed') // 'fixed' | 'smart'
  // Fixed mode
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  // Smart mode (per-interviewer/day cap with auto-shift)
  const [startDate, setStartDate] = useState('')
  const [interviewerId, setInterviewerId] = useState('')
  const [perDayLimit, setPerDayLimit] = useState(8)
  const [slotMinutes, setSlotMinutes] = useState(30)
  const [preview, setPreview] = useState(null)
  // Shared
  const [location, setLocation] = useState('')
  const [duration, setDuration] = useState(30)
  // Interview message body: prefill with the agent's last-used text, falling back
  // to the default template. This is sent VERBATIM (no AI) unless "translate" is on
  // — that keeps the per-message API cost at zero.
  const [description, setDescription] = useState(() => {
    try { return localStorage.getItem(DEFAULT_INTERVIEW_MESSAGE_KEY) || DEFAULT_INTERVIEW_MESSAGE }
    catch { return DEFAULT_INTERVIEW_MESSAGE }
  })
  // Off by default to SAVE API cost: the message sends as typed (no OpenAI call).
  // Turn on only when you need it auto-translated into each candidate's language.
  const [translateNotes, setTranslateNotes] = useState(false)
  const [notifyWhatsApp, setNotifyWhatsApp] = useState(true)

  const today = new Date().toISOString().slice(0, 10)
  const channels = () => (notifyWhatsApp ? ['whatsapp'] : ['whatsapp'])
  // Remember the agent's message for next time (so they don't re-type it).
  const rememberMessage = () => {
    try { localStorage.setItem(DEFAULT_INTERVIEW_MESSAGE_KEY, description) } catch { /* ignore */ }
  }

  const { data: interviewersData } = useQuery({
    queryKey: ['interviewers'],
    queryFn: getInterviewers,
  })
  const interviewerList = Array.isArray(interviewersData) ? interviewersData : []

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!startDate) throw new Error('Start date is required')
      if (!interviewerId) throw new Error('Select an interviewer')
      return previewInterviewAllocation({
        application_ids: applicationIds,
        start_date: startDate,
        interviewer_id: interviewerId,
        per_day_limit: Number(perDayLimit) || 8,
        slot_minutes: Number(slotMinutes) || 30,
      })
    },
    onSuccess: (res) => setPreview(res),
    onError: (err) => showErrorToast(err, 'Preview failed'),
  })

  const mutation = useMutation({
    mutationFn: async () => {
      rememberMessage()
      if (mode === 'smart') {
        if (!startDate) throw new Error('Start date is required')
        if (!interviewerId) throw new Error('Select an interviewer')
        return bulkScheduleInterviews({
          application_ids: applicationIds,
          mode: 'smart',
          start_date: startDate,
          interviewer_id: interviewerId,
          per_day_limit: Number(perDayLimit) || 8,
          slot_minutes: Number(slotMinutes) || 30,
          location: location || null,
          description: description.trim() || null,
          translate_notes: translateNotes,
          notify_channels: channels(),
        })
      }
      if (!date || !time) throw new Error('Date and time are required')
      return bulkScheduleInterviews({
        application_ids: applicationIds,
        scheduled_datetime: `${date}T${time}`,
        location: location || null,
        duration_minutes: Number(duration) || 30,
        description: description.trim() || null,
        translate_notes: translateNotes,
        notify_channels: channels(),
      })
    },
    onSuccess: (result) => {
      const created = result?.total_created || 0
      const skipped = result?.skipped?.length || 0
      // Per-reason delivery breakdown from the backend so the agent sees EXACTLY
      // how many invites reached candidates vs. were dropped (out of window /
      // rate-limited / not on WhatsApp) — not just "scheduled N".
      const ds = result?.delivery_summary || {}
      const sent = ds.sent || 0
      const outWin = ds.out_of_window || 0
      const rateLtd = ds.rate_limited || 0
      const tokenExp = ds.token_expired || 0
      const otherFail = ds.other || 0
      const unreachable = ds.no_whatsapp || 0
      const totalFailed = outWin + rateLtd + tokenExp + otherFail + unreachable

      if (totalFailed > 0) {
        const parts = []
        if (sent) parts.push(`${sent} sent`)
        if (outWin) parts.push(`${outWin} no reply in 24h`)
        if (rateLtd) parts.push(`${rateLtd} rate-limited`)
        if (unreachable) parts.push(`${unreachable} not on WhatsApp`)
        if (tokenExp) parts.push(`${tokenExp} token expired`)
        if (otherFail) parts.push(`${otherFail} failed`)
        toast((t) => (
          <span className="text-sm">
            <span className="flex items-center gap-2 font-semibold text-slate-800 dark:text-zinc-100">
              <AlertTriangle size={16} className="text-amber-500" />
              Scheduled {created} — {parts.join(' · ')}
            </span>
            <span className="block mt-1 text-xs text-slate-500 dark:text-zinc-400">
              Undelivered invites stay in the pending-send list; re-send once candidates reply (or use an approved template).
            </span>
          </span>
        ), { duration: 14000 })
      } else {
        toast.success(`Scheduled ${created} interview${created === 1 ? '' : 's'} — all invites sent` + (skipped ? ` (${skipped} skipped)` : ''))
      }
      if (unreachable > 0) {
        toast((t) => (
          <span className="flex items-center gap-2 text-sm">
            <AlertTriangle size={16} className="text-amber-500" />
            {unreachable} candidate{unreachable === 1 ? '' : 's'} not on WhatsApp.
            <button
              className="font-semibold text-indigo-600 hover:underline"
              onClick={() => { handleUnreachableCsv(projectId); toast.dismiss(t.id) }}
            >
              Download call list (CSV)
            </button>
          </span>
        ), { duration: 12000 })
      }
      onSuccess()
    },
    onError: (err) => showErrorToast(err, 'Bulk schedule failed'),
  })

  return (
    <Modal open onClose={onClose} title="Schedule interview for selected candidates" size="md">
      <div className="space-y-4">
        <div className="rounded-xl bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-200 dark:border-indigo-900/50 p-3 max-h-40 overflow-y-auto">
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300 mb-2">
            {applicationDetails.length} candidate{applicationDetails.length === 1 ? '' : 's'}
            {typeof pendingTotal === 'number' && pendingTotal > applicationDetails.length && (
              <span className="ml-1 normal-case font-normal text-indigo-500 dark:text-indigo-400">
                · {pendingTotal} still awaiting the interview message
              </span>
            )}
          </p>
          <div className="space-y-1">
            {applicationDetails.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-sm">
                <span className="w-6 h-6 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                  {a.candidate_name?.charAt(0)?.toUpperCase() || '?'}
                </span>
                <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate">{a.candidate_name || 'Candidate'}</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">— {a.job_title || 'Job'}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Mode toggle: one shared slot (Fixed) vs per-interviewer/day auto-shift (Smart). */}
        <div className="flex gap-1 rounded-xl bg-zinc-100 dark:bg-zinc-800 p-1">
          <button
            type="button"
            onClick={() => setMode('fixed')}
            className={`flex-1 text-xs font-medium rounded-lg py-1.5 ${mode === 'fixed' ? 'bg-white dark:bg-zinc-900 shadow' : 'text-zinc-500'}`}
          >
            Fixed date/time
          </button>
          <button
            type="button"
            onClick={() => setMode('smart')}
            className={`flex-1 text-xs font-medium rounded-lg py-1.5 ${mode === 'smart' ? 'bg-white dark:bg-zinc-900 shadow' : 'text-zinc-500'}`}
          >
            Smart (per-day limit)
          </button>
        </div>

        {mode === 'fixed' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} min={today} className="input w-full" />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Time</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="input w-full" />
            </div>
          </div>
        )}

        {mode === 'smart' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Start date</label>
                <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); setPreview(null) }} min={today} className="input w-full" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 flex items-center gap-1"><User size={12} /> Interviewer</label>
                <select value={interviewerId} onChange={(e) => { setInterviewerId(e.target.value); setPreview(null) }} className="input w-full">
                  <option value="">Select…</option>
                  {interviewerList.map((u) => (<option key={u.id} value={u.id}>{u.full_name}</option>))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Interviews / day</label>
                <input type="number" min="1" max="50" value={perDayLimit} onChange={(e) => { setPerDayLimit(e.target.value); setPreview(null) }} className="input w-full" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1">Slot length (min)</label>
                <input type="number" min="5" max="240" value={slotMinutes} onChange={(e) => { setSlotMinutes(e.target.value); setPreview(null) }} className="input w-full" />
              </div>
            </div>
            <Button variant="secondary" size="sm" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending} className="gap-1">
              <CalendarDays size={14} /> {previewMutation.isPending ? 'Calculating…' : 'Preview allocation'}
            </Button>
            {preview && (
              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 max-h-56 overflow-y-auto text-xs space-y-2">
                <p className="font-medium text-zinc-700 dark:text-zinc-300">
                  {preview.total} interview{preview.total === 1 ? '' : 's'} · {preview.effective_slots_per_day}/day
                  {preview.span ? ` · ${preview.span.first} → ${preview.span.last}` : ''}
                </p>
                {(preview.byDay || []).map((d) => (
                  <div key={`${d.date}-${d.interviewer_id}`}>
                    <p className="font-semibold text-zinc-600 dark:text-zinc-400">{d.date} — {d.count} interview{d.count === 1 ? '' : 's'}</p>
                    <div className="pl-2">
                      {d.items.map((it) => (
                        <div key={it.application_id} className="flex justify-between gap-2 text-zinc-500 dark:text-zinc-400">
                          <span className="truncate">{it.candidate_name || 'Candidate'}</span>
                          <span>{String(it.scheduled_datetime).slice(11)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

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

        {mode === 'fixed' && (
          <div>
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1 flex items-center gap-1">
              <Clock size={12} /> Duration (minutes)
            </label>
            <input
              type="number"
              min="10"
              max="240"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className="input w-full"
            />
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
              Interview message (sent to each candidate)
            </label>
            <button
              type="button"
              onClick={() => setDescription(DEFAULT_INTERVIEW_MESSAGE)}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
              title="Reset to the default interview message"
            >
              <RotateCcw size={11} /> Reset to default
            </button>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={10}
            placeholder="Venue, what to bring, where to report…"
            className="input w-full font-mono text-[12px] leading-relaxed"
          />
          <label className="mt-2 flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={translateNotes}
              onChange={(e) => setTranslateNotes(e.target.checked)}
              className="accent-primary-600 mt-0.5"
            />
            <span>
              Translate into each candidate's language (uses AI).{' '}
              <span className="text-zinc-400">Off = send exactly as typed and save API cost.
              A short "Hi {'{name}'}, your interview for {'{job}'} is on {'{date}'}" line is always added automatically.</span>
            </span>
          </label>
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

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {mode === 'smart'
            ? <>Candidates are spread across days at the chosen per-interviewer limit (overflow auto-shifts to the next working day). Each gets their own time and status <strong>Scheduled</strong>.</>
            : <>Each candidate's status will be set to <strong>Scheduled</strong> and they'll receive the same date/time/location.</>}
        </p>

        <div className="flex justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Send size={16} />
            {mutation.isPending ? 'Scheduling…' : `Schedule ${applicationIds.length} Interview${applicationIds.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ── ProjectSection ───────────────────────────────────────────────────────
// One section per project. Header shows project name + link + application
// count + select-all checkbox. Body renders either table or card grid
// with per-row checkboxes for bulk actions.
// Note: NO `overflow-hidden` on the container — the Actions dropdown menu
// would otherwise get clipped against the section boundary (the bug from
// image 02 in the user's report).
function ProjectSection({
  group, expanded, onToggleExpand, isTable, isAdmin, selectedIds,
  onToggleSelect, onSelectAllInGroup, onUnselectAllInGroup,
  onEdit, onTransfer, onDelete, onOpenCv,
}) {
  const isUnassigned = group.key === '__no_project__'

  const ids = group.applications.map((a) => a.id)
  const selectedCount = ids.filter((id) => selectedIds.has(id)).length
  const allSelected = ids.length > 0 && selectedCount === ids.length
  const someSelected = selectedCount > 0 && selectedCount < ids.length

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm">
      <div className="flex items-center gap-3 px-4 sm:px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-gradient-to-r from-indigo-50/60 to-transparent dark:from-indigo-950/30 rounded-t-2xl">
        <input
          type="checkbox"
          aria-label={`Select all applications in ${group.project_title}`}
          className="w-4 h-4 rounded accent-primary-600 cursor-pointer flex-shrink-0"
          checked={allSelected}
          ref={(el) => { if (el) el.indeterminate = someSelected }}
          onChange={(e) => e.target.checked ? onSelectAllInGroup() : onUnselectAllInGroup()}
        />
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 flex items-center justify-between gap-3 min-w-0 hover:bg-indigo-50/50 dark:hover:bg-indigo-950/40 -mx-2 px-2 py-1 rounded-lg transition-colors text-left"
          aria-expanded={expanded}
        >
          <div className="flex items-center gap-3 min-w-0">
            {expanded ? (
              <ChevronDown size={18} className="text-indigo-600 dark:text-indigo-300 flex-shrink-0" />
            ) : (
              <ChevronRight size={18} className="text-indigo-600 dark:text-indigo-300 flex-shrink-0" />
            )}
            <div className="rounded-lg bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-200 p-1.5 flex-shrink-0">
              <FolderKanban size={16} />
            </div>
            <div className="min-w-0">
              {isUnassigned ? (
                <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 truncate">
                  {group.project_title}
                </h3>
              ) : (
                <Link
                  to={`/projects/${group.project_id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-sm font-semibold text-indigo-700 dark:text-indigo-300 hover:underline truncate inline-block"
                >
                  {group.project_title}
                </Link>
              )}
              {group.project_client && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{group.project_client}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {selectedCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600 text-white px-2.5 py-0.5 text-xs font-semibold">
                {selectedCount} selected
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2.5 py-0.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              {group.applications.length} application{group.applications.length === 1 ? '' : 's'}
            </span>
          </div>
        </button>
      </div>

      {expanded && (
        isTable ? (
          <Table>
            <Table.Head>
              <Table.Tr hover={false}>
                <Table.Th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    className="w-4 h-4 rounded accent-primary-600 cursor-pointer"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected }}
                    onChange={(e) => e.target.checked ? onSelectAllInGroup() : onUnselectAllInGroup()}
                  />
                </Table.Th>
                <Table.Th icon={User}>Candidate</Table.Th>
                <Table.Th icon={Briefcase}>Job</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th icon={CalendarDays}>Applied</Table.Th>
                <Table.Th align="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Head>
            <Table.Body>
              {group.applications.map((app) => {
                const isSelected = selectedIds.has(app.id)
                const accent = ({ screening: 'amber', certified: 'emerald', interview_scheduled: 'indigo', hired: 'emerald', rejected: 'rose', new: 'blue', future_pool: 'zinc', merged: 'zinc' })[normalizeStatus(app.status)] || 'zinc'
                return (
                  <Table.Tr key={app.id} accent={accent}>
                    <Table.Td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${app.candidate_name || 'application'}`}
                        className="w-4 h-4 rounded accent-primary-600 cursor-pointer"
                        checked={isSelected}
                        onChange={() => onToggleSelect(app.id)}
                      />
                    </Table.Td>
                    <Table.Td className="font-semibold text-zinc-900 dark:text-zinc-50 min-w-[200px]">
                      {/* Opens the candidate's CV Manager in-place over Applications
                          so the agent stays on the list (no navigation away). */}
                      <button type="button" onClick={() => onOpenCv(app)} className="group inline-flex items-center gap-3 text-left" title="Open CV Manager">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ring-2 ring-white dark:ring-zinc-900">
                          {app.candidate_name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <span className="text-sm group-hover:text-primary-600 dark:group-hover:text-primary-400 truncate">
                          {app.candidate_name || 'Candidate'}
                        </span>
                      </button>
                    </Table.Td>
                    <Table.Td>
                      <Link to={`/jobs/${app.job_id}`} className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium">
                        <Briefcase size={13} />
                        <span className="truncate max-w-[180px]">{app.job_title || 'Job'}</span>
                      </Link>
                    </Table.Td>
                    <Table.Td><Badge status={app.status} /></Table.Td>
                    <Table.Td className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                      {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '—'}
                    </Table.Td>
                    <Table.Td align="right">
                      <RowActions
                        app={app}
                        isAdmin={isAdmin}
                        onEdit={() => onEdit(app)}
                        onTransfer={() => onTransfer(app)}
                        onDelete={() => onDelete(app)}
                        onOpenCv={() => onOpenCv(app)}
                      />
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Body>
          </Table>
        ) : (
          <div className="p-4 sm:p-5 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {group.applications.map((app) => {
              const isSelected = selectedIds.has(app.id)
              const accent = ({ screening: 'amber', certified: 'emerald', interview_scheduled: 'indigo', hired: 'emerald', rejected: 'rose', new: 'blue', future_pool: 'zinc', merged: 'zinc' })[normalizeStatus(app.status)] || 'zinc'
              const stripeClass = ({ amber: 'before:bg-amber-500', emerald: 'before:bg-emerald-500', indigo: 'before:bg-indigo-500', rose: 'before:bg-rose-500', blue: 'before:bg-blue-500', zinc: 'before:bg-zinc-400' })[accent]
              return (
                <div
                  key={app.id}
                  className={`relative p-4 rounded-2xl border bg-white dark:bg-zinc-900 transition-shadow hover:shadow-md before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-1 before:rounded-r ${stripeClass} ${isSelected ? 'border-indigo-400 ring-2 ring-indigo-200 dark:ring-indigo-900/50' : 'border-zinc-100 dark:border-zinc-800'}`}
                >
                  <div className="flex items-start gap-3 pl-2">
                    <input
                      type="checkbox"
                      aria-label={`Select ${app.candidate_name || 'application'}`}
                      className="w-4 h-4 mt-1 rounded accent-primary-600 cursor-pointer flex-shrink-0"
                      checked={isSelected}
                      onChange={() => onToggleSelect(app.id)}
                    />
                    <button
                      type="button"
                      onClick={() => onOpenCv(app)}
                      className="w-10 h-10 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 ring-2 ring-white dark:ring-zinc-900"
                      title="Open CV Manager"
                    >
                      {app.candidate_name?.charAt(0)?.toUpperCase() || '?'}
                    </button>
                    <div className="min-w-0 flex-1">
                      {/* Opens CV Manager in-place (stays on Applications). */}
                      <button type="button" onClick={() => onOpenCv(app)} className="text-base font-semibold text-zinc-900 dark:text-zinc-50 hover:text-primary-700 dark:hover:text-primary-300 truncate block text-left w-full" title="Open CV Manager">
                        {app.candidate_name || 'Candidate'}
                      </button>
                      <p className="text-xs text-zinc-500 dark:text-zinc-500 truncate mt-0.5">
                        {app.candidate_phone || ''}
                      </p>
                    </div>
                    <Badge status={app.status} />
                  </div>

                  <div className="mt-3 text-sm">
                    <Link to={`/jobs/${app.job_id}`} className="inline-flex items-center gap-1.5 text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium">
                      <Briefcase size={13} />
                      <span className="truncate">{app.job_title || 'Job'}</span>
                    </Link>
                  </div>

                  <div className="mt-3 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-500">
                    <span>Applied {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '—'}</span>
                    <RowActions
                      app={app}
                      isAdmin={isAdmin}
                      onEdit={() => onEdit(app)}
                      onTransfer={() => onTransfer(app)}
                      onDelete={() => onDelete(app)}
                      onOpenCv={() => onOpenCv(app)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}

function RowActions({ app, isAdmin, onEdit, onTransfer, onDelete, onOpenCv }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const queryClient = useQueryClient()

  // Move to Future Pool right from the row: close (reject) THIS application and
  // park the candidate in the pool. Rejecting the application drops it out of the
  // active Applications list (the user's "remove it from Applications" ask), while
  // setCandidateStage('future_pool') (inside reject-to-pool) parks the candidate.
  const futurePoolMut = useMutation({
    mutationFn: () => rejectToPool(app.id, { rejection_reason: 'Moved to Future Pool' }),
    onSuccess: () => {
      toast.success('Moved to Future Pool')
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
    },
    onError: (e) => toast.error(e?.response?.data?.error || 'Could not move to Future Pool'),
  })

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
        className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Actions <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1">
          <MenuButton icon={FileText} label="Open CV" onClick={() => { setOpen(false); onOpenCv() }} />
          <MenuLink to={`/communications?candidate=${app.candidate_id}`} icon={MessageSquare} label="Open Chat" />
          <MenuLink to={`/candidates/${app.candidate_id}`} icon={Eye} label="View Candidate" />
          <MenuButton icon={Pencil} label="Edit Status" onClick={() => { setOpen(false); onEdit() }} />
          <MenuButton icon={ArrowRightLeft} label="Transfer" onClick={() => { setOpen(false); onTransfer() }} />
          <MenuButton icon={Archive} label="Move to Future Pool" onClick={() => { setOpen(false); futurePoolMut.mutate() }} />
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

// ── ApplicationsInbox ──────────────────────────────────────────────────────
// Focused triage queue for pending (screening) applications. Each row can be
// accepted (screening → certified), rejected to the general pool, or have its
// CV previewed inline; a sticky bar drives the same two actions in bulk.
const POOL_REASON = 'Moved to general pool'

function ApplicationsInbox({ projects = [] }) {
  const queryClient = useQueryClient()
  const [projectId, setProjectId] = useState('')
  // Local selection set (independent of the All-view bulk-schedule selection).
  const [selected, setSelected] = useState(new Set())
  // CV preview target: { id, name }.
  const [cvTarget, setCvTarget] = useState(null)
  // Tracks the row whose single-row action is in flight (for the spinner).
  const [actingId, setActingId] = useState(null)

  const params = useMemo(() => ({
    status: 'screening',
    project_id: projectId || undefined,
    limit: 100,
  }), [projectId])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['applications', 'inbox', params],
    queryFn: () => getApplications(params),
    // Small payload (limit:100) and the active triage surface — poll as a
    // backstop to the socket pushes (pauses while the tab is hidden).
    refetchInterval: 30000,
  })

  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []

  // Drop ids from the selection that are no longer in the current result set
  // (e.g. after a refetch removes accepted/rejected rows).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const valid = new Set(list.map((a) => a.id))
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [list])

  const ids = list.map((a) => a.id)
  const selectedCount = selected.size
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id))
  const someSelected = selectedCount > 0 && !allSelected

  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleAll = () => setSelected((prev) => {
    if (ids.length > 0 && ids.every((id) => prev.has(id))) return new Set()
    return new Set(ids)
  })
  const clearSelected = () => setSelected(new Set())

  const invalidate = () => {
    // Refresh both the inbox and any All-view application lists.
    queryClient.invalidateQueries({ queryKey: ['applications'] })
    queryClient.invalidateQueries({ queryKey: ['candidates'] })
  }

  // 422 screening_gate (no eligible CV) gets a specific toast; everything else
  // falls back to the generic error toast.
  const onActionError = (err, prefix) => {
    const code = err?.response?.data?.code
    if (code === 'screening_gate') {
      toast.error(err?.response?.data?.error || 'Upload a CV before accepting this candidate.', { duration: 6000 })
    } else {
      showErrorToast(err, prefix)
    }
  }

  // Optimistically drop the acted row from the inbox so the action feels
  // instant instead of waiting for a full refetch. The inbox key carries a
  // `params` filter (project scope) so there can be several cached entries —
  // snapshot/patch them ALL with the plural get/setQueriesData. Capture the
  // candidate name in onMutate since the row is gone from `list` by onSuccess.
  const optimisticRemove = async (id) => {
    setActingId(id)
    const name = list.find((a) => a.id === id)?.candidate_name || 'Candidate'
    await queryClient.cancelQueries({ queryKey: ['applications', 'inbox'] })
    const previous = queryClient.getQueriesData({ queryKey: ['applications', 'inbox'] })
    queryClient.setQueriesData({ queryKey: ['applications', 'inbox'] }, (old) => removeAppFromCache(old, id))
    return { previous, name }
  }
  const rollback = (ctx) => {
    ctx?.previous?.forEach(([key, data]) => queryClient.setQueryData(key, data))
  }

  const acceptMutation = useMutation({
    mutationFn: (id) => updateApplication(id, { status: 'certified' }),
    onMutate: optimisticRemove,
    onSuccess: (_res, _id, ctx) => {
      toast.success(`${ctx?.name || 'Candidate'} accepted (certified)`)
    },
    onError: (err, _id, ctx) => {
      rollback(ctx)
      onActionError(err, 'Accept failed')
    },
    onSettled: () => {
      setActingId(null)
      invalidate() // reconcile the optimistic removal with the server truth
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (id) => rejectToPool(id, { rejection_reason: POOL_REASON }),
    onMutate: optimisticRemove,
    onSuccess: (_res, _id, ctx) => {
      toast.success(`${ctx?.name || 'Candidate'} moved to general pool`)
    },
    onError: (err, _id, ctx) => {
      rollback(ctx)
      onActionError(err, 'Reject failed')
    },
    onSettled: () => {
      setActingId(null)
      invalidate()
    },
  })

  const bulkAcceptMutation = useMutation({
    mutationFn: () => batchCertifyApplications({
      application_ids: [...selected],
      notify_channels: ['whatsapp'],
    }),
    onSuccess: (res) => {
      const n = res?.certified?.length ?? res?.total_certified ?? selected.size
      toast.success(`Accepted ${n} application${n === 1 ? '' : 's'}`)
      clearSelected()
      invalidate()
    },
    onError: (err) => showErrorToast(err, 'Bulk accept failed'),
  })

  const bulkRejectMutation = useMutation({
    mutationFn: () => batchRejectToPool({
      application_ids: [...selected],
      rejection_reason: POOL_REASON,
      notify_channels: ['whatsapp'],
    }),
    onSuccess: (res) => {
      const n = res?.rejected?.length ?? res?.total_rejected ?? selected.size
      toast.success(`Moved ${n} application${n === 1 ? '' : 's'} to general pool`)
      clearSelected()
      invalidate()
    },
    onError: (err) => showErrorToast(err, 'Bulk reject failed'),
  })

  const bulkBusy = bulkAcceptMutation.isPending || bulkRejectMutation.isPending

  return (
    <div className="pb-24">
      {/* Inbox filter bar — just the project scope; status is fixed to pending. */}
      <Card className="p-3 sm:p-4 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 text-zinc-800 dark:text-zinc-200">
            <Inbox size={18} aria-hidden />
            <h2 className="text-base font-semibold">Pending applications</h2>
          </div>
          <div className="sm:ml-auto w-full sm:w-72">
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="input w-full"
              aria-label="Filter inbox by project"
            >
              <option value="">All Projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.title}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Applications awaiting review. Accept to certify, or move to the general pool.
        </p>
      </Card>

      {isLoading ? (
        <Card className="overflow-hidden p-0">
          <div className="p-5">
            <TableSkeleton rows={6} cols={6} />
          </div>
        </Card>
      ) : isError ? (
        <Card className="overflow-hidden p-0">
          <EmptyState
            icon={FileText}
            tone="rose"
            title="Couldn't load the inbox"
            description="Something went wrong fetching pending applications. Try again in a moment."
          />
        </Card>
      ) : list.length === 0 ? (
        <Card className="overflow-hidden p-0">
          <EmptyState
            icon={Inbox}
            tone="emerald"
            title="Inbox zero 🎉"
            description="No applications are waiting for review right now. New screening applications will show up here."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <Table.Head>
              <Table.Tr hover={false}>
                <Table.Th>
                  <input
                    type="checkbox"
                    aria-label="Select all pending applications"
                    className="w-4 h-4 rounded accent-primary-600 cursor-pointer"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected }}
                    onChange={toggleAll}
                  />
                </Table.Th>
                <Table.Th icon={User}>Candidate</Table.Th>
                <Table.Th icon={Briefcase}>Job</Table.Th>
                <Table.Th icon={FolderKanban}>Project</Table.Th>
                <Table.Th icon={CalendarDays}>Applied</Table.Th>
                <Table.Th>Match</Table.Th>
                <Table.Th align="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Head>
            <Table.Body>
              {list.map((app) => (
                <InboxRow
                  key={app.id}
                  app={app}
                  selected={selected.has(app.id)}
                  onToggle={() => toggleOne(app.id)}
                  onAccept={() => acceptMutation.mutate(app.id)}
                  onReject={() => rejectMutation.mutate(app.id)}
                  onPreview={() => setCvTarget({ id: app.candidate_id, name: app.candidate_name })}
                  busy={actingId === app.id}
                  disabled={(actingId !== null && actingId !== app.id) || bulkBusy}
                />
              ))}
            </Table.Body>
          </Table>
        </Card>
      )}

      {/* Sticky bulk-action bar — mirrors the All view's floating bar. */}
      {selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-3 max-w-[95vw]">
          <span className="text-sm font-medium whitespace-nowrap">
            {selectedCount} selected
          </span>
          <Button
            size="sm"
            onClick={() => bulkAcceptMutation.mutate()}
            disabled={bulkBusy}
            className="bg-emerald-500 hover:bg-emerald-400 text-white border-0 gap-1"
          >
            {bulkAcceptMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Accept selected
          </Button>
          <Button
            size="sm"
            onClick={() => bulkRejectMutation.mutate()}
            disabled={bulkBusy}
            className="bg-rose-500 hover:bg-rose-400 text-white border-0 gap-1"
          >
            {bulkRejectMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Archive size={14} />}
            Reject to pool
          </Button>
          <button
            onClick={clearSelected}
            disabled={bulkBusy}
            className="text-zinc-400 hover:text-white text-sm flex items-center gap-1 disabled:opacity-50"
          >
            <X size={14} /> Clear
          </button>
        </div>
      )}

      {cvTarget && (
        <InboxCvModal candidate={cvTarget} onClose={() => setCvTarget(null)} />
      )}
    </div>
  )
}

// Format a match score that may arrive as a 0–1 fraction or a 0–100 percentage.
function formatMatch(score) {
  if (score == null) return null
  const pct = score <= 1 ? score * 100 : score
  return Math.round(pct)
}

function InboxRow({ app, selected, onToggle, onAccept, onReject, onPreview, busy, disabled }) {
  const match = formatMatch(app.match_score)
  const matchClass = match == null
    ? ''
    : match >= 70 ? 'text-emerald-600 dark:text-emerald-400'
    : match >= 50 ? 'text-amber-600 dark:text-amber-400'
    : 'text-rose-600 dark:text-rose-400'

  return (
    <Table.Tr accent="amber">
      <Table.Td>
        <input
          type="checkbox"
          aria-label={`Select ${app.candidate_name || 'application'}`}
          className="w-4 h-4 rounded accent-primary-600 cursor-pointer"
          checked={selected}
          onChange={onToggle}
        />
      </Table.Td>
      <Table.Td className="font-semibold text-zinc-900 dark:text-zinc-50 min-w-[200px]">
        <button type="button" onClick={onPreview} className="group inline-flex items-center gap-3 text-left" title="Preview CV">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ring-2 ring-white dark:ring-zinc-900">
            {app.candidate_name?.charAt(0)?.toUpperCase() || '?'}
          </div>
          <span className="min-w-0">
            <span className="block text-sm group-hover:text-primary-600 dark:group-hover:text-primary-400 truncate">
              {app.candidate_name || 'Candidate'}
            </span>
            {app.candidate_phone && (
              <span className="block text-xs font-normal text-zinc-500 dark:text-zinc-400 inline-flex items-center gap-1">
                <Phone size={10} /> {app.candidate_phone}
              </span>
            )}
          </span>
        </button>
      </Table.Td>
      <Table.Td>
        <Link to={`/jobs/${app.job_id}`} className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium">
          <Briefcase size={13} />
          <span className="truncate max-w-[160px]">{app.job_title || 'Job'}</span>
        </Link>
      </Table.Td>
      <Table.Td className="text-sm text-zinc-600 dark:text-zinc-400">
        <span className="truncate max-w-[160px] inline-block align-bottom">{app.project_title || '—'}</span>
      </Table.Td>
      <Table.Td className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
        {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '—'}
      </Table.Td>
      <Table.Td>
        {match == null ? (
          <span className="text-xs text-zinc-400">—</span>
        ) : (
          <span className={`inline-flex items-center gap-1 text-sm font-semibold ${matchClass}`}>
            <Star size={13} /> {match}%
          </span>
        )}
      </Table.Td>
      <Table.Td align="right">
        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={onPreview}
            disabled={disabled}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
            title="Preview CV"
          >
            <Eye size={13} /> View CV
          </button>
          <button
            type="button"
            onClick={onAccept}
            disabled={disabled || busy}
            className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 disabled:opacity-50"
            title="Accept (certify)"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Accept
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={disabled || busy}
            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 px-2 py-1 text-xs font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/40 disabled:opacity-50"
            title="Reject to general pool"
          >
            <Archive size={13} /> Pool
          </button>
        </div>
      </Table.Td>
    </Table.Tr>
  )
}

// CV preview modal: pulls the candidate's enriched cv_files (resolved_file_url
// + document_category) and previews the primary CV inline — same pattern as
// ConversationDocumentsPanel.
function InboxCvModal({ candidate, onClose }) {
  const { data, isLoading } = useQuery({
    queryKey: ['candidate', candidate.id],
    queryFn: () => getCandidate(candidate.id),
    enabled: !!candidate.id,
  })

  const cvs = data?.cvs || []
  const cvList = cvs
    .filter((cv) => getDocumentCategory(cv) === 'cv')
    .sort((a, b) => new Date(b.uploaded_at || 0) - new Date(a.uploaded_at || 0))
  // Prefer the primary CV, else the most recent; fall back to any document.
  const primary = cvList.find((cv) => cv.is_primary) || cvList[0] || cvs[0] || null
  const fileName = primary?.file_name || `${candidate.name || 'Candidate'} CV`

  return (
    <Modal open onClose={onClose} title={`CV — ${candidate.name || 'Candidate'}`} size="2xl">
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 h-[60vh] text-zinc-500 dark:text-zinc-400">
          <Loader2 size={18} className="animate-spin" /> Loading CV…
        </div>
      ) : (
        // DocumentPreview internally renders the "processing"/"no document"
        // states, so a missing CV degrades gracefully.
        <DocumentPreview cv={primary || undefined} fileName={fileName} className="h-[70vh]" />
      )}
    </Modal>
  )
}
