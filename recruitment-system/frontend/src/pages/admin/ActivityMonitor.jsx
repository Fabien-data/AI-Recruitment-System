import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Activity, Filter, Search, Clock, User as UserIcon, Eye, Plus, Pencil, Trash2,
  LogIn, LogOut, ChevronLeft, ChevronRight, RefreshCw,
} from 'lucide-react'
import { PageHeader } from '../../components/ui/PageHeader'
import { Button } from '../../components/ui/Button'
import { getGlobalActivity, getAdminUsers, getSections } from '../../api'

const ACTION_META = {
  view:   { icon: Eye,    tone: 'blue',    label: 'Viewed' },
  create: { icon: Plus,   tone: 'emerald', label: 'Created' },
  update: { icon: Pencil, tone: 'amber',   label: 'Updated' },
  delete: { icon: Trash2, tone: 'rose',    label: 'Deleted' },
  login:  { icon: LogIn,  tone: 'zinc',    label: 'Logged in' },
  logout: { icon: LogOut, tone: 'zinc',    label: 'Logged out' },
}

const TONE_CLS = {
  blue:    'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  amber:   'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  rose:    'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  zinc:    'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
}

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'view', label: 'Views' },
  { value: 'create', label: 'Creates' },
  { value: 'update', label: 'Updates' },
  { value: 'delete', label: 'Deletes' },
  { value: 'login', label: 'Logins' },
  { value: 'logout', label: 'Logouts' },
]

