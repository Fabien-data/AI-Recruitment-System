import { useState, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts'
import {
  ChevronLeft, Printer, Edit2, Activity, KeyRound, History,
  LayoutGrid, User as UserIcon, Mail, Clock, LogIn, LogOut,
  Eye, Plus, Pencil, Trash2, TrendingUp, Timer, Repeat, Layers,
} from 'lucide-react'
import { PageHeader } from '../../components/ui/PageHeader'
import { Button } from '../../components/ui/Button'
import { Tabs } from '../../components/ui/Tabs'
import { EmptyState } from '../../components/ui/EmptyState'
import SectionPermissionMatrix from '../../components/admin/SectionPermissionMatrix'
import UserFormModal from '../../components/admin/UserFormModal'
import {
  getUserKpi, getUserActivity, getUserSessions, getUserPermissions,
  getAdminUsers,
} from '../../api'

const RANGE_OPTIONS = [
  { value: '7',   label: 'Last 7 days' },
  { value: '30',  label: 'Last 30 days' },
  { value: '90',  label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
]

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4']

const ACTION_META = {
  view:   { icon: Eye,    tone: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',     label: 'Viewed'   },
  create: { icon: Plus,   tone: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300', label: 'Created'  },
  update: { icon: Pencil, tone: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300', label: 'Updated' },
  delete: { icon: Trash2, tone: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',     label: 'Deleted'  },
  login:  { icon: LogIn,  tone: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',         label: 'Login'    },
  logout: { icon: LogOut, tone: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',         label: 'Logout'   },
}

function KpiTile({ icon: Icon, label, value, hint, tone = 'blue' }) {
  const toneMap = {
    blue:    'from-blue-500 to-blue-700',
    emerald: 'from-emerald-500 to-emerald-700',
    amber:   'from-amber-500 to-amber-700',
    purple:  'from-violet-500 to-purple-700',
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm p-5 flex items-start gap-4"
    >
      <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-white bg-gradient-to-br ${toneMap[tone]} shadow-lg`}>
        <Icon size={22} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">{label}</p>
        <p className="text-2xl font-bold text-zinc-900 dark:text-zinc-50 tracking-tight mt-0.5">{value}</p>
        {hint && <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">{hint}</p>}
      </div>
    </motion.div>
  )
}

function formatDuration(ms) {
  if (ms == null) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatSeconds(s) {
  if (s == null) return '—'
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

// ── Tab: Overview ──────────────────────────────────────────────────────────
function OverviewTab({ kpi }) {
  const activityByDay = (kpi?.activity_by_day || []).map(d => ({
    day:    new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    actions: d.actions, views: d.views, created: d.created, updated: d.updated, deleted: d.deleted,
  }))

  const actionData = (kpi?.action_breakdown || []).filter(a => a.count > 0)
  const sectionUsage = (kpi?.section_usage || []).slice(0, 8)
  const workByEntity = (kpi?.work_by_entity || []).slice(0, 8)

  return (
    <div className="space-y-6">
      {/* Activity by day */}
      <section className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50">Activity over time</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">Total actions per day across all sections</p>
          </div>
        </div>
        {activityByDay.length === 0 ? (
          <EmptyState icon={TrendingUp} title="No activity in this range" description="Try a wider date range." compact />
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={activityByDay}>
                <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" stroke="var(--chart-text)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="var(--chart-text)" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-grid)', borderRadius: 12, boxShadow: 'var(--chart-tooltip-shadow)' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="views"   stackId="a" fill="#3b82f6" name="Views" />
                <Bar dataKey="created" stackId="a" fill="#10b981" name="Created" />
                <Bar dataKey="updated" stackId="a" fill="#f59e0b" name="Updated" />
                <Bar dataKey="deleted" stackId="a" fill="#ef4444" name="Deleted" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Action breakdown pie */}
        <section className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm p-6">
          <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50 mb-1">Action mix</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">Proportion of action types performed</p>
          {actionData.length === 0 ? (
            <EmptyState icon={Activity} title="No actions" compact />
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={actionData} dataKey="count" nameKey="action" innerRadius={40} outerRadius={80} paddingAngle={2}>
                    {actionData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-grid)', borderRadius: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Section usage horizontal bar */}
        <section className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm p-6">
          <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50 mb-1">Section usage</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">Where this user spends their time</p>
          {sectionUsage.length === 0 ? (
            <EmptyState icon={Layers} title="No section data" compact />
          ) : (
            <ul className="space-y-2">
              {sectionUsage.map((s, i) => {
                const max = sectionUsage[0]?.hits || 1
                const pct = Math.round((s.hits / max) * 100)
                return (
                  <li key={s.section}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-semibold text-zinc-700 dark:text-zinc-300 capitalize">{s.section.replace(/_/g, ' ')}</span>
                      <span className="text-zinc-500 dark:text-zinc-400 font-mono">{s.hits}</span>
                    </div>
                    <div className="h-2 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${pct}%` }}
                        transition={{ duration: 0.6, delay: i * 0.04 }}
                        className="h-full rounded-full"
                        style={{ background: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      {/* Work by entity */}
      <section className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm p-6">
        <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50 mb-1">Work output by entity</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">CRUD breakdown across resource types</p>
        {workByEntity.length === 0 ? (
          <EmptyState icon={Layers} title="No work output" compact />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 border-b border-zinc-100 dark:border-zinc-800">
                  <th className="py-2 pr-4">Entity</th>
                  <th className="py-2 px-2 text-right">Created</th>
                  <th className="py-2 px-2 text-right">Updated</th>
                  <th className="py-2 px-2 text-right">Deleted</th>
                  <th className="py-2 pl-2 text-right">Viewed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800/70">
                {workByEntity.map(w => (
                  <tr key={w.entity_type}>
                    <td className="py-2 pr-4 font-semibold capitalize text-zinc-700 dark:text-zinc-300">{w.entity_type.replace(/_/g, ' ')}</td>
                    <td className="py-2 px-2 text-right text-emerald-600 dark:text-emerald-300 font-semibold">{w.created || '—'}</td>
                    <td className="py-2 px-2 text-right text-amber-600 dark:text-amber-300 font-semibold">{w.updated || '—'}</td>
                    <td className="py-2 px-2 text-right text-rose-600 dark:text-rose-300 font-semibold">{w.deleted || '—'}</td>
                    <td className="py-2 pl-2 text-right text-blue-600 dark:text-blue-300 font-semibold">{w.viewed || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

// ── Tab: Permissions ───────────────────────────────────────────────────────
function PermissionsTab({ userId, onEdit }) {
  const { data: permData, isLoading } = useQuery({
    queryKey: ['admin', 'user-permissions', userId],
    queryFn: () => getUserPermissions(userId),
  })

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm p-6">
        <div className="h-6 w-48 bg-zinc-100 dark:bg-zinc-800 rounded-full animate-pulse mb-4" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-24 rounded-2xl border border-zinc-200/60 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  const user = permData?.user
  const permissions = (permData?.permissions || []).filter(p =>
    p.can_view || p.can_create || p.can_edit || p.can_delete
  )

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50">Section permissions</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {user?.role === 'admin'
                ? 'Administrator — implicit full access to every section.'
                : 'Effective permissions (custom overrides + role defaults).'}
            </p>
          </div>
          {user?.role !== 'admin' && (
            <Button variant="primary" size="sm" onClick={onEdit}>
              <Edit2 size={14} />
              Edit permissions
            </Button>
          )}
        </div>
        <SectionPermissionMatrix value={permissions} onChange={() => {}} disabled />
      </div>
    </div>
  )
}

// ── Tab: Activity ──────────────────────────────────────────────────────────
function ActivityTab({ userId, range }) {
  const [page, setPage] = useState(1)
  const limit = 50

  const queryParams = useMemo(() => {
    const p = { page, limit }
    if (range) {
      p.from = new Date(Date.now() - parseInt(range) * 24 * 60 * 60 * 1000).toISOString()
      p.to   = new Date().toISOString()
    }
    return p
  }, [range, page])

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'user-activity', userId, queryParams],
    queryFn: () => getUserActivity(userId, queryParams),
    keepPreviousData: true,
  })

  const rows = data?.data ?? []
  const total = data?.pagination?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / limit))

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm overflow-hidden">
      {isLoading ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {[...Array(8)].map((_, i) => (
            <li key={i} className="px-6 py-3.5 animate-pulse">
              <div className="h-3 w-2/3 bg-zinc-100 dark:bg-zinc-800 rounded-full" />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <EmptyState icon={History} title="No activity yet" description="This user hasn't performed any tracked actions in the selected range." />
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((log) => {
            const meta = ACTION_META[log.action] || { icon: Activity, tone: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400', label: log.action }
            const Icon = meta.icon
            return (
              <li key={log.id} className="px-6 py-3.5 flex items-start gap-3 hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30 transition-colors">
                <div className={`w-9 h-9 rounded-2xl flex items-center justify-center flex-shrink-0 ${meta.tone}`}>
                  <Icon size={15} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-700 dark:text-zinc-300">
                    <span className="font-bold">{meta.label}</span>
                    {log.entity_type && <> · <span className="capitalize">{log.entity_type.replace(/_/g, ' ')}</span></>}
                    {log.section_key && <> · <span className="text-primary-600 dark:text-primary-300 capitalize">{log.section_key.replace(/_/g, ' ')}</span></>}
                  </p>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                    {log.ip_address && <span>{log.ip_address}</span>}
                    {log.duration_ms != null && <span> · {log.duration_ms}ms</span>}
                  </p>
                </div>
                <time className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap flex-shrink-0">
                  {log.created_at ? new Date(log.created_at).toLocaleString() : ''}
                </time>
              </li>
            )
          })}
        </ul>
      )}

      {totalPages > 1 && (
        <div className="px-6 py-4 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Page {page} of {totalPages} · {total.toLocaleString()} total events
          </p>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}
                    className="p-2 rounded-xl text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 transition-colors">
              <ChevronLeft size={14} />
            </button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}
                    className="p-2 rounded-xl text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 transition-colors">
              <ChevronLeft size={14} className="rotate-180" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab: Sessions ──────────────────────────────────────────────────────────
function SessionsTab({ userId }) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'user-sessions', userId],
    queryFn: () => getUserSessions(userId, { limit: 100 }),
  })
  const sessions = data?.data || []

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-200/60 dark:border-zinc-800 shadow-sm overflow-hidden">
      {isLoading ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {[...Array(6)].map((_, i) => (
            <li key={i} className="px-6 py-3.5 animate-pulse">
              <div className="h-3 w-1/2 bg-zinc-100 dark:bg-zinc-800 rounded-full" />
            </li>
          ))}
        </ul>
      ) : sessions.length === 0 ? (
        <EmptyState icon={LogIn} title="No sessions recorded" description="Sessions started before Migration 021 are not tracked." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 border-b border-zinc-100 dark:border-zinc-800">
              <th className="px-6 py-3">Login at</th>
              <th className="px-4 py-3">Logout at</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">IP</th>
              <th className="px-4 py-3">Agent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-50 dark:divide-zinc-800/70">
            {sessions.map(s => (
              <tr key={s.id} className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30 transition-colors">
                <td className="px-6 py-3 whitespace-nowrap font-semibold text-zinc-700 dark:text-zinc-300">
                  {new Date(s.login_at).toLocaleString()}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                  {s.is_open ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300 font-semibold">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Active
                    </span>
                  ) : (
                    new Date(s.logout_at).toLocaleString()
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap font-mono text-zinc-700 dark:text-zinc-300">
                  {formatDuration(Number(s.duration_ms))}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-500 dark:text-zinc-400 font-mono text-xs">{s.ip_address || '—'}</td>
                <td className="px-4 py-3 truncate max-w-xs text-zinc-400 dark:text-zinc-500 text-xs">{s.user_agent || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function UserDetail() {
  const { id } = useParams()
  const [tab, setTab] = useState('overview')
  const [range, setRange] = useState('30')
  const [editOpen, setEditOpen] = useState(false)

  const queryParams = useMemo(() => ({
    from: new Date(Date.now() - parseInt(range) * 24 * 60 * 60 * 1000).toISOString(),
    to:   new Date().toISOString(),
  }), [range])

  const { data: kpiData, isLoading: kpiLoading } = useQuery({
    queryKey: ['admin', 'user-kpi', id, queryParams],
    queryFn: () => getUserKpi(id, queryParams),
  })

  // Pull the matching user from the cached list so we have basic profile fields
  // (full_name, email, role, etc.) before /kpi resolves.
  const { data: usersData } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => getAdminUsers({ limit: 200 }),
    staleTime: 60_000,
  })
  const user = kpiData?.user || (usersData?.data || []).find(u => u.id === id)
  const kpi = kpiData?.kpi

  return (
    <div className="space-y-6 py-6">
      <PageHeader
        icon={UserIcon}
        tone="blue"
        title={user?.full_name || 'User'}
        subtitle={user?.email}
        actions={
          <div className="flex items-center gap-2">
            <Link to="/admin">
              <Button variant="secondary" size="sm">
                <ChevronLeft size={15} />
                Admin
              </Button>
            </Link>
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
              <Edit2 size={14} />
              Edit user
            </Button>
            <Link to={`/admin/users/${id}/report?auto=1`} target="_blank" rel="noreferrer">
              <Button variant="primary" size="sm">
                <Printer size={15} />
                Print KPI Report
              </Button>
            </Link>
          </div>
        }
      />

      {/* Date range */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-bold uppercase tracking-widest text-zinc-400 dark:text-zinc-500">Range:</span>
        {RANGE_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setRange(opt.value)}
            className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors ${
              range === opt.value
                ? 'bg-brand-gradient text-white shadow-glow-blue'
                : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:border-primary-400'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* KPI summary tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiTile
          icon={Activity}
          label="Total actions"
          value={kpiLoading ? '…' : (kpi?.total_actions ?? 0).toLocaleString()}
          hint={`${(kpi?.total_views ?? 0).toLocaleString()} views included`}
          tone="blue"
        />
        <KpiTile
          icon={Repeat}
          label="Sessions"
          value={kpiLoading ? '…' : (kpi?.total_sessions ?? 0).toLocaleString()}
          hint={`${(kpi?.total_logins ?? 0).toLocaleString()} logins`}
          tone="emerald"
        />
        <KpiTile
          icon={Timer}
          label="Avg session"
          value={kpiLoading ? '…' : formatDuration(kpi?.avg_session_ms)}
          hint="Across closed sessions"
          tone="amber"
        />
        <KpiTile
          icon={TrendingUp}
          label="First action after login"
          value={kpiLoading ? '…' : formatSeconds(kpi?.avg_first_action_seconds)}
          hint="Lower = more responsive"
          tone="purple"
        />
      </div>

      {/* Tabs */}
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview',    label: 'Overview',    icon: LayoutGrid, tone: 'blue' },
          { value: 'permissions', label: 'Permissions', icon: KeyRound,   tone: 'emerald' },
          { value: 'activity',    label: 'Activity',    icon: History,    tone: 'amber' },
          { value: 'sessions',    label: 'Sessions',    icon: Clock,      tone: 'purple' },
        ]}
      />

      <div>
        {tab === 'overview'    && <OverviewTab kpi={kpi} />}
        {tab === 'permissions' && <PermissionsTab userId={id} onEdit={() => setEditOpen(true)} />}
        {tab === 'activity'    && <ActivityTab userId={id} range={range} />}
        {tab === 'sessions'    && <SessionsTab userId={id} />}
      </div>

      <UserFormModal open={editOpen} onClose={() => setEditOpen(false)} mode="edit" user={user} />
    </div>
  )
}
