// Single source of truth for application/candidate lifecycle, industries,
// and benefits. Pages that previously hardcoded these lists should import
// from here so we only update one place when the model changes.

// ── Application status lifecycle (in order) ─────────────────────────────────
// Backend column: applications.status (TEXT)
// Flow: applied → certified → pre_screened → interview_scheduled → selected | rejected
// Legacy values still in the DB (screening, interviewed, placed) are tolerated
// but not produced by new UI flows.
export const APPLICATION_STATUSES = [
  'applied',
  'certified',
  'pre_screened',
  'interview_scheduled',
  'selected',
  'rejected',
  'placed',
]

export const STATUS_LABELS = {
  applied: 'Applied',
  certified: 'Certified',
  pre_screened: 'Pre Screened',
  interview_scheduled: 'Scheduled',
  interviewed: 'Interviewed',
  selected: 'Selected',
  rejected: 'Rejected',
  placed: 'Placed',
  screening: 'Screening',
  auto_assigned: 'Auto-Matched',
  reviewing: 'In Review',
}

// Tailwind classes for status badges. Pair with the existing `badge` base.
export const STATUS_COLORS = {
  applied: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/50',
  certified: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50',
  pre_screened: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-800/50',
  interview_scheduled: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800/50',
  interviewed: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800/50',
  selected: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800/50',
  rejected: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/50',
  placed: 'bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50',
  screening: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',
  auto_assigned: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/40 dark:text-sky-300 dark:border-sky-800/50',
  reviewing: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',
}

// Valid status transitions enforced by the UI. The backend re-validates.
export const STATUS_TRANSITIONS = {
  // Entry states from sourcing / auto-match — must be certifiable (B011).
  auto_assigned: ['certified', 'rejected'],
  reviewing: ['certified', 'rejected'],
  applied: ['certified', 'rejected'],
  certified: ['pre_screened', 'rejected'],
  pre_screened: ['interview_scheduled', 'rejected'],
  interview_scheduled: ['selected', 'rejected', 'interviewed'],
  interviewed: ['selected', 'rejected'],
  selected: ['placed'],
  rejected: [],
  placed: [],
}

export function canTransition(from, to) {
  if (!from) return to === 'applied'
  return (STATUS_TRANSITIONS[from] || []).includes(to)
}

export function getStatusLabel(status) {
  return STATUS_LABELS[status] || status
}

// Filter dropdown options — what we show in status filter UIs.
// (Excludes terminal-only-from-elsewhere statuses like `placed`.)
export const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'applied', label: 'Applied' },
  { value: 'certified', label: 'Certified' },
  { value: 'pre_screened', label: 'Pre Screened' },
  { value: 'interview_scheduled', label: 'Scheduled' },
  { value: 'selected', label: 'Selected' },
  { value: 'rejected', label: 'Rejected' },
]

// ── Industries (Project create/edit) ────────────────────────────────────────
// Stored on projects.industry_types as a JSONB array of strings.
// "Other" is not a literal value — selecting it reveals a free-text input
// whose value is appended to the array as a normal chip.
export const INDUSTRY_OPTIONS = [
  'Hypermarket',
  'Restaurant',
  'Construction',
  'Healthcare',
  'Hospitality',
  'Manufacturing',
  'Retail',
  'Logistics',
  'Security',
  'IT Services',
  'Education',
  'Agriculture',
  'Oil & Gas',
  'Cleaning Services',
]

// ── Benefits (Project create/edit) ──────────────────────────────────────────
// Stored on projects.benefits as a JSONB object: { key: boolean }.
// `meals_included` and `meals_not_included` are mutually exclusive at the UI
// layer — selecting one auto-clears the other.
export const BENEFIT_OPTIONS = [
  { key: 'accommodation', label: 'Accommodation' },
  { key: 'transport', label: 'Transport' },
  { key: 'meals', label: 'Meals' },
  { key: 'meals_included', label: 'Meals included in salary', exclusiveWith: 'meals_not_included' },
  { key: 'meals_not_included', label: 'Meals NOT included in salary', exclusiveWith: 'meals_included' },
  { key: 'medical', label: 'Medical Coverage' },
  { key: 'visa', label: 'Visa' },
  { key: 'ticket', label: 'Air Ticket' },
]

export const DEFAULT_BENEFITS_STATE = Object.fromEntries(
  BENEFIT_OPTIONS.map(({ key }) => [key, false]),
)
