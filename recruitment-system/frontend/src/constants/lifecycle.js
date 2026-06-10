// Single source of truth for application/candidate lifecycle, industries,
// and benefits. Pages MUST import from here instead of hardcoding status
// strings so the canonical vocabulary (UPGRADES.md #1) lives in one place.
//
// ── Canonical vocabulary (UPGRADES.md #1) ───────────────────────────────────
//   candidate.status  (7): new, screening, certified, interview_scheduled,
//                          future_pool, merged, hired
//   application.status (5): screening, certified, interview_scheduled, hired,
//                          rejected
// Legacy values may still appear on un-migrated rows briefly; normalizeStatus()
// folds them onto the canonical set so reads/labels/colors stay correct.

// ── Application status lifecycle (in order) ─────────────────────────────────
// Flow: screening → certified → interview_scheduled → hired (| rejected at any step)
export const APPLICATION_STATUSES = [
  'screening',
  'certified',
  'interview_scheduled',
  'hired',
  'rejected',
]

// ── Candidate status vocabulary (the 7) ─────────────────────────────────────
export const CANDIDATE_STATUSES = [
  'new', 'screening', 'certified', 'interview_scheduled',
  'future_pool', 'merged', 'hired',
]
// First 4 = the agent pipeline (Messages tabs). Last 3 = terminal/protected.
export const CANDIDATE_PIPELINE_STATUSES = ['new', 'screening', 'certified', 'interview_scheduled']
export const CANDIDATE_PROTECTED_STATUSES = ['future_pool', 'merged', 'hired']

// Legacy → canonical map. Used to normalize any value read from a not-yet-
// migrated row (and to keep transition/fold logic back-compatible).
export const LEGACY_STATUS_MAP = {
  applied: 'screening',
  auto_assigned: 'screening',
  reviewing: 'screening',
  pre_screened: 'certified',
  interviewed: 'interview_scheduled',
  selected: 'interview_scheduled',
  placed: 'hired',
  transferred: 'rejected',
}

// Normalize any (possibly legacy) status string onto the canonical vocabulary.
// Canonical values (and candidate-only values like new/future_pool/merged/hired)
// pass through unchanged.
export function normalizeStatus(status) {
  if (!status) return status
  return LEGACY_STATUS_MAP[status] || status
}
// Alias for clarity at application-status call sites.
export const normalizeApplicationStatus = normalizeStatus

export const STATUS_LABELS = {
  // Canonical candidate + application
  new: 'New',
  screening: 'Screening',
  certified: 'Certified',
  interview_scheduled: 'Interview Scheduled',
  future_pool: 'Future Pool',
  merged: 'Merged',
  hired: 'Hired',
  rejected: 'Rejected',
  // Legacy (rendered only if an un-normalized value slips through)
  applied: 'Applied',
  pre_screened: 'Pre Screened',
  interviewed: 'Interviewed',
  selected: 'Selected',
  placed: 'Placed',
  auto_assigned: 'Auto-Matched',
  reviewing: 'In Review',
}

// Tailwind classes for status badges. Pair with the existing `badge` base.
export const STATUS_COLORS = {
  new: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800/50',
  screening: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',
  certified: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50',
  interview_scheduled: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800/50',
  future_pool: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-800/40 dark:text-slate-300 dark:border-slate-700/50',
  merged: 'bg-zinc-50 text-zinc-600 border-zinc-200 dark:bg-zinc-800/40 dark:text-zinc-300 dark:border-zinc-700/50',
  hired: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800/50',
  rejected: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/50',
  // Legacy fallbacks
  applied: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',
  pre_screened: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50',
  interviewed: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800/50',
  selected: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-300 dark:border-indigo-800/50',
  placed: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800/50',
  auto_assigned: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',
  reviewing: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',
}

// Valid application-status transitions enforced by the UI. The backend
// re-validates (applications.js VALID_TRANSITIONS — keep these in sync).
export const STATUS_TRANSITIONS = {
  screening: ['certified', 'rejected'],
  certified: ['interview_scheduled', 'rejected'],
  interview_scheduled: ['hired', 'rejected'],
  hired: [],
  rejected: [],
}

