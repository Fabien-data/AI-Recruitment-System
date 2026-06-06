/**
 * DispositionSelect — the agent's call outcome / lead status for a candidate.
 * Values mirror the backend DISPOSITIONS list (app-validated, no DB CHECK).
 */
export const DISPOSITIONS = [
  { value: '', label: '— Set lead status —' },
  { value: 'new', label: 'New' },
  { value: 'attempted', label: 'Attempted' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'interested', label: 'Interested' },
  { value: 'callback', label: 'Callback' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'unreachable', label: 'Unreachable' },
]

export const dispositionClasses = (v) => {
  switch (v) {
    case 'interested':
    case 'qualified': return 'bg-emerald-100 text-emerald-700'
    case 'callback': return 'bg-amber-100 text-amber-700'
    case 'contacted':
    case 'attempted': return 'bg-sky-100 text-sky-700'
    case 'not_interested':
    case 'unreachable': return 'bg-rose-100 text-rose-700'
    case 'new': return 'bg-zinc-100 text-zinc-600'
    default: return 'bg-zinc-100 text-zinc-500'
  }
}

export const dispositionLabel = (v) =>
  (DISPOSITIONS.find((d) => d.value === v)?.label) || v || '—'

export function DispositionSelect({ value, onChange, disabled }) {
  return (
    <select
      value={value || ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400 disabled:opacity-60"
    >
      {/* Hide the "— Set lead status —" placeholder once a status exists so it
          can't be selected as a confusing no-op (the value can still be changed
          to any of the 8 statuses). */}
      {DISPOSITIONS.filter((d) => d.value || !value).map((d) => (
        <option key={d.value || 'none'} value={d.value}>{d.label}</option>
      ))}
    </select>
  )
}
