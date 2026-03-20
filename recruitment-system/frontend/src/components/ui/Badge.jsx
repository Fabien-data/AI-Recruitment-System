import { clsx } from 'clsx'

const statusMap = {
  new: 'badge badge-new',
  screening: 'badge badge-screening',
  interview: 'badge badge-interview',
  hired: 'badge badge-hired',
  rejected: 'badge badge-rejected',
  future_pool: 'badge bg-gray-100 text-gray-700',
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
  // Project statuses
  planning: 'badge bg-yellow-100 text-yellow-700 border border-yellow-200',
  on_hold: 'badge bg-orange-100 text-orange-700 border border-orange-200',
  completed: 'badge bg-blue-100 text-blue-700 border border-blue-200',
  cancelled: 'badge bg-red-100 text-red-700 border border-red-200',
  // Priority badges
  normal: 'badge bg-gray-100 text-gray-600',
  high: 'badge bg-orange-100 text-orange-700 border border-orange-300',
  urgent: 'badge bg-red-100 text-red-700 border border-red-300 animate-pulse',
}

export function Badge({ status, children, className }) {
  const label = children ?? status
  const variant = statusMap[status] || 'badge bg-gray-100 text-gray-700'
  return <span className={clsx(variant, className)}>{label}</span>
}