export function canTransition(from, to) {
  const f = normalizeStatus(from)
  const t = normalizeStatus(to)
  if (!f) return t === 'screening'
  return (STATUS_TRANSITIONS[f] || []).includes(t)
}

export function getStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS[normalizeStatus(status)] || status
}

// Tailwind color string for a status badge (normalized; grey fallback).
export function getStatusColor(status) {
  return (
    STATUS_COLORS[status] ||
    STATUS_COLORS[normalizeStatus(status)] ||
    'bg-gray-50 text-gray-700 border-gray-200 dark:bg-gray-800/40 dark:text-gray-300 dark:border-gray-700/50'
  )
}

// Filter dropdown options — canonical application statuses.
export const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'screening', label: 'Screening' },
  { value: 'certified', label: 'Certified' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
  { value: 'hired', label: 'Hired' },
  { value: 'rejected', label: 'Rejected' },
]

// ── Candidate lifecycle stages (candidate.status) ────────────────────────────
// The 4-stage forward pipeline shown on the candidate everywhere. Backend
// derives candidate.status from the furthest-along application.
export const CANDIDATE_STAGES = CANDIDATE_PIPELINE_STATUSES

export const CANDIDATE_STAGE_LABELS = {
  new: 'New',
  screening: 'Screening',
  certified: 'Certified',
  interview_scheduled: 'Interview Scheduled',
  future_pool: 'Future Pool',
  merged: 'Merged',
  hired: 'Hired',
}

const APP_STATUS_TO_CANDIDATE_STAGE = {
  screening: 'screening',
  certified: 'certified',
  interview_scheduled: 'interview_scheduled',
  // Legacy app statuses fold the same way
  applied: 'screening',
  auto_assigned: 'screening',
  reviewing: 'screening',
  pre_screened: 'certified',
  interviewed: 'interview_scheduled',
  selected: 'interview_scheduled',
  placed: 'interview_scheduled',
  // hired / rejected / transferred / merged → null (not a forward pipeline stage)
}

// Fold a per-application status down to the candidate's canonical pipeline stage.
export function foldToCandidateStage(appStatus) {
  return APP_STATUS_TO_CANDIDATE_STAGE[appStatus] || null
}

// Prefer the candidate-stage label, fall back to the application-status label.
export function getStageLabel(status) {
  return (
    CANDIDATE_STAGE_LABELS[status] ||
    STATUS_LABELS[status] ||
    STATUS_LABELS[normalizeStatus(status)] ||
    status
  )
}

// Candidate-stage filter options for CV Manager / candidate lists.
export const CANDIDATE_STAGE_FILTER_OPTIONS = [
  { value: '', label: 'All stages' },
  { value: 'new', label: 'New' },
  { value: 'screening', label: 'Screening' },
  { value: 'certified', label: 'Certified' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
  { value: 'future_pool', label: 'Future Pool' },
]

// Messages workspace status buckets (mutually exclusive tabs). "All chats"
// (value '') is the default and sends NO status filter — the backend then
// returns every conversation. Followed by the pipeline 4 + Future Pool. Shared
// so pages don't redefine this locally.
export const CANDIDATE_STATUS_BUCKETS = [
  { value: '', label: 'All chats' },
  { value: 'new', label: 'New' },
  { value: 'screening', label: 'Screening' },
  { value: 'certified', label: 'Certified' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
  { value: 'future_pool', label: 'Future Pool' },
]

// Candidate statuses an agent can manually set from the candidate edit/stage UIs.
// Terminal/protected merged & hired are set by system flows (merge, placement),
// not a free dropdown — so the manual list is the 4 pipeline values + future_pool.
export const CANDIDATE_MANUAL_STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'screening', label: 'Screening' },
  { value: 'certified', label: 'Certified' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
  { value: 'future_pool', label: 'Future Pool' },
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
