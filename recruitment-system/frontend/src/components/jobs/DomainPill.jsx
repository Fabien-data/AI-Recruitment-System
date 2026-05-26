import { Globe2 } from 'lucide-react'

const LABELS = {
  middle_east: 'Middle East',
  europe: 'Europe',
}

const STYLES = {
  middle_east: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50',
  europe: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800/50',
}

export function DomainPill({ domain, className = '' }) {
  if (!domain) return null
  const cls = STYLES[domain] || 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cls} ${className}`}
    >
      <Globe2 size={11} aria-hidden />
      {LABELS[domain] || domain}
    </span>
  )
}

export const DOMAIN_OPTIONS = [
  { value: '', label: 'Any region' },
  { value: 'middle_east', label: 'Middle East' },
  { value: 'europe', label: 'Europe' },
]
