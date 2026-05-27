import { useEffect, useState } from 'react'
import { LayoutGrid, Table2 } from 'lucide-react'
import { clsx } from 'clsx'

// useViewMode — small hook for Card/Table preference, persisted in
// localStorage per page. Defaults to "card" so users see the new
// layout first time.
export function useViewMode(storageKey, defaultMode = 'card') {
  const [mode, setMode] = useState(() => {
    if (typeof window === 'undefined') return defaultMode
    try {
      return window.localStorage.getItem(storageKey) || defaultMode
    } catch {
      return defaultMode
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, mode)
    } catch {
      /* private mode / disabled storage — no-op */
    }
  }, [storageKey, mode])

  return [mode, setMode]
}

// Compact 2-button toggle that fits next to a PageHeader's primary CTA.
export function ViewToggle({ mode, onChange, className }) {
  return (
    <div
      role="tablist"
      aria-label="View mode"
      className={clsx(
        'inline-flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-0.5',
        className,
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'card'}
        onClick={() => onChange('card')}
        className={clsx(
          'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
          mode === 'card'
            ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
            : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800',
        )}
        title="Card view"
      >
        <LayoutGrid size={14} /> Cards
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'table'}
        onClick={() => onChange('table')}
        className={clsx(
          'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
          mode === 'table'
            ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
            : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800',
        )}
        title="Table view"
      >
        <Table2 size={14} /> Table
      </button>
    </div>
  )
}
