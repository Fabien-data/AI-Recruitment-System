import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getProjects, getProjectJobs } from '../../api'

/**
 * Cascading Project → Job selector used everywhere a candidate is assigned to a
 * job (CV Manager AllocateTab, CandidateReviewModal "Assign Project" tab). Pick a
 * project first, then a job within it, with an optional category filter scoped to
 * the chosen project. Calls onChange(job|null) with the full job row so callers
 * only need { candidate_id, job_id } to create the application.
 *
 * Props:
 *   onChange(job|null)   — fired when the selected job changes
 *   excludeJobIds[]      — job ids to hide (e.g. already-applied)
 *   disabledWhenFull     — disable jobs with 0 remaining positions (default true)
 *   className            — wrapper class
 */
export default function ProjectJobSelector({
  onChange,
  excludeJobIds = [],
  disabledWhenFull = true,
  className = '',
}) {
  const [projectId, setProjectId] = useState('')
  const [jobId, setJobId] = useState('')
  const [category, setCategory] = useState('')

  const { data: projectsRaw } = useQuery({
    queryKey: ['projects', { limit: 200 }],
    queryFn: () => getProjects({ limit: 200 }),
    staleTime: 60_000,
  })
  const projects = useMemo(() => {
    const d = projectsRaw
    return Array.isArray(d?.data) ? d.data : (Array.isArray(d) ? d : [])
  }, [projectsRaw])

  const { data: jobsRaw, isLoading: jobsLoading } = useQuery({
    queryKey: ['project-jobs', projectId],
    queryFn: () => getProjectJobs(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
  })
  const projectJobs = useMemo(() => {
    const d = jobsRaw
    return Array.isArray(d?.data) ? d.data : (Array.isArray(d) ? d : [])
  }, [jobsRaw])

  const excludeSet = useMemo(() => new Set(excludeJobIds || []), [excludeJobIds])

  const categories = useMemo(() => {
    const set = new Set()
    projectJobs.forEach((j) => { if (j.category) set.add(j.category) })
    return Array.from(set).sort()
  }, [projectJobs])

  const visibleJobs = useMemo(() => {
    return projectJobs
      .filter((j) => !excludeSet.has(j.id))
      .filter((j) => !category || j.category === category)
  }, [projectJobs, excludeSet, category])

  const remainingOf = (j) =>
    Math.max(0, (Number(j.positions_available) || 0) - (Number(j.positions_filled) || 0))

  // Reset job + category when the project changes; propagate the cleared job.
  useEffect(() => {
    setJobId('')
    setCategory('')
    onChange?.(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const handleJobChange = (value) => {
    setJobId(value)
    const job = projectJobs.find((j) => j.id === value) || null
    onChange?.(job)
  }

  return (
    <div className={`space-y-3 ${className}`}>
      <div>
        <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Project</label>
        <select
          className="input w-full"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Select a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}{p.client_name ? ` — ${p.client_name}` : ''}
            </option>
          ))}
        </select>
      </div>

      {projectId && categories.length > 1 && (
        <div>
          <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Category (optional)</label>
          <select
            className="input w-full"
            value={category}
            onChange={(e) => { setCategory(e.target.value); setJobId(''); onChange?.(null) }}
          >
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Job</label>
        <select
          className="input w-full"
          value={jobId}
          onChange={(e) => handleJobChange(e.target.value)}
          disabled={!projectId || jobsLoading}
        >
          <option value="">
            {!projectId ? 'Select a project first' : (jobsLoading ? 'Loading jobs…' : (visibleJobs.length ? 'Select a job…' : 'No available jobs'))}
          </option>
          {visibleJobs.map((j) => {
            const remaining = remainingOf(j)
            const full = disabledWhenFull && (Number(j.positions_available) || 0) > 0 && remaining === 0
            return (
              <option key={j.id} value={j.id} disabled={full}>
                {j.title}{(Number(j.positions_available) || 0) > 0 ? ` — ${remaining} open` : ''}{full ? ' (full)' : ''}
              </option>
            )
          })}
        </select>
      </div>
    </div>
  )
}
