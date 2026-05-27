import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { getApplications, getJobs, getProjects } from '../api'
import {
  CalendarDays, FileText, FolderKanban, Briefcase, ListFilter, Plus,
  MoreHorizontal, Eye, Pencil, ArrowRightLeft, Trash2, User,
  ChevronDown, ChevronRight,
} from 'lucide-react'
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

const DEFAULT_LIMIT = 20

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'applied', label: 'Applied' },
  { value: 'certified', label: 'Certified' },
  { value: 'pre_screened', label: 'Pre Screened' },
  { value: 'interview_scheduled', label: 'Scheduled' },
  { value: 'selected', label: 'Selected' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'placed', label: 'Placed' },
]

const statusAccent = {
  applied: 'blue',
  screening: 'amber',
  certified: 'emerald',
  pre_screened: 'teal',
  interview_scheduled: 'indigo',
  interviewed: 'purple',
  selected: 'emerald',
  rejected: 'rose',
  placed: 'emerald',
  transferred: 'indigo',
  auto_assigned: 'indigo',
  reviewing: 'amber',
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
  const [page, setPage] = useState(Math.max(parseInt(searchParams.get('page') || '1', 10), 1))
  // Card vs Table view — persisted in localStorage by useViewMode. The legacy
  // ?view=expanded URL param still flips to Card mode so old bookmarks work.
  const [viewMode, setViewMode] = useViewMode(
    'applications.view',
    searchParams.get('view') === 'expanded' ? 'card' : 'card',
  )
  const isTable = viewMode === 'table'

  // Modal state
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [transferTarget, setTransferTarget] = useState(null)

  const queryParams = useMemo(() => ({
    page,
    limit: DEFAULT_LIMIT,
    project_id: projectId || undefined,
    job_id: jobId || undefined,
    status: status || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
  }), [dateFrom, dateTo, jobId, page, projectId, status])

  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications', queryParams],
    queryFn: () => getApplications(queryParams),
  })

  const { data: jobsData } = useQuery({
    queryKey: ['jobs', 'applications-filter'],
    queryFn: () => getJobs({ status: 'active' }),
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', 'applications-filter'],
    queryFn: () => getProjects({}),
  })

  const jobs = Array.isArray(jobsData?.data) ? jobsData.data : Array.isArray(jobsData) ? jobsData : []
  const projects = Array.isArray(projectsData?.data) ? projectsData.data : Array.isArray(projectsData) ? projectsData : []

  const list = Array.isArray(applications?.data)
    ? applications.data
    : Array.isArray(applications)
      ? applications
      : []
  const pagination = applications?.pagination || null

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

  const syncSearchParams = ({ nextPage = 1 } = {}) => {
    const next = new URLSearchParams()
    if (projectId) next.set('project_id', projectId)
    if (jobId) next.set('job_id', jobId)
    if (status) next.set('status', status)
    if (dateFrom) next.set('date_from', dateFrom)
    if (dateTo) next.set('date_to', dateTo)
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
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} />
              New Application
            </Button>
          </>
        }
      />

      <Card className="p-4 sm:p-5 mb-6">
        <div className="flex items-center gap-2 text-zinc-800 dark:text-zinc-200 mb-4">
          <ListFilter size={18} aria-hidden />
          <h2 className="text-base font-semibold">Filters</h2>
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
            {STATUS_OPTIONS.map((option) => (
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
        <div className="space-y-4">
          {groupedByProject.map((group) => (
            <ProjectSection
              key={group.key}
              group={group}
              isTable={isTable}
              isAdmin={isAdmin}
              statusAccent={statusAccent}
              onEdit={setEditTarget}
              onTransfer={setTransferTarget}
              onDelete={setDeleteTarget}
            />
          ))}
          {pagination && (
            <Card className="overflow-hidden p-0">
              <Pagination
                page={pagination.page}
                totalPages={pagination.totalPages}
                total={pagination.total}
                pageSize={pagination.limit || DEFAULT_LIMIT}
                onChange={handlePageChange}
              />
            </Card>
          )}
        </div>
      )}

      <CreateApplicationModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <EditApplicationModal open={!!editTarget} application={editTarget} onClose={() => setEditTarget(null)} />
      <TransferApplicationModal open={!!transferTarget} application={transferTarget} onClose={() => setTransferTarget(null)} />
      <DeleteApplicationConfirm open={!!deleteTarget} application={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </div>
  )
}

