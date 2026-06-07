import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Briefcase, ChevronDown, ChevronRight, DollarSign, MapPin, Layers,
  Users, CalendarClock, AlertTriangle, ExternalLink, ListChecks,
} from 'lucide-react'
import { getJob } from '../../api'

// Job cheat-sheet that sits in the Communications right sidebar (UPGRADES.md #3.2).
// A marketing agent onboarding a candidate from chat can see the applied role's
// salary / country / requirements / positions WITHOUT leaving the conversation or
// losing their filter — the #1 agent pain point. Mirrors ConversationDocumentsPanel's
// collapsible-card pattern. `jobId` is the conversation's effective_job_id
// (latest application's job, falling back to the CTWA ad's job).
export function JobDrawer({ jobId, defaultExpanded = true }) {
  const { data: job, isLoading, isError } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => getJob(jobId),
    enabled: !!jobId,
  })

  const [expanded, setExpanded] = useState(defaultExpanded)

  // No resolved job for this conversation (lead with no application / no ad job).
  if (!jobId) return null

  const positions = job
    ? `${job.positions_filled ?? 0}/${job.positions_available ?? '—'}`
    : '—'
  const deadline = job?.deadline ? new Date(job.deadline) : null

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-t-2xl hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          {expanded ? (
            <ChevronDown size={16} className="text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
          ) : (
            <ChevronRight size={16} className="text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
          )}
          <Briefcase size={15} className="text-primary-600 dark:text-primary-400 flex-shrink-0" />
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate" title={job?.title || 'Applied role'}>
            {job?.title || 'Applied role'}
          </h3>
        </div>
        {job?.is_urgent && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-[10px] font-semibold flex-shrink-0">
            URGENT
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-zinc-100 dark:border-zinc-800/60 pt-3">
          {isLoading ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-2">Loading job…</p>
          ) : isError || !job ? (
            <p className="text-xs text-amber-700 dark:text-amber-400 inline-flex items-center gap-1 py-2">
              <AlertTriangle size={11} /> Couldn’t load this job.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <Fact icon={DollarSign} label="Salary" value={job.salary_range} />
                <Fact icon={MapPin} label="Country" value={job.location || job.country} />
                <Fact icon={Layers} label="Category" value={job.category || job.domain} />
                <Fact icon={Users} label="Positions" value={positions} />
                {deadline && (
                  <Fact
                    icon={CalendarClock}
                    label="Deadline"
                    value={deadline.toLocaleDateString()}
                  />
                )}
                {job.project_title && (
                  <Fact icon={Briefcase} label="Project" value={job.project_title} />
                )}
              </div>

              {job.requirements && (
                <Section icon={ListChecks} title="Requirements">
                  {job.requirements}
                </Section>
              )}
              {job.description && (
                <Section title="Details">{job.description}</Section>
              )}

              <Link
                to={`/jobs/${job.id}`}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary-600 dark:text-primary-400 hover:underline pt-1"
              >
                Open full job <ExternalLink size={11} />
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Fact({ icon: Icon, label, value }) {
  if (!value) return null
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 inline-flex items-center gap-1">
        {Icon && <Icon size={10} />} {label}
      </p>
      <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate" title={String(value)}>
        {value}
      </p>
    </div>
  )
}

function Section({ icon: Icon, title, children }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1 inline-flex items-center gap-1">
        {Icon && <Icon size={10} />} {title}
      </p>
      <p className="text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-line line-clamp-5">{children}</p>
    </div>
  )
}
