import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, ChevronDown, Plus, Star, X, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import { getMyPreferences, updateMyPreferences } from '../api'

// ── SavedViews ──────────────────────────────────────────────────────────────
// Reusable "named filter combos" control. Persists per-user via the shared
// preferences blob (prefs.savedViews) under a stable ['preferences'] query key
// so it can be invalidated/shared across the app.
//
// A saved view is { id, name, page, filters }. Only views whose `page` matches
// `pageKey` are shown here. Everything is defensively guarded — prefs may be
// {} and savedViews may be undefined on a fresh account; this never crashes.
//
// Props:
//   pageKey        string  — namespace for this page (e.g. "applications")
//   currentFilters object  — the live filter values to snapshot when saving
//   onApply        (filters) => void  — called with a saved view's filters
export default function SavedViews({ pageKey, currentFilters, onApply }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const ref = useRef(null)
  const inputRef = useRef(null)

  const { data: prefs } = useQuery({
    queryKey: ['preferences'],
    queryFn: getMyPreferences,
  })

  // Guard: prefs may be {} / null; savedViews may be undefined or non-array.
  const allViews = Array.isArray(prefs?.savedViews) ? prefs.savedViews : []
  const views = allViews.filter((v) => v && v.page === pageKey)

  // Close the dropdown on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setNaming(false) } }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Focus the name input as soon as the inline "save" form appears.
  useEffect(() => {
    if (naming && inputRef.current) inputRef.current.focus()
  }, [naming])

  const persist = useMutation({
    mutationFn: (nextViews) => updateMyPreferences({ savedViews: nextViews }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preferences'] }),
    onError: () => toast.error('Could not update saved views'),
  })

  const saveCurrent = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('Give the view a name')
      return
    }
    // Simple, collision-resistant id without Date/crypto-uuid quirks.
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const id = `${pageKey}-${slug || 'view'}-${allViews.length}`
    const next = [...allViews, { id, name: trimmed, page: pageKey, filters: currentFilters || {} }]
    persist.mutate(next, {
      onSuccess: () => {
        toast.success(`Saved view “${trimmed}”`)
        setName('')
        setNaming(false)
      },
    })
  }

  const removeView = (id) => {
    const next = allViews.filter((v) => v && v.id !== id)
    persist.mutate(next, { onSuccess: () => toast.success('View removed') })
  }

  const applyView = (view) => {
    setOpen(false)
    onApply?.(view.filters || {})
  }

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bookmark size={15} className="text-indigo-500" />
        Saved views
        {views.length > 0 && (
          <span className="inline-flex items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-900/60 text-indigo-700 dark:text-indigo-200 text-[11px] font-semibold min-w-[18px] h-[18px] px-1">
            {views.length}
          </span>
        )}
        <ChevronDown size={14} className="text-zinc-400" />
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1.5 w-72 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg overflow-hidden">
          <div className="max-h-64 overflow-y-auto py-1">
            {views.length === 0 ? (
              <p className="px-3 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                No saved views yet. Set your filters, then save them for one-click reuse.
              </p>
            ) : (
              views.map((view) => (
                <div
                  key={view.id}
                  className="group flex items-center gap-2 px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/70"
                >
                  <button
                    type="button"
                    onClick={() => applyView(view)}
                    className="flex flex-1 items-center gap-2 min-w-0 text-left text-sm text-zinc-700 dark:text-zinc-200"
                  >
                    <Star size={14} className="text-amber-400 flex-shrink-0" />
                    <span className="truncate">{view.name || 'Untitled view'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeView(view.id)}
                    disabled={persist.isPending}
                    className="flex-shrink-0 rounded-md p-1 text-zinc-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-40"
                    aria-label={`Delete saved view ${view.name || ''}`}
                    title="Delete view"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="border-t border-zinc-200 dark:border-zinc-800 p-2">
            {naming ? (
              <div className="flex items-center gap-1.5">
                <input
                  ref={inputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveCurrent() }
                    if (e.key === 'Escape') { setNaming(false); setName('') }
                  }}
                  placeholder="View name…"
                  className="input flex-1 py-1.5 text-sm"
                  aria-label="Saved view name"
                  maxLength={60}
                />
                <button
                  type="button"
                  onClick={saveCurrent}
                  disabled={persist.isPending}
                  className="flex-shrink-0 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white p-1.5 disabled:opacity-50"
                  aria-label="Confirm save view"
                  title="Save"
                >
                  <Check size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => { setNaming(false); setName('') }}
                  className="flex-shrink-0 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800 p-1.5"
                  aria-label="Cancel"
                  title="Cancel"
                >
                  <X size={15} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setNaming(true)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors"
              >
                <Plus size={15} /> Save current view
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
