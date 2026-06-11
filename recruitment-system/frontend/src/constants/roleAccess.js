// Frontend mirror of the backend mandatory access matrix (UPGRADES.md #2).
// MUST stay in sync with backend src/middleware/sections.js ROLE_BASELINE — it
// is the single source of truth; this file mirrors it for the user form (lock +
// pre-check) and for route/nav gating. Effective access on the server is
// baseline-OR-custom, so these baseline rows are a guaranteed floor.

const ALL  = { can_view: true,  can_create: true,  can_edit: true,  can_delete: true }
const V    = { can_view: true,  can_create: false, can_edit: false, can_delete: false }
const VC   = { can_view: true,  can_create: true,  can_edit: false, can_delete: false }
const VE   = { can_view: true,  can_create: false, can_edit: true,  can_delete: false }
const VCE  = { can_view: true,  can_create: true,  can_edit: true,  can_delete: false }
const NONE = { can_view: false, can_create: false, can_edit: false, can_delete: false }

export const SECTION_KEYS = [
  'dashboard', 'projects', 'applications', 'candidates', 'cv_manager',
  'communications', 'interviews', 'jobs', 'marketing_hub', 'analytics',
  'general_pool', 'knowledge_base',
]

export const ROLE_BASELINE = {
  admin: {
    dashboard: ALL, projects: ALL, applications: ALL, candidates: ALL,
    cv_manager: ALL, communications: ALL, interviews: ALL, jobs: ALL,
    marketing_hub: ALL, analytics: ALL, general_pool: ALL, knowledge_base: ALL,
  },
  project_handler: {
    dashboard: V, projects: VCE, applications: VE, candidates: VCE,
    cv_manager: VCE, communications: VE, interviews: VCE, jobs: V,
    marketing_hub: NONE, analytics: V, general_pool: V, knowledge_base: NONE,
  },
  marketing_agent: {
    dashboard: V, projects: NONE, applications: NONE, candidates: VC,
    cv_manager: VCE, communications: VE, interviews: NONE, jobs: V,
    marketing_hub: VCE, analytics: NONE, general_pool: NONE, knowledge_base: NONE,
  },
  sourcing_department: {
    dashboard: V, projects: ALL, applications: ALL, candidates: ALL,
    cv_manager: ALL, communications: ALL, interviews: ALL, jobs: ALL,
    marketing_hub: ALL, analytics: ALL, general_pool: ALL, knowledge_base: ALL,
  },
}

const ACTION_KEYS = ['can_view', 'can_create', 'can_edit', 'can_delete']

// The mandatory baseline rows for a role as matrix `value` entries (each granted
// action ON). Admin returns [] (its matrix is hidden — admin has everything).
export function baselineRows(role) {
  const map = ROLE_BASELINE[role]
  if (!map || role === 'admin') return []
  return Object.entries(map)
    .filter(([, perms]) => ACTION_KEYS.some((a) => perms[a]))
    .map(([section_key, perms]) => ({ section_key, ...perms }))
}

// Which (section, action) cells are LOCKED-ON for a role (the baseline-granted
// actions an admin cannot un-grant). Shape: { section_key: { can_view: true, ... } }.
export function lockedActions(role) {
  const map = ROLE_BASELINE[role]
  if (!map || role === 'admin') return {}
  const out = {}
  for (const [section_key, perms] of Object.entries(map)) {
    const locked = {}
    for (const a of ACTION_KEYS) if (perms[a]) locked[a] = true
    if (Object.keys(locked).length) out[section_key] = locked
  }
  return out
}

// Merge the role's mandatory baseline with any extra (custom) rows the admin has
// granted — OR per action, so baseline is always a floor. Returns matrix `value`.
export function mergeBaseline(role, customRows = []) {
  const map = ROLE_BASELINE[role] || {}
  const byKey = new Map()
  // seed with baseline
  for (const [section_key, perms] of Object.entries(map)) {
    byKey.set(section_key, { section_key, ...perms })
  }
  // OR in custom rows
  for (const row of customRows || []) {
    if (!row?.section_key) continue
    const base = byKey.get(row.section_key) || { section_key: row.section_key, ...NONE }
    byKey.set(row.section_key, {
      section_key: row.section_key,
      can_view:   !!base.can_view   || !!row.can_view,
      can_create: !!base.can_create || !!row.can_create,
      can_edit:   !!base.can_edit   || !!row.can_edit,
      can_delete: !!base.can_delete || !!row.can_delete,
    })
  }
  // keep only rows with at least one granted action
  return [...byKey.values()].filter((r) => ACTION_KEYS.some((a) => r[a]))
}

// The extra grants beyond a role's baseline (what should actually be persisted as
// custom rows). Baseline is enforced at runtime as a floor, so we never store it.
export function extrasOf(role, rows = []) {
  const map = ROLE_BASELINE[role] || {}
  const out = []
  for (const row of rows || []) {
    if (!row?.section_key) continue
    const base = map[row.section_key] || NONE
    const extra = {
      section_key: row.section_key,
      can_view:   !!row.can_view   && !base.can_view,
      can_create: !!row.can_create && !base.can_create,
      can_edit:   !!row.can_edit   && !base.can_edit,
      can_delete: !!row.can_delete && !base.can_delete,
    }
    if (ACTION_KEYS.some((a) => extra[a])) out.push(extra)
  }
  return out
}

// Route → required (section, action) for RoleGuard wrapping in App.jsx.
// Dashboard is universal (every role has view) so it carries dashboard/view.
export const ROUTE_SECTION = {
  index:                 { section: 'dashboard',     action: 'view' },
  candidates:            { section: 'candidates',    action: 'view' },
  'candidates/:id':      { section: 'candidates',    action: 'view' },
  jobs:                  { section: 'jobs',          action: 'view' },
  'jobs/:id':            { section: 'jobs',          action: 'view' },
  'jobs/:jobId/candidates': { section: 'candidates', action: 'view' },
  projects:              { section: 'projects',      action: 'view' },
  'projects/:id':        { section: 'projects',      action: 'view' },
  'general-pool':        { section: 'general_pool',  action: 'view' },
  applications:          { section: 'applications',  action: 'view' },
  'cv-manager':          { section: 'cv_manager',    action: 'view' },
  communications:        { section: 'communications', action: 'view' },
  interviews:            { section: 'interviews',    action: 'view' },
  engagement:            { section: 'communications', action: 'view' },
  analytics:             { section: 'analytics',     action: 'view' },
  'knowledge-base':      { section: 'knowledge_base', action: 'view' },
}
