import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { getJob, getJobCandidates } from '../api'
import { ArrowLeft, Briefcase, MapPin, Calendar, FolderKanban, Users, User } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Skeleton } from '../components/ui/Skeleton'
import { format } from 'date-fns'

export default function JobDetail() {
  const { id } = useParams()
  const { data: job, isLoading, error } = useQuery({
    queryKey: ['job', id],
    queryFn: () => getJob(id),
    enabled: !!id,
  })

  const { data: candidatesData, isLoading: isCandidatesLoading } = useQuery({
    queryKey: ['job-candidates-preview', id],
    queryFn: () => getJobCandidates(id),
    enabled: !!id,
  })

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Skeleton className="h-8 w-48 mb-4" />
        <Skeleton className="h-4 w-full mb-2" />
        <Skeleton className="h-4 w-2/3 mb-8" />
        <Card>
          <Skeleton className="h-6 w-1/3 mb-4" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="p-6 lg:p-8 animate-fade-in">
        <Link to="/jobs" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6">
          <ArrowLeft size={20} /> Back to Jobs
        </Link>
        <div className="card text-center py-12">
          <p className="text-zinc-600 dark:text-zinc-400 font-medium">Job not found</p>
          <Link to="/jobs">
            <Button variant="primary" className="mt-4">Back to Jobs</Button>
          </Link>
        </div>
      </div>
    )
  }

  const requirements = typeof job.requirements === 'object' ? job.requirements : {}
  const reqEntries = Object.entries(requirements)
  const candidatePreview = Array.isArray(candidatesData?.candidates)
    ? candidatesData.candidates.slice(0, 5)
    : []

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <Link to="/jobs" className="inline-flex items-center gap-2 text-primary-600 hover:text-primary-700 mb-6 font-medium">
        <ArrowLeft size={20} aria-hidden /> Back to Jobs
      </Link>

      {/* Project Badge (if applicable) */}
      {job.project_title && (
        <Link 
          to={`/projects/${job.project_id}`}
          className="inline-flex items-center gap-2 px-4 py-2 mb-4 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors border border-blue-200"
        >
          <FolderKanban size={18} />
          <div>
            <p className="text-xs text-blue-600">Part of Project</p>
            <p className="font-medium">{job.project_title}</p>
            {job.project_client && <p className="text-xs">{job.project_client}</p>}
          </div>
        </Link>
      )}

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-zinc-50">{job.title}</h1>
          <div className="flex flex-wrap items-center gap-4 mt-2 text-zinc-600 dark:text-zinc-400">
            <span className="inline-flex items-center gap-1">
              <Briefcase size={18} aria-hidden /> {job.category}
            </span>
            {job.location && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={18} aria-hidden /> {job.location}
              </span>
            )}
            {job.deadline && (
              <span className="inline-flex items-center gap-1">
                <Calendar size={18} aria-hidden /> Deadline: {format(new Date(job.deadline), 'MMM d, yyyy')}
              </span>
            )}
          </div>
        </div>
        <Badge status={job.status} className="text-sm" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-3">Description</h2>
            <p className="text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">{job.description || 'No description provided.'}</p>
          </Card>

          {reqEntries.length > 0 && (
            <Card>
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-3">Requirements</h2>
              <ul className="space-y-2 text-zinc-600 dark:text-zinc-400">
                {reqEntries.map(([key, value]) => (
                  <li key={key} className="flex gap-2">
                    <span className="font-medium text-zinc-700 dark:text-zinc-300 capitalize">{key.replace(/_/g, ' ')}:</span>
                    <span>{Array.isArray(value) ? value.join(', ') : String(value)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Candidates</h2>
              <Link
                to={`/jobs/${id}/candidates`}
                className="text-sm text-primary-600 hover:text-primary-700 font-medium"
              >
                View All →
              </Link>
            </div>

            {isCandidatesLoading ? (
              <div className="space-y-2">
                {[...Array(3)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : candidatePreview.length > 0 ? (
              <div className="space-y-2">
                {candidatePreview.map((item) => {
                  const candidate = item.candidate || {}
                  return (
                    <Link
                      key={item.application_id}
                      to={`/candidates/${candidate.id}`}
                      className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-50 transition-colors group"
                    >
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 overflow-hidden">
                        {candidate.photo_url ? (
                          <img
                            src={`${import.meta.env.VITE_API_URL || ''}${candidate.photo_url}`}
                            alt={candidate.name}
                            className="w-full h-full object-cover"
                          />
                        ) : candidate.name?.charAt(0)?.toUpperCase() || <User size={14} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50 truncate group-hover:text-primary-600">{candidate.name}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{item.application_status || 'applied'}</p>
                      </div>
                      <span className="text-xs font-semibold text-primary-600 flex-shrink-0">{item.match_score || 0}%</span>
                    </Link>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400 py-2">No candidates assigned yet.</p>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4">Summary</h2>
            <dl className="space-y-3">
              <div>
                <dt className="text-sm text-zinc-500 dark:text-zinc-400">Positions</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-50">{job.positions_filled ?? 0} / {job.positions_available ?? 1} filled</dd>
              </div>
              {job.salary_range && (
                <div>
                  <dt className="text-sm text-zinc-500 dark:text-zinc-400">Salary range</dt>
                  <dd className="font-medium text-zinc-900 dark:text-zinc-50">{job.salary_range}</dd>
                </div>
              )}
              {job.application_count != null && (
                <div>
                  <dt className="text-sm text-zinc-500 dark:text-zinc-400">Applications</dt>
                  <dd className="font-medium text-zinc-900 dark:text-zinc-50">{job.application_count}</dd>
                </div>
              )}
            </dl>
            <div className="mt-4 pt-4 border-t border-gray-100">
              <Link
                to={`/jobs/${id}/candidates`}
                className="flex items-center justify-center gap-2 w-full px-4 py-2 bg-zinc-900 text-white text-sm font-semibold rounded-xl hover:bg-zinc-700 transition-colors"
              >
                <Users size={15} />
                View Candidates
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
