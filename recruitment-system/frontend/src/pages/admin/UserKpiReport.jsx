import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, PieChart, Pie, Cell, ResponsiveContainer,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts'
import {
  Printer, ChevronLeft, Activity, Repeat, Timer, TrendingUp,
  Layers, Award, ShieldCheck, Calendar,
} from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { getUserKpi } from '../../api'

// Standalone /admin/users/:id/report page — designed for browser print-to-PDF.
// Print CSS in index.css hides the sidebar/header and forces light surfaces.
// Visit with ?auto=1 to fire window.print() automatically once charts render.

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4']

const RANGE_LABEL = {
  '7':   'Last 7 days',
  '30':  'Last 30 days',
  '90':  'Last 90 days',
  '365': 'Last year',
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

function MetricBlock({ icon: Icon, label, value, hint }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-zinc-900 text-white flex items-center justify-center print-keep">
          <Icon size={18} />
        </div>
        <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">{label}</p>
      </div>
      <p className="text-3xl font-bold text-zinc-900 tracking-tight">{value}</p>
      {hint && <p className="text-xs text-zinc-500 mt-1">{hint}</p>}
    </div>
  )
}

export default function UserKpiReport() {
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const autoPrint = searchParams.get('auto') === '1'
  const [range, setRange] = useState(searchParams.get('range') || '30')

  const queryParams = useMemo(() => ({
    from: new Date(Date.now() - parseInt(range) * 24 * 60 * 60 * 1000).toISOString(),
    to:   new Date().toISOString(),
  }), [range])

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'user-kpi-report', id, queryParams],
    queryFn: () => getUserKpi(id, queryParams),
  })

  const user = data?.user
  const kpi = data?.kpi

  // Auto-print: wait for the next paint cycle plus a short buffer so Recharts
  // has time to mount its SVGs. ~400ms is enough on any reasonable hardware.
  const [printed, setPrinted] = useState(false)
  useEffect(() => {
    if (!autoPrint || isLoading || printed) return
    const t = setTimeout(() => {
      window.print()
      setPrinted(true)
    }, 500)
    return () => clearTimeout(t)
  }, [autoPrint, isLoading, printed])

  const activityByDay = (kpi?.activity_by_day || []).map(d => ({
    day:    new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    actions: d.actions, views: d.views, created: d.created, updated: d.updated, deleted: d.deleted,
  }))

  const actionData   = (kpi?.action_breakdown || []).filter(a => a.count > 0)
  const sectionUsage = kpi?.section_usage || []
  const workByEntity = kpi?.work_by_entity || []

  if (isLoading) {
    return (
      <div className="min-h-screen bg-white p-12 flex items-center justify-center">
        <p className="text-zinc-500">Loading report…</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-zinc-50 print:bg-white">
      {/* Toolbar — hidden on print */}
      <div className="no-print sticky top-0 z-10 bg-white border-b border-zinc-200 px-6 py-3 flex items-center justify-between shadow-sm">
        <Link to={`/admin/users/${id}`} className="flex items-center gap-2 text-sm text-zinc-600 hover:text-zinc-900 font-semibold">
          <ChevronLeft size={16} />
          Back to user
        </Link>
        <div className="flex items-center gap-2">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="px-3 py-1.5 text-sm font-semibold border border-zinc-200 rounded-xl"
          >
            {Object.entries(RANGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Button variant="primary" size="sm" onClick={() => window.print()}>
            <Printer size={15} />
            Print / Save as PDF
          </Button>
        </div>
      </div>

      <div className="max-w-4xl mx-auto p-8 print:p-0 space-y-6 print:space-y-4">
        {/* Cover */}
        <header className="print-card print-cover rounded-3xl border border-zinc-200 bg-white p-8 print:p-6">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-1">User KPI Report</p>
              <h1 className="text-4xl font-bold text-zinc-900 tracking-tight">{user?.full_name || '—'}</h1>
              <p className="text-zinc-600 mt-1">{user?.email}</p>
              <div className="mt-4 flex items-center gap-4 text-sm text-zinc-500">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck size={14} /> {user?.role || '—'}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Calendar size={14} /> {RANGE_LABEL[range]}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 mt-2">
                Generated {new Date().toLocaleString()} · From {new Date(queryParams.from).toLocaleDateString()} to {new Date(queryParams.to).toLocaleDateString()}
              </p>
            </div>
            <div className="text-right">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-zinc-900 text-white print-keep">
                <Award size={28} />
              </div>
            </div>
          </div>
        </header>

        {/* Summary tiles */}
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 print:gap-2">
          <div className="print-card">
            <MetricBlock icon={Activity} label="Total actions" value={(kpi?.total_actions ?? 0).toLocaleString()} hint={`${(kpi?.total_views ?? 0).toLocaleString()} views`} />
          </div>
          <div className="print-card">
            <MetricBlock icon={Repeat} label="Sessions" value={(kpi?.total_sessions ?? 0).toLocaleString()} hint={`${(kpi?.total_logins ?? 0).toLocaleString()} logins`} />
          </div>
          <div className="print-card">
            <MetricBlock icon={Timer} label="Avg session" value={formatDuration(kpi?.avg_session_ms)} hint="Closed sessions only" />
          </div>
          <div className="print-card">
            <MetricBlock icon={TrendingUp} label="First action" value={formatSeconds(kpi?.avg_first_action_seconds)} hint="Avg time after login" />
          </div>
        </section>

        {/* 1) Activity over time */}
        <section className="print-card rounded-3xl border border-zinc-200 bg-white p-6">
          <h2 className="text-base font-bold text-zinc-900 mb-1">1. Activity Volume</h2>
          <p className="text-xs text-zinc-500 mb-4">Daily action volume broken down by type</p>
          {activityByDay.length === 0 ? (
            <p className="text-sm text-zinc-400 italic">No activity recorded in this period.</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={activityByDay}>
                  <CartesianGrid stroke="#e4e4e7" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" stroke="#71717a" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="#71717a" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip />
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

        {/* 2) Work output by entity */}
        <section className="print-card rounded-3xl border border-zinc-200 bg-white p-6">
          <h2 className="text-base font-bold text-zinc-900 mb-1">2. Work Output by Entity</h2>
          <p className="text-xs text-zinc-500 mb-4">CRUD totals across resource types</p>
          {workByEntity.length === 0 ? (
            <p className="text-sm text-zinc-400 italic">No work output recorded.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-bold uppercase tracking-widest text-zinc-500 border-b border-zinc-200">
                  <th className="py-2 pr-4">Entity</th>
                  <th className="py-2 px-2 text-right">Created</th>
                  <th className="py-2 px-2 text-right">Updated</th>
                  <th className="py-2 px-2 text-right">Deleted</th>
                  <th className="py-2 pl-2 text-right">Viewed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {workByEntity.map(w => (
                  <tr key={w.entity_type}>
                    <td className="py-2 pr-4 font-semibold capitalize text-zinc-700">{w.entity_type.replace(/_/g, ' ')}</td>
                    <td className="py-2 px-2 text-right text-emerald-700 font-semibold">{w.created || '—'}</td>
                    <td className="py-2 px-2 text-right text-amber-700 font-semibold">{w.updated || '—'}</td>
                    <td className="py-2 px-2 text-right text-red-700 font-semibold">{w.deleted || '—'}</td>
                    <td className="py-2 pl-2 text-right text-blue-700 font-semibold">{w.viewed || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* 3) Response & throughput */}
        <section className="print-card rounded-3xl border border-zinc-200 bg-white p-6">
          <h2 className="text-base font-bold text-zinc-900 mb-1">3. Response & Throughput</h2>
          <p className="text-xs text-zinc-500 mb-4">How responsive this user is during sessions</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h3 className="text-sm font-bold text-zinc-700 mb-3">Action mix</h3>
              {actionData.length === 0 ? (
                <p className="text-xs text-zinc-400 italic">No actions in period.</p>
              ) : (
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={actionData} dataKey="count" nameKey="action" innerRadius={30} outerRadius={70} paddingAngle={2}>
                        {actionData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div className="rounded-2xl bg-zinc-50 border border-zinc-200 p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Avg first action after login</p>
                <p className="text-2xl font-bold text-zinc-900 mt-1">{formatSeconds(kpi?.avg_first_action_seconds)}</p>
                <p className="text-[11px] text-zinc-500 mt-1">Lower means the user starts working sooner after logging in.</p>
              </div>
              <div className="rounded-2xl bg-zinc-50 border border-zinc-200 p-4">
                <p className="text-xs font-bold uppercase tracking-widest text-zinc-500">Avg session duration</p>
                <p className="text-2xl font-bold text-zinc-900 mt-1">{formatDuration(kpi?.avg_session_ms)}</p>
                <p className="text-[11px] text-zinc-500 mt-1">Across {(kpi?.total_sessions ?? 0).toLocaleString()} sessions in this period.</p>
              </div>
            </div>
          </div>
        </section>

        {/* 4) Section usage */}
        <section className="print-card rounded-3xl border border-zinc-200 bg-white p-6">
          <h2 className="text-base font-bold text-zinc-900 mb-1">4. Section Usage Breakdown</h2>
          <p className="text-xs text-zinc-500 mb-4">Where this user spends their time across the platform</p>
          {sectionUsage.length === 0 ? (
            <p className="text-sm text-zinc-400 italic">No section data recorded.</p>
          ) : (
            <ul className="space-y-3">
              {sectionUsage.map((s, i) => {
                const max = sectionUsage[0]?.hits || 1
                const pct = Math.round((s.hits / max) * 100)
                return (
                  <li key={s.section}>
                    <div className="flex items-center justify-between text-sm mb-1.5">
                      <span className="font-semibold text-zinc-700 capitalize">{s.section.replace(/_/g, ' ')}</span>
                      <span className="text-zinc-500 font-mono">{s.hits} hits</span>
                    </div>
                    <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, background: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <footer className="text-center text-[11px] text-zinc-400 py-4 print:py-2">
          AI Recruitment System — User KPI Report · Confidential
        </footer>
      </div>
    </div>
  )
}
