import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { getApplications, getJobs, getProjects } from '../api'
import { CalendarDays, FileText, LayoutGrid, ListFilter } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { TableSkeleton } from '../components/ui/Skeleton'
import { PageHeader } from '../components/ui/PageHeader'

const DEFAULT_LIMIT = 20

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'applied', label: 'Applied' },
  { value: 'screening', label: 'Screening' },
  { value: 'certified', label: 'Certified' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
  { value: 'interviewed', label: 'Interviewed' },
  { value: 'selected', label: 'Selected' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'placed', label: 'Placed' },
]

export default function Applications() {
  const [searchParams, setSearchParams] = useSearchParams()

  const [projectId, setProjectId] = useState(searchParams.get('project_id') || '')
  const [jobId, setJobId] = useState(searchParams.get('job_id') || '')
  const [status, setStatus] = useState(searchParams.get('status') || '')
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || '')
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || '')
  const [page, setPage] = useState(Math.max(parseInt(searchParams.get('page') || '1', 10), 1))
  const [isCompact, setIsCompact] = useState(searchParams.get('view') !== 'expanded')

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

  const syncSearchParams = ({ nextPage = 1, nextView = isCompact } = {}) => {
    const next = new URLSearchParams()
    if (projectId) next.set('project_id', projectId)
    if (jobId) next.set('job_id', jobId)
    if (status) next.set('status', status)
    if (dateFrom) next.set('date_from', dateFrom)
    if (dateTo) next.set('date_to', dateTo)
    if (nextPage > 1) next.set('page', String(nextPage))
    if (!nextView) next.set('view', 'expanded')
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

  const handleViewToggle = (compact) => {
    setIsCompact(compact)
    syncSearchParams({ nextPage: page, nextView: compact })
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
      />

      <Card className="p-4 sm:p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2 text-gray-800">
            <ListFilter size={18} aria-hidden />
            <h2 className="text-base font-semibold">Filters</h2>
          </div>
          <div className="inline-flex rounded-2xl border border-zinc-200 bg-zinc-50 p-1">
            <button
              type="button"
              onClick={() => handleViewToggle(true)}
              className={`px-3 py-1.5 rounded-xl text-sm font-medium ${isCompact ? 'bg-white shadow text-zinc-900' : 'text-zinc-600'}`}
            >
              Compact
            </button>
            <button
              type="button"
              onClick={() => handleViewToggle(false)}
              className={`px-3 py-1.5 rounded-xl text-sm font-medium ${!isCompact ? 'bg-white shadow text-zinc-900' : 'text-zinc-600'}`}
            >
              Expanded
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl"
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
            className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl"
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
            className="w-full px-3 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl"
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
              className="w-full pl-9 pr-3 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl"
              aria-label="Filter from date"
            />
          </div>

          <div className="relative">
            <CalendarDays size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl"
              aria-label="Filter to date"
            />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={applyFilters}>Apply Filters</Button>
          <Button variant="secondary" size="sm" onClick={clearFilters}>Clear</Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : list.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <FileText className="mx-auto h-12 w-12 text-gray-300 mb-2" aria-hidden />
            <p className="font-medium">No applications yet</p>
            <p className="text-sm mt-1">Applications will appear when candidates apply to jobs.</p>
          </div>
        ) : isCompact ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Candidate</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Job</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Project</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Applied</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((app) => (
                  <tr key={app.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-3 px-4 font-medium text-gray-900">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-primary-600 hover:text-primary-700">
                        {app.candidate_name || 'Candidate'}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      <Link to={`/jobs/${app.job_id}`} className="text-primary-600 hover:text-primary-700">
                        {app.job_title || 'Job'}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-gray-600">{app.project_title || '-'}</td>
                    <td className="py-3 px-4">
                      <Badge status={app.status} />
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '-'}
                    </td>
                    <td className="py-3 px-4">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-primary-600 hover:text-primary-700 text-sm font-medium">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-4 sm:p-5 space-y-3">
            {list.map((app) => (
              <Card key={app.id} className="p-4 border border-zinc-100" hover>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div className="min-w-0">
                    <Link to={`/candidates/${app.candidate_id}`} className="text-base font-semibold text-primary-700 hover:text-primary-800 truncate block">
                      {app.candidate_name || 'Candidate'}
                    </Link>
                    <p className="text-sm text-zinc-600 truncate">
                      {app.job_title || 'Job'} {app.project_title ? `• ${app.project_title}` : ''}
                    </p>
                    <p className="text-xs text-zinc-500 mt-1">
                      Applied {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '-'}
                    </p>
                  </div>

                  <div className="flex items-center gap-3">
                    <Badge status={app.status} />
                    <Link to={`/jobs/${app.job_id}`} className="text-sm text-primary-600 hover:text-primary-700 font-medium">
                      View Job
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        {pagination && (
          <div className="px-4 py-3 border-t border-zinc-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-sm text-zinc-600">
              Showing {list.length} of {pagination.total} applications
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={pagination.page <= 1}
                onClick={() => handlePageChange(Math.max(1, pagination.page - 1))}
              >
                Previous
              </Button>
              <span className="text-sm text-zinc-600 px-2">Page {pagination.page} / {pagination.totalPages}</span>
              <Button
                variant="secondary"
                size="sm"
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => handlePageChange(Math.min(pagination.totalPages, pagination.page + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
