import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { COUNTRIES_ISO } from '../../constants/countries'

/**
 * Searchable country dropdown. Returns the full country object via onChange
 * so the caller can use { code, name, domain_default } in one step.
 *
 * value can be either a name string or an ISO code; we resolve both.
 */
export function CountrySelect({ value, onChange, placeholder = 'Select country', allowClear = true, className = '' }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')

  const selected = useMemo(() => {
    if (!value) return null
    const v = String(value).trim()
    return COUNTRIES_ISO.find(
      (c) => c.code.toUpperCase() === v.toUpperCase() || c.name.toLowerCase() === v.toLowerCase()
    ) || null
  }, [value])

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase()
    if (!f) return COUNTRIES_ISO
    return COUNTRIES_ISO.filter(
      (c) => c.name.toLowerCase().includes(f) || c.code.toLowerCase().includes(f)
    )
  }, [filter])

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="input flex w-full items-center justify-between text-left"
      >
        <span className={selected ? '' : 'text-zinc-400 dark:text-zinc-500'}>
          {selected ? `${selected.name}` : placeholder}
        </span>
        <span className="flex items-center gap-2">
          {selected && allowClear && (
            <X
              size={14}
              className="text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              onClick={(e) => {
                e.stopPropagation()
                onChange?.(null)
              }}
            />
          )}
          <span className="text-zinc-400 dark:text-zinc-500">▾</span>
        </span>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-72 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
            <Search size={14} className="text-zinc-400" />
            <input
              autoFocus
              type="text"
              placeholder="Search countries"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-full bg-transparent text-sm focus:outline-none text-zinc-800 dark:text-zinc-100 placeholder-zinc-400"
            />
          </div>
          <ul className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-zinc-500">No matches</li>
            ) : (
              filtered.map((c) => (
                <li key={c.code}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange?.(c)
                      setOpen(false)
                      setFilter('')
                    }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
                      selected?.code === c.code ? 'bg-primary-50 dark:bg-primary-900/20' : ''
                    }`}
                  >
                    <span className="text-zinc-800 dark:text-zinc-100">{c.name}</span>
                    <span className="text-xs text-zinc-400">{c.code}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
