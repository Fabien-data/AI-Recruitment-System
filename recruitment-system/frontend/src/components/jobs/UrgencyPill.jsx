import { Flame, Zap, Clock } from 'lucide-react'

const STYLES = {
  top_urgent: {
    label: 'Top Urgent',
    icon: Flame,
    cls: 'bg-rose-600 text-white border-transparent shadow',
  },
  urgent: {
    label: 'Urgent',
    icon: Zap,
    cls: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:border-rose-800/50',
  },
  situational: {
    label: 'Situational',
    icon: Clock,
    cls: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',
  },
}

export function UrgencyPill({ level, className = '' }) {
  if (!level || level === 'normal') return null
  const config = STYLES[level]
  if (!config) return null
  const Icon = config.icon
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${config.cls} ${className}`}
    >
      <Icon size={11} aria-hidden />
      {config.label}
    </span>
  )
}

export const URGENCY_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'situational', label: 'Situational' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'top_urgent', label: 'Top Urgent' },
]