// ── ProjectSection ───────────────────────────────────────────────────────
// One section per project. Header shows project name + link + application
// count; body renders either the table or the card grid for just this
// project's applications. Collapsible (default expanded).
function ProjectSection({ group, isTable, isAdmin, statusAccent, onEdit, onTransfer, onDelete }) {
  const [expanded, setExpanded] = useState(true)
  const isUnassigned = group.key === '__no_project__'

  return (
    <Card className="overflow-hidden p-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-gradient-to-r from-indigo-50/60 to-transparent dark:from-indigo-950/30 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors text-left"
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
        <span className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2.5 py-0.5 text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex-shrink-0">
          {group.applications.length} application{group.applications.length === 1 ? '' : 's'}
        </span>
      </button>

      {expanded && (
        isTable ? (
          <Table>
            <Table.Head>
              <Table.Tr hover={false}>
                <Table.Th icon={User}>Candidate</Table.Th>
                <Table.Th icon={Briefcase}>Job</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th icon={CalendarDays}>Applied</Table.Th>
                <Table.Th align="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Head>
            <Table.Body>
              {group.applications.map((app) => {
                const accent = statusAccent[app.status] || 'zinc'
                return (
                  <Table.Tr key={app.id} accent={accent}>
                    <Table.Td className="font-semibold text-zinc-900 dark:text-zinc-50 min-w-[200px]">
                      <Link to={`/candidates/${app.candidate_id}`} className="group inline-flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ring-2 ring-white dark:ring-zinc-900">
                          {app.candidate_name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <span className="text-sm group-hover:text-primary-600 dark:group-hover:text-primary-400 truncate">
                          {app.candidate_name || 'Candidate'}
                        </span>
                      </Link>
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
              const accent = statusAccent[app.status] || 'zinc'
              const stripeClass = {
                blue: 'before:bg-blue-500',
                amber: 'before:bg-amber-500',
                emerald: 'before:bg-emerald-500',
                purple: 'before:bg-purple-500',
                rose: 'before:bg-rose-500',
                indigo: 'before:bg-indigo-500',
                teal: 'before:bg-teal-500',
                zinc: 'before:bg-zinc-400',
              }[accent]
              return (
                <div
                  key={app.id}
                  className={`relative p-4 rounded-2xl border border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 transition-shadow hover:shadow-md before:content-[''] before:absolute before:left-0 before:top-3 before:bottom-3 before:w-1 before:rounded-r ${stripeClass}`}
                >
                  <div className="flex items-start gap-3 pl-2">
                    <Link
                      to={`/candidates/${app.candidate_id}`}
                      className="w-10 h-10 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 ring-2 ring-white dark:ring-zinc-900"
                    >
                      {app.candidate_name?.charAt(0)?.toUpperCase() || '?'}
                    </Link>
                    <div className="min-w-0 flex-1">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-base font-semibold text-zinc-900 dark:text-zinc-50 hover:text-primary-700 dark:hover:text-primary-300 truncate block">
                        {app.candidate_name || 'Candidate'}
                      </Link>
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
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}
    </Card>
  )
}

function RowActions({ app, isAdmin, onEdit, onTransfer, onDelete }) {
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
        className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Actions <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg py-1">
          <MenuLink to={`/candidates/${app.candidate_id}`} icon={Eye} label="View Candidate" />
          <MenuButton icon={Pencil} label="Edit Status" onClick={() => { setOpen(false); onEdit() }} />
          <MenuButton icon={ArrowRightLeft} label="Transfer" onClick={() => { setOpen(false); onTransfer() }} />
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
