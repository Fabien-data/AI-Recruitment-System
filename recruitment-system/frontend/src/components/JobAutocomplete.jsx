import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Flame, Briefcase, X } from 'lucide-react'
import { twMerge } from 'tailwind-merge'
import { searchJobsForLead } from '../api'

/**
 * JobAutocomplete — typeahead for "Preferred job role" on the lead intake form.
 *
 * Emits BOTH structured + freeform output so agents can either pick a real job
 * (so the lead links to a vacancy and can later auto-create an application on
 * convert) or type something custom when no match exists (preserved verbatim
 * for the recruiter to triage later).
 *
 * Props:
 *   value           { id, title } | null  — currently selected structured job
 *   freeText        string                — current free-text fallback
 *   onChange        ({ id, title, free_text }) => void
 *   label, error    standard form props
 */
export function JobAutocomplete({ value, freeText, onChange, label = 'Preferred job role', error }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(freeText || value?.title || '')
  const [debounced, setDebounced] = useState(query)
  const wrapperRef = useRef(null)

  // Debounce the query so we don't spam the backend on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300)
    return () => clearTimeout(t)
  }, [query])

  // Sync upstream changes back into the input (e.g., form reset).
  useEffect(() => {
    setQuery(freeText || value?.title || '')
  }, [value?.id, freeText])

  const { data: matches = [], isFetching } = useQuery({
    queryKey: ['marketing-hub', 'job-search', debounced],
    queryFn: () => searchJobsForLead(debounced, 8),
    enabled: open,
    keepPreviousData: true,
  })

  // Close on outside click.
  useEffect(() => {
    function onDocClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const handlePick = useCallback((job) => {
    setQuery(job.title)
    setOpen(false)
    onChange({ id: job.id, title: job.title, free_text: '' })
  }, [onChange])

  const handleTyping = (e) => {
    const v = e.target.value
    setQuery(v)
    setOpen(true)
    // Picking a new value clears any prior structured selection — the agent
    // re-confirms by clicking a suggestion, otherwise it stays free-text.
    onChange({ id: null, title: '', free_text: v })
  }

  const handleClear = () => {
    setQuery('')
    onChange({ id: null, title: '', free_text: '' })
  }

  const showSuggestionRow = open && (matches.length > 0 || isFetching)

  return (
    <div className="w-full" ref={wrapperRef}>
      {label && (
        <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">
          {label}
        </label>
      )}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" size={16} />
        <input
          type="text"
          value={query}
          onChange={handleTyping}
          onFocus={() => setOpen(true)}
          placeholder="Start typing a job title…"
          className={twMerge(
            'w-full pl-10 pr-10 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all',
            error && 'border-red-400 focus:ring-red-400/20 focus:border-red-400 bg-red-50/50'
          )}
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-700 rounded-full hover:bg-zinc-100 transition-colors"
            aria-label="Clear"
          >
            <X size={14} />
          </button>
        )}

        {showSuggestionRow && (
          <div className="absolute z-30 mt-2 w-full bg-white rounded-2xl border border-zinc-200 shadow-xl overflow-hidden">
            {isFetching && matches.length === 0 ? (
              <div className="px-4 py-3 text-sm text-zinc-500">Searching…</div>
            ) : (
              <ul className="max-h-64 overflow-y-auto">
                {matches.map((job) => (
                  <li key={job.id}>
                    <button
                      type="button"
                      onClick={() => handlePick(job)}
                      className="w-full flex items-start justify-between gap-3 px-4 py-2.5 hover:bg-zinc-50 text-left transition-colors"
                    >
                      <span className="flex items-start gap-2 min-w-0">
                        <Briefcase size={14} className="mt-1 text-zinc-400 flex-shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-zinc-900 truncate">{job.title}</span>
                          <span className="block text-xs text-zinc-500 truncate">
                            {[job.category, job.location].filter(Boolean).join(' • ') || '—'}
                          </span>
                        </span>
                      </span>
                      {job.is_urgent && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 rounded-full px-2 py-0.5 flex-shrink-0">
                          <Flame size={10} /> URGENT
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {query && !isFetching && matches.length === 0 && (
              <div className="px-4 py-3 text-sm text-zinc-500 border-t border-zinc-100">
                No matches. Your text will be saved as a free-form preference.
              </div>
            )}
          </div>
        )}
      </div>
      {value?.id && (
        <p className="mt-1 ml-1 text-xs text-emerald-600 font-medium">
          Linked to job: {value.title}
        </p>
      )}
      {error && (
        <p className="mt-1.5 ml-1 text-sm text-red-500 font-medium tracking-tight" role="alert">{error}</p>
      )}
    </div>
  )
}
