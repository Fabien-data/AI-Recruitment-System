import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Radar, RefreshCw, AlertTriangle, Users, Sparkles, CheckCircle2,
  CalendarClock, Archive, FolderKanban, TrendingDown,
} from 'lucide-react'
import { getControlTowerHealth } from '../api'
import { PageHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { EmptyState } from '../components/ui/EmptyState'
import { StatCardSkeleton, TableSkeleton } from '../components/ui/Skeleton'
import { Button } from '../components/ui/Button'
import { getStatusLabel } from '../constants/lifecycle'

// Summary tiles map onto the pipeline buckets returned by /api/control-tower.
// `total_stuck` gets its own attention-grabbing rose tile.
const PIPELINE_TILES = [
  { key: 'new', label: 'New', icon: Users, color: 'bg-blue-500' },
  { key: 'screening', label: 'Screening', icon: Sparkles, color: 'bg-amber-500' },
  { key: 'certified', label: 'Certified', icon: CheckCircle2, color: 'bg-emerald-500' },
  { key: 'interview_scheduled', label: 'Interview Scheduled', icon: CalendarClock, color: 'bg-indigo-500' },
  { key: 'future_pool', label: 'Future Pool', icon: Archive, color: 'bg-slate-500' },
]

const DAYS_OPTIONS = [2, 3, 7]

function SummaryTile({ label, value, icon: Icon, color }) {
  return (
    <Card className="hover:shadow-card-hover transition-shadow">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400 truncate">{label}</p>
          <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50 mt-1">{value}</p>
        </div>
        <div className={`p-3 rounded-2xl shrink-0 ${color}`}>
          <Icon size={20} className="text-white" />
        </div>
      </div>
    </Card>
  )
}

// Amber for any stuck, rose once it crosses the "needs attention" threshold.
function StuckBadge({ count }) {
  if (!count || count <= 0) {
    return <span className="text-sm text-zinc-400 dark:text-zinc-600">—</span>
  }
  const severe = count >= 5
  const cls = severe
    ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/50'
    : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50'
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${cls}`}>
      <AlertTriangle size={11} className="opacity-80" aria-hidden="true" />
      {count}
    </span>
  )
}

// A row is a bottleneck when it has stuck candidates OR a fat screening backlog
// that isn't converting to certified (lots in screening, little progressing).
function isBottleneck(p) {
  const screening = Number(p.screening_count) || 0
  const certified = Number(p.certified_count) || 0
  const stuck = Number(p.stuck_count) || 0
  const screeningBacklog = screening >= 5 && certified === 0
  return stuck >= 5 || screeningBacklog
}

function CountCell({ value, emphasize = false }) {
  const n = Number(value) || 0
  return (
    <td className={`py-3 px-3 text-right tabular-nums ${emphasize && n > 0 ? 'font-semibold text-zinc-900 dark:text-zinc-50' : 'text-zinc-600 dark:text-zinc-400'}`}>
      {n}
    </td>
  )
}

export default function SourcingControlTower() {
  const [days, setDays] = useState(2)

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['control-tower', days],
    queryFn: () => getControlTowerHealth(days),
    staleTime: 60_000,
  })

  const projects = data?.projects || []
  const pipeline = data?.pipeline || {}
  const totalStuck = data?.total_stuck ?? 0
  const generatedAt = data?.generated_at

  const daysSelector = (
    <select
      value={days}
      onChange={(e) => setDays(Number(e.target.value))}
      className="border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 rounded-2xl px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary-500/30"
      aria-label="Stuck window (days)"
    >
      {DAYS_OPTIONS.map((d) => (
        <option key={d} value={d}>Stuck after {d} day{d > 1 ? 's' : ''}</option>
      ))}
    </select>
  )

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={Radar}
        tone="mixed"
        title="Sourcing Control Tower"
        subtitle="Live pipeline health and per-project bottlenecks across active sourcing"
        actions={
          <>
            {daysSelector}
            <Button variant="secondary" size="sm" onClick={() => refetch()} loading={isFetching}>
              <RefreshCw size={14} />
              Refresh
            </Button>
          </>
        }
      />

      {/* Summary tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-8">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            {PIPELINE_TILES.map((t) => (
              <SummaryTile
                key={t.key}
                label={t.label}
                value={pipeline[t.key] ?? 0}
                icon={t.icon}
                color={t.color}
              />
            ))}
            <SummaryTile
              label="Total Stuck"
              value={totalStuck}
              icon={AlertTriangle}
              color={totalStuck > 0 ? 'bg-rose-500' : 'bg-zinc-400'}
            />
          </>
        )}
      </div>

      {/* Projects table */}
      <Card className="p-0 overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-5 pt-5 pb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2 text-zinc-900 dark:text-zinc-50">
            <FolderKanban size={18} />
            Active Projects
          </h2>
          {generatedAt && (
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              Updated {new Date(generatedAt).toLocaleString()}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="px-5 pb-5">
            <TableSkeleton rows={6} cols={8} />
          </div>
        ) : isError ? (
          <EmptyState
            icon={AlertTriangle}
            tone="rose"
            title="Couldn't load control tower"
            description={error?.response?.data?.error || error?.message || 'Something went wrong fetching pipeline health.'}
            action={
              <Button variant="secondary" size="sm" onClick={() => refetch()}>
                <RefreshCw size={14} />
                Try again
              </Button>
            }
          />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title="No active projects"
            description="There are no active sourcing projects to monitor right now."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-zinc-500 dark:text-zinc-400 border-y border-zinc-200/70 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/30">
                <tr>
                  <th className="py-2.5 px-5 font-medium">Project</th>
                  <th className="py-2.5 px-3 font-medium text-right">Jobs</th>
                  <th className="py-2.5 px-3 font-medium text-right">Applications</th>
                  <th className="py-2.5 px-3 font-medium text-right">Screening</th>
                  <th className="py-2.5 px-3 font-medium text-right">Certified</th>
                  <th className="py-2.5 px-3 font-medium text-right">Interview</th>
                  <th className="py-2.5 px-3 font-medium text-right">Hired</th>
                  <th className="py-2.5 px-5 font-medium text-right">Stuck</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {projects.map((p) => {
                  const bottleneck = isBottleneck(p)
                  return (
                    <tr
                      key={p.id}
                      className={`group transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${bottleneck ? 'bg-rose-50/40 dark:bg-rose-950/10' : ''}`}
                    >
                      <td className="py-3 px-5">
                        <div className="flex items-center gap-2 min-w-0">
                          {bottleneck && (
                            <span title="Bottleneck: stuck candidates or screening backlog">
                              <TrendingDown size={15} className="text-rose-500 shrink-0" aria-hidden="true" />
                            </span>
                          )}
                          <Link
                            to={`/projects/${p.id}`}
                            className="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 truncate"
                          >
                            {p.title}
                          </Link>
                          {p.status && p.status !== 'active' && (
                            <Badge status={p.status} className="shrink-0">{getStatusLabel(p.status)}</Badge>
                          )}
                        </div>
                      </td>
                      <CountCell value={p.job_count} />
                      <CountCell value={p.total_applications} emphasize />
                      <CountCell value={p.screening_count} />
                      <CountCell value={p.certified_count} />
                      <CountCell value={p.interview_count} />
                      <CountCell value={p.hired_count} />
                      <td className="py-3 px-5 text-right">
                        <StuckBadge count={Number(p.stuck_count) || 0} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Legend */}
      {!isLoading && !isError && projects.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1.5">
            <TrendingDown size={13} className="text-rose-500" aria-hidden="true" />
            Bottleneck — stuck candidates or a stalled screening backlog
          </span>
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle size={13} className="text-amber-500" aria-hidden="true" />
            Stuck — no movement in the selected window
          </span>
        </div>
      )}
    </div>
  )
}
