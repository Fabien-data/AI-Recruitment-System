import { clsx } from 'clsx'
import { STATUS_COLORS, STATUS_LABELS } from '../../constants/lifecycle'

// Pre-built badge classes already shipped in tailwind.config — keep using them
// for statuses that have dedicated tokens (badge-new, badge-active, etc.).
// Lifecycle statuses use the centralized STATUS_COLORS map so all places that
// render application status stay visually consistent.
const statusMap = {
  // Candidate statuses
  new: 'badge badge-new',
  screening: `badge ${STATUS_COLORS.screening}`,
  interview: 'badge badge-interview',
  hired: 'badge badge-hired',
  rejected: `badge ${STATUS_COLORS.rejected}`,
  future_pool: 'badge bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',

  // Job / project statuses
  active: 'badge badge-active',
  paused: 'badge badge-paused',
  closed: 'badge badge-closed',
  filled: 'badge badge-closed',
  inactive: 'badge bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
  complete: 'badge bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/50',
  future: 'badge bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800/50',
  pending_review: 'badge bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',

  // Application lifecycle (centralized colors)
  applied: `badge ${STATUS_COLORS.applied}`,
  certified: `badge ${STATUS_COLORS.certified}`,
  pre_screened: `badge ${STATUS_COLORS.pre_screened}`,
  interview_scheduled: `badge ${STATUS_COLORS.interview_scheduled}`,
  interviewed: `badge ${STATUS_COLORS.interviewed}`,
  selected: `badge ${STATUS_COLORS.selected}`,
  placed: `badge ${STATUS_COLORS.placed}`,

  // Project lifecycle
  planning: 'badge bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800/50',
  on_hold: 'badge bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800/50',
  completed: 'badge bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/50',
  cancelled: 'badge bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/50',

  // Priority
  normal: 'badge bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
  high: 'badge bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800/50',
  urgent: 'badge bg-accent-gradient text-white border-transparent shadow-glow-red animate-pulse-glow',
}

export function Badge({ status, children, className, icon: Icon }) {
  const label = children ?? STATUS_LABELS[status] ?? status
  const variant = statusMap[status] || 'badge bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700'
  return (
    <span className={clsx(variant, className)}>
      {Icon && <Icon size={11} className="opacity-80" aria-hidden="true" />}
      {label}
    </span>
  )
}
