import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Search, Users, Briefcase, FolderKanban, CornerDownLeft, Loader2 } from 'lucide-react'
import { Modal } from './ui/Modal'
import { globalSearch } from '../api'
import { getStatusLabel, getStatusColor } from '../constants/lifecycle'

/**
 * CommandPalette — global ⌘K / Ctrl+K quick search (UPGRADES.md #3.0).
 *
 * Self-contained, dependency-free (no `cmdk`). Mount ONCE in the app shell
 * (Layout). Registers a single document-level keydown listener to toggle open,
 * runs a debounced, permission-aware `globalSearch`, renders grouped results
 * (Candidates / Jobs / Projects), and supports full keyboard navigation across
 * the flat result list. Selecting a row navigates to its detail route and
 * closes the palette.
 */
export function CommandPalette() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // ── Global hotkey: ⌘K / Ctrl+K toggles open; Escape closes ────────────────
  // One listener for the lifetime of the component (mounted once). It does not
  // depend on `open`, so it never re-binds / double-fires; we read/flip state
  // via the functional updater. Escape is also handled by the Modal, but we
  // mirror it here so the key works even before the dialog mounts.
  useEffect(() => {
    const onKeyDown = (e) => {
      const isToggle = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')
      if (isToggle) {
        e.preventDefault()
        setOpen((prev) => !prev)
        return
      }
      if (e.key === 'Escape') {
        setOpen((prev) => (prev ? false : prev))
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Debounce the trimmed query (~200ms) before it drives the search query.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(t)
  }, [query])

  // Autofocus the input whenever the palette opens (Modal mounts its children
  // when `open` flips true, so defer a tick to ensure the node exists).
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [open])

  const enabled = debounced.length >= 2

  const { data, isFetching, isError } = useQuery({
    queryKey: ['global-search', debounced],
    queryFn: () => globalSearch(debounced),
    enabled,
    staleTime: 30_000,
    // Keep the prior results visible while a new query is in flight (v5 API)
    // so the list doesn't flash empty between keystrokes.
    placeholderData: keepPreviousData,
  })

  // Normalize the response into safe arrays — never trust the shape.
  const candidates = Array.isArray(data?.candidates) ? data.candidates : []
  const jobs = Array.isArray(data?.jobs) ? data.jobs : []
  const projects = Array.isArray(data?.projects) ? data.projects : []

  // Flatten all results into a single ordered list so a single highlighted
  // index can move across groups. Each item carries its route target.
  const flatItems = useMemo(() => {
    const items = []
    candidates.forEach((c) => {
      if (c?.id == null) return
      items.push({ type: 'candidate', id: c.id, to: `/candidates/${c.id}`, data: c })
    })
    jobs.forEach((j) => {
      if (j?.id == null) return
      items.push({ type: 'job', id: j.id, to: `/jobs/${j.id}`, data: j })
    })
    projects.forEach((p) => {
      if (p?.id == null) return
      items.push({ type: 'project', id: p.id, to: `/projects/${p.id}`, data: p })
    })
    return items
  }, [candidates, jobs, projects])

  const hasResults = flatItems.length > 0

  // Reset the highlight to the top whenever the result set changes.
  useEffect(() => {
    setActiveIndex(0)
  }, [flatItems])

  // Close the palette and clear transient state (query + highlight).
  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setDebounced('')
    setActiveIndex(0)
  }, [])

  // Navigate to an item's detail route, then close (which also clears query).
  const selectItem = useCallback(
    (item) => {
      if (!item?.to) return
      navigate(item.to)
      close()
    },
    [navigate, close]
  )

  // Keyboard navigation within the open palette: ↑/↓ move the highlight across
  // the flat list, Enter activates it. Handled on the input (which holds focus).
  const onInputKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!hasResults) return
      setActiveIndex((i) => (i + 1) % flatItems.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!hasResults) return
      setActiveIndex((i) => (i - 1 + flatItems.length) % flatItems.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item) selectItem(item)
    }
  }

  // Keep the highlighted row scrolled into view as the index changes.
  useEffect(() => {
    if (!open || !hasResults) return
    const node = listRef.current?.querySelector(`[data-cmd-index="${activeIndex}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, hasResults])

  return (
    <Modal open={open} onClose={close} title="Search" size="lg">
      {/* Search input */}
      <div className="relative mb-4">
        <Search
          size={18}
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={hasResults}
          aria-controls="command-palette-results"
          aria-activedescendant={
            hasResults ? `command-palette-item-${activeIndex}` : undefined
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder="Search candidates, jobs, projects…"
          className="w-full pl-11 pr-11 py-3 bg-zinc-50 border border-zinc-200 text-zinc-900 placeholder-zinc-400 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 transition-colors dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-primary-400 dark:focus:ring-primary-400/30"
        />
        {isFetching && (
          <Loader2
            size={18}
            className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-400 animate-spin"
            aria-hidden="true"
          />
        )}
      </div>

      {/* Results / states */}
      <div id="command-palette-results" ref={listRef} role="listbox" aria-label="Search results">
        {!enabled && (
          <p className="px-1 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Type at least 2 characters to search.
          </p>
        )}

        {enabled && isError && (
          <p className="px-1 py-6 text-center text-sm text-red-500 dark:text-red-400">
            Something went wrong. Try again.
          </p>
        )}

        {enabled && !isError && !hasResults && !isFetching && (
          <p className="px-1 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No results for &ldquo;{debounced}&rdquo;.
          </p>
        )}

        {enabled && !isError && hasResults && (
          <div className="space-y-4">
            {/* `flatItems` is built in this exact group order (candidates →
                jobs → projects), so each row's flat index is just its position
                in `flatItems`. We render straight from `flatItems` and switch
                presentation by `type`, keeping highlight indices in lock-step. */}
            <ResultGroup label="Candidates" icon={Users} count={candidates.length}>
              {flatItems.map((item, idx) =>
                item.type !== 'candidate' ? null : (
                  <ResultRow
                    key={`candidate-${item.id}`}
                    index={idx}
                    active={idx === activeIndex}
                    icon={Users}
                    onSelect={() => selectItem(item)}
                    onHover={() => setActiveIndex(idx)}
                    title={item.data.name || 'Unnamed candidate'}
                    subtitle={item.data.phone || ''}
                    status={item.data.status}
                  />
                )
              )}
            </ResultGroup>
            <ResultGroup label="Jobs" icon={Briefcase} count={jobs.length}>
              {flatItems.map((item, idx) =>
                item.type !== 'job' ? null : (
                  <ResultRow
                    key={`job-${item.id}`}
                    index={idx}
                    active={idx === activeIndex}
                    icon={Briefcase}
                    onSelect={() => selectItem(item)}
                    onHover={() => setActiveIndex(idx)}
                    title={item.data.title || 'Untitled job'}
                    subtitle={item.data.category || ''}
                    status={item.data.status}
                  />
                )
              )}
            </ResultGroup>
            <ResultGroup label="Projects" icon={FolderKanban} count={projects.length}>
              {flatItems.map((item, idx) =>
                item.type !== 'project' ? null : (
                  <ResultRow
                    key={`project-${item.id}`}
                    index={idx}
                    active={idx === activeIndex}
                    icon={FolderKanban}
                    onSelect={() => selectItem(item)}
                    onHover={() => setActiveIndex(idx)}
                    title={item.data.title || 'Untitled project'}
                    subtitle=""
                    status={item.data.status}
                  />
                )
              )}
            </ResultGroup>
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="mt-4 pt-3 border-t border-zinc-200/70 dark:border-zinc-800 flex items-center gap-4 text-[11px] text-zinc-400 dark:text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <KeyHint>↑</KeyHint>
          <KeyHint>↓</KeyHint>
          to navigate
        </span>
        <span className="inline-flex items-center gap-1.5">
          <KeyHint>
            <CornerDownLeft size={11} />
          </KeyHint>
          to open
        </span>
        <span className="inline-flex items-center gap-1.5">
          <KeyHint>Esc</KeyHint>
          to close
        </span>
      </div>
    </Modal>
  )
}

// A titled group; renders nothing when the group is empty so empty arrays
// don't leave dangling headers.
function ResultGroup({ label, icon: Icon, count, children }) {
  if (!count) return null
  return (
    <div>
      <div className="flex items-center gap-2 px-1 mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        {Icon && <Icon size={12} aria-hidden="true" />}
        {label}
      </div>
      <ul className="space-y-1">{children}</ul>
    </div>
  )
}

// A single selectable result row. Highlighted when `active`; hover updates the
// shared highlight via `onHover`.
function ResultRow({ index, active, icon: Icon, onSelect, onHover, title, subtitle, status }) {
  return (
    <li role="option" aria-selected={active} id={`command-palette-item-${index}`}>
      <button
        type="button"
        data-cmd-index={index}
        onClick={onSelect}
        onMouseMove={onHover}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
          active
            ? 'bg-primary-50 dark:bg-primary-950/40'
            : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
        }`}
      >
        <span
          className={`flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg ${
            active
              ? 'bg-primary-100 text-primary-600 dark:bg-primary-900/50 dark:text-primary-300'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
          }`}
        >
          {Icon && <Icon size={16} aria-hidden="true" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {title}
          </span>
          {subtitle && (
            <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
              {subtitle}
            </span>
          )}
        </span>
        {status && (
          <span
            className={`flex-shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${getStatusColor(
              status
            )}`}
          >
            {getStatusLabel(status)}
          </span>
        )}
      </button>
    </li>
  )
}

// Small keycap used in the footer hint row.
function KeyHint({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded border border-zinc-200 bg-zinc-50 text-zinc-500 font-sans dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
      {children}
    </kbd>
  )
}
