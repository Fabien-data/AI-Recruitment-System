import { useQuery } from '@tanstack/react-query'
import {
  LayoutDashboard, FileSearch, Briefcase, Users, FolderKanban, FileText,
  CalendarDays, MessageSquare, BarChart2, BookOpen, Megaphone, Database,
  ShieldCheck, Eye, Plus, Pencil, Trash2,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { getSections } from '../../api'

// Maps the icon string stored in the sections table back to a Lucide component.
// Falls back to ShieldCheck so unknown keys never crash the matrix.
const ICONS = {
  LayoutDashboard, FileSearch, Briefcase, Users, FolderKanban, FileText,
  CalendarDays, MessageSquare, BarChart2, BookOpen, Megaphone, Database,
}

const ACTIONS = [
  { key: 'can_view',   label: 'View',   short: 'V', icon: Eye,    tone: 'blue' },
  { key: 'can_create', label: 'Create', short: 'C', icon: Plus,   tone: 'emerald' },
  { key: 'can_edit',   label: 'Edit',   short: 'E', icon: Pencil, tone: 'amber' },
  { key: 'can_delete', label: 'Delete', short: 'D', icon: Trash2, tone: 'rose' },
]

// Tailwind colour pairs per action chip. Tailwind needs the full class strings
// at build time, so each tone is enumerated explicitly here.
const TONES = {
  blue:    { on: 'bg-blue-500 text-white border-blue-600 shadow-glow-blue/30',
             off: 'bg-white text-blue-600 border-blue-200 hover:bg-blue-50 dark:bg-zinc-900 dark:text-blue-300 dark:border-blue-900/50 dark:hover:bg-blue-950/40' },
  emerald: { on: 'bg-emerald-500 text-white border-emerald-600',
             off: 'bg-white text-emerald-600 border-emerald-200 hover:bg-emerald-50 dark:bg-zinc-900 dark:text-emerald-300 dark:border-emerald-900/50 dark:hover:bg-emerald-950/40' },
  amber:   { on: 'bg-amber-500 text-white border-amber-600',
             off: 'bg-white text-amber-600 border-amber-200 hover:bg-amber-50 dark:bg-zinc-900 dark:text-amber-300 dark:border-amber-900/50 dark:hover:bg-amber-950/40' },
  rose:    { on: 'bg-rose-500 text-white border-rose-600',
             off: 'bg-white text-rose-600 border-rose-200 hover:bg-rose-50 dark:bg-zinc-900 dark:text-rose-300 dark:border-rose-900/50 dark:hover:bg-rose-950/40' },
}

function PermChip({ tone, active, onClick, disabled, label, short, Icon }) {
  const cls = active ? TONES[tone].on : TONES[tone].off
  return (
    <motion.button
      type="button"
      whileTap={disabled ? undefined : { scale: 0.94 }}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`group inline-flex items-center justify-center gap-1 rounded-xl border px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all
        ${cls}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:-translate-y-px'}`}
    >
      <Icon size={12} aria-hidden />
      <span>{short}</span>
    </motion.button>
  )
}

/**
 * SectionPermissionMatrix
 * ------------------------
 *
 * Controlled component for the per-section CRUD permission grid.
 *
 * Props:
 *  - value:     array of { section_key, can_view, can_create, can_edit, can_delete }
 *  - onChange:  (next) => void  — receives the FULL updated array
 *  - disabled:  boolean — admin users always see the matrix in read-only mode
 *               with a banner explaining that admins implicitly have everything
 *
 * The component loads the sections catalogue once via TanStack Query and merges
 * it with the supplied `value` so missing rows render as all-off (and any
 * server-side row not in the catalogue is silently dropped).
 */
export default function SectionPermissionMatrix({ value = [], onChange, disabled = false }) {
  const { data: sections = [], isLoading } = useQuery({
    queryKey: ['admin', 'sections'],
    queryFn: getSections,
    staleTime: 5 * 60 * 1000, // sections rarely change
  })

  const byKey = new Map((value || []).map(p => [p.section_key, p]))

  const handleToggle = (sectionKey, permKey) => {
    if (disabled) return
    const existing = byKey.get(sectionKey) || {
      section_key: sectionKey,
      can_view: false, can_create: false, can_edit: false, can_delete: false,
    }
    const next = { ...existing, [permKey]: !existing[permKey] }

    // Auto-rule: enabling Create/Edit/Delete implies View. The admin can still
    // un-toggle View afterwards, but defaulting it on avoids the surprising
    // "I gave them delete but they can't see anything" state.
    if (permKey !== 'can_view' && next[permKey] && !next.can_view) {
      next.can_view = true
    }

    const filtered = (value || []).filter(p => p.section_key !== sectionKey)
    onChange?.([...filtered, next])
  }

  const handleAllForSection = (sectionKey, on) => {
    if (disabled) return
    const next = {
      section_key: sectionKey,
      can_view:   on, can_create: on, can_edit: on, can_delete: on,
    }
    const filtered = (value || []).filter(p => p.section_key !== sectionKey)
    onChange?.([...filtered, next])
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-24 rounded-2xl border border-zinc-200/60 bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="font-semibold uppercase tracking-wider">Legend:</span>
        {ACTIONS.map(a => (
          <span key={a.key} className="inline-flex items-center gap-1.5">
            <a.icon size={12} className={`text-${a.tone === 'emerald' ? 'emerald' : a.tone === 'amber' ? 'amber' : a.tone === 'rose' ? 'rose' : 'blue'}-500`} />
            <span>{a.label}</span>
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sections.map(s => {
          const Icon = ICONS[s.icon] || ShieldCheck
          const row = byKey.get(s.key) || { can_view: false, can_create: false, can_edit: false, can_delete: false }
          const allOn = ACTIONS.every(a => row[a.key])
          return (
            <motion.div
              key={s.key}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className={`relative rounded-2xl border ${allOn ? 'border-primary-300 dark:border-primary-700/50' : 'border-zinc-200/60 dark:border-zinc-800'} bg-white dark:bg-zinc-900 p-4 transition-colors`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${allOn ? 'bg-brand-gradient text-white shadow-glow-blue' : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>
                    <Icon size={15} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{s.name}</p>
                    {s.description && (
                      <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{s.description}</p>
                    )}
                  </div>
                </div>
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => handleAllForSection(s.key, !allOn)}
                    className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 hover:text-primary-600 dark:hover:text-primary-300 transition-colors"
                    title={allOn ? 'Revoke all' : 'Grant all'}
                  >
                    {allOn ? 'Revoke' : 'Grant all'}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ACTIONS.map(a => (
                  <PermChip
                    key={a.key}
                    tone={a.tone}
                    active={!!row[a.key]}
                    onClick={() => handleToggle(s.key, a.key)}
                    disabled={disabled}
                    label={`${a.label} ${s.name}`}
                    short={a.short}
                    Icon={a.icon}
                  />
                ))}
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
