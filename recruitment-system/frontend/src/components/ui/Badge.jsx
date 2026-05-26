import { clsx } from 'clsx'

const statusMap = {
  new: 'badge badge-new',
  screening: 'badge badge-screening',
  interview: 'badge badge-interview',
  hired: 'badge badge-hired',
  rejected: 'badge badge-rejected',
  future_pool: 'badge bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
  active: 'badge badge-active',
  paused: 'badge badge-paused',
  closed: 'badge badge-closed',
  filled: 'badge badge-closed',
  applied: 'badge badge-new',
  certified: 'badge badge-screening',
  interview_scheduled: 'badge badge-interview',
  interviewed: 'badge badge-interview',
  selected: 'badge badge-hired',
  placed: 'badge badge-hired',
  planning: 'badge bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-300 dark:border-yellow-800/50',
  on_hold: 'badge bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800/50',
  completed: 'badge bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/50',
  cancelled: 'badge bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/50',
  normal: 'badge bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
  high: 'badge bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800/50',
  urgent: 'badge bg-accent-gradient text-white border-transparent shadow-glow-red animate-pulse-glow',
}

export function Badge({ status, children, className, icon: Icon }) {
  const label = children ?? status
  const variant = statusMap[status] || 'badge bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700'
  return (
    <span className={clsx(variant, className)}>
      {Icon && <Icon size={11} className="opacity-80" aria-hidden="true" />}
      {label}
    </span>
  )
}