// ISO day-precision helper for date inputs. The backend accepts any
// JS-parseable date so we pass strings directly.
function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function fromIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export default function ActivityMonitor() {
  const [filters, setFilters] = useState({
    user_id: '',
    section: '',
    action:  '',
    from:    fromIso(7),
    to:      todayIso(),
    search:  '',
  })
  const [page, setPage] = useState(1)
  const limit = 50

  const { data: usersData } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => getAdminUsers({ limit: 200 }),
    staleTime: 5 * 60 * 1000,
  })
  const { data: sections = [] } = useQuery({
    queryKey: ['admin', 'sections'],
    queryFn: getSections,
    staleTime: 10 * 60 * 1000,
  })

  // Active filter set for the query — strip empty strings so the backend
  // doesn't have to handle them.
  const queryParams = useMemo(() => {
    const p = { page, limit }
    if (filters.user_id) p.user_id = filters.user_id
    if (filters.section) p.section = filters.section
    if (filters.action)  p.action  = filters.action
    if (filters.from)    p.from    = `${filters.from}T00:00:00.000Z`
    if (filters.to)      p.to      = `${filters.to}T23:59:59.999Z`
    return p
  }, [filters, page])

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'activity', queryParams],
    queryFn: () => getGlobalActivity(queryParams),
    refetchInterval: 15_000,
    keepPreviousData: true,
  })

  const rows = data?.data ?? []
  const total = data?.pagination?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))

  // Client-side search filter on top of the API filters — keeps the UX snappy
  // for fine-grained "find that one weird event" queries.
  const filteredRows = useMemo(() => {
    if (!filters.search.trim()) return rows
    const q = filters.search.trim().toLowerCase()
    return rows.filter(r =>
      (r.user_name || '').toLowerCase().includes(q) ||
      (r.user_email || '').toLowerCase().includes(q) ||
      (r.entity_type || '').toLowerCase().includes(q) ||
      (r.action || '').toLowerCase().includes(q) ||
      (r.section_key || '').toLowerCase().includes(q)
    )
  }, [rows, filters.search])

  const setFilter = (key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }))
    setPage(1)
  }

  return (
    <div className="space-y-6 py-6">
      <PageHeader
        icon={Activity}
        tone="blue"
        title="Live Activity Monitor"
        subtitle={`${total.toLocaleString()} events match your filters · auto-refreshes every 15s`}
        actions={
          <div className="flex items-center gap-2">
            <Link to="/admin">
              <Button variant="secondary" size="sm">
                <ChevronLeft size={15} />
                Back to admin
              </Button>
            </Link>
            <Button variant="primary" size="sm" onClick={() => refetch()} loading={isFetching}>
              <RefreshCw size={15} />
              Refresh
            </Button>
          </div>
        }
      />

      {/* Filter bar */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm p-5"
      >
        <div className="flex items-center gap-2 mb-4 text-zinc-500 dark:text-zinc-400">
          <Filter size={14} />
          <h2 className="text-xs font-bold uppercase tracking-widest">Filter events</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1">User</label>
            <select
              value={filters.user_id}
              onChange={(e) => setFilter('user_id', e.target.value)}
              className="input"
            >
              <option value="">All users</option>
              {(usersData?.data ?? []).map(u => (
                <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1">Section</label>
            <select
              value={filters.section}
              onChange={(e) => setFilter('section', e.target.value)}
              className="input"
            >
              <option value="">All sections</option>
              {sections.map(s => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1">Action</label>
            <select
              value={filters.action}
              onChange={(e) => setFilter('action', e.target.value)}
              className="input"
            >
              {ACTION_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1">From</label>
            <input
              type="date"
              value={filters.from}
              onChange={(e) => setFilter('from', e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1">To</label>
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setFilter('to', e.target.value)}
              className="input"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1">Search</label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <input
                type="search"
                placeholder="name, entity..."
                value={filters.search}
                onChange={(e) => setFilters(p => ({ ...p, search: e.target.value }))}
                className="input pl-9"
              />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Activity feed */}
      <section className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm overflow-hidden">
        {isLoading ? (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {[...Array(10)].map((_, i) => (
              <li key={i} className="px-6 py-4 flex items-center gap-3 animate-pulse">
                <div className="w-9 h-9 rounded-full bg-zinc-100 dark:bg-zinc-800" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-zinc-100 dark:bg-zinc-800 rounded-full w-1/3" />
                  <div className="h-2 bg-zinc-50 dark:bg-zinc-800/60 rounded-full w-1/2" />
                </div>
              </li>
            ))}
          </ul>
        ) : filteredRows.length === 0 ? (
          <div className="py-16 text-center">
            <Clock className="mx-auto mb-3 text-zinc-300 dark:text-zinc-700" size={32} />
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No events match these filters.</p>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">Try widening the date range or clearing filters.</p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {filteredRows.map((log) => {
              const meta = ACTION_META[log.action] || { icon: Activity, tone: 'zinc', label: log.action }
              const Icon = meta.icon
              return (
                <motion.li
                  key={log.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="px-6 py-3.5 flex items-start gap-3 hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30 transition-colors"
                >
                  <div className={`w-9 h-9 rounded-2xl flex items-center justify-center flex-shrink-0 ${TONE_CLS[meta.tone]}`}>
                    <Icon size={15} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-700 dark:text-zinc-300">
                      {log.user_id ? (
                        <Link
                          to={`/admin/users/${log.user_id}`}
                          className="font-bold text-zinc-900 dark:text-zinc-100 hover:text-primary-600 dark:hover:text-primary-300"
                        >
                          {log.user_name || 'Unknown user'}
                        </Link>
                      ) : (
                        <span className="font-bold text-zinc-900 dark:text-zinc-100">System</span>
                      )}
                      {' '}
                      <span className="text-zinc-500 dark:text-zinc-400">{meta.label.toLowerCase()}</span>
                      {log.entity_type && (
                        <> a <span className="font-semibold text-zinc-700 dark:text-zinc-300">{log.entity_type.replace(/_/g, ' ')}</span></>
                      )}
                      {log.section_key && (
                        <> in <span className="font-semibold text-primary-600 dark:text-primary-300">{log.section_key.replace(/_/g, ' ')}</span></>
                      )}
                    </p>
                    <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5 flex items-center gap-2">
                      {log.user_email && <span>{log.user_email}</span>}
                      {log.ip_address && <span>· {log.ip_address}</span>}
                      {log.duration_ms != null && <span>· {log.duration_ms}ms</span>}
                    </p>
                  </div>
                  <time className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap flex-shrink-0">
                    {log.created_at ? new Date(log.created_at).toLocaleString() : ''}
                  </time>
                </motion.li>
              )
            })}
          </ul>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="px-6 py-4 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Page {page} of {totalPages.toLocaleString()} · {total.toLocaleString()} total events
            </p>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-2 rounded-xl text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 transition-colors"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-2 rounded-xl text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 transition-colors"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
