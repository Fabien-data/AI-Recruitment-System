import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ArrowLeft, Download, TrendingUp, TrendingDown, Minus,
  Users, Phone, Target, Clock,
} from 'lucide-react'
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import toast from 'react-hot-toast'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import {
  getMarketingOverview, getMarketingFunnel, getMarketingBySource,
  getMarketingByAgent, getMarketingTimeseries, getMarketingCohort,
  getMarketingTimeToStage, exportMarketingLeadsCsv,
} from '../api'

const RANGES = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
]

const PERCENT = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const PERCENT_PP = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)} pp`)

function formatHours(h) {
  if (h == null) return '—'
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${h.toFixed(1)}h`
  return `${(h / 24).toFixed(1)}d`
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function Delta({ value, isPercentPoints }) {
  if (value == null) return <span className="text-zinc-400 text-xs">—</span>
  const Icon = value > 0 ? TrendingUp : value < 0 ? TrendingDown : Minus
  const color = value > 0 ? 'text-emerald-600' : value < 0 ? 'text-red-600' : 'text-zinc-500'
  const fmt = isPercentPoints ? PERCENT_PP(value) : `${value > 0 ? '+' : ''}${(value * 100).toFixed(0)}%`
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${color}`}>
      <Icon size={12} /> {fmt}
    </span>
  )
}

function KpiCard({ icon: Icon, label, value, delta, deltaIsPercentPoints, hint }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="w-9 h-9 rounded-xl bg-zinc-100 flex items-center justify-center text-zinc-700">
          <Icon size={16} />
        </div>
        <Delta value={delta} isPercentPoints={deltaIsPercentPoints} />
      </div>
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-zinc-900 tracking-tight mt-1">{value}</p>
      {hint && <p className="text-xs text-zinc-400 mt-1">{hint}</p>}
    </Card>
  )
}

const STAGE_COLORS = {
  new: '#a1a1aa',
  contacted: '#3b82f6',
  qualified: '#8b5cf6',
  converted: '#10b981',
  lost: '#ef4444',
}

export default function MarketingAnalytics() {
  const [range, setRange] = useState('30d')
  const [exporting, setExporting] = useState(false)

  const params = { queryKey: (suffix) => ['marketing-analytics', suffix, range] }

  const { data: overview } = useQuery({
    queryKey: ['marketing-analytics', 'overview', range],
    queryFn: () => getMarketingOverview(range),
  })
  const { data: funnel = [] } = useQuery({
    queryKey: ['marketing-analytics', 'funnel', range],
    queryFn: () => getMarketingFunnel(range),
  })
  const { data: bySource = [] } = useQuery({
    queryKey: ['marketing-analytics', 'by-source', range],
    queryFn: () => getMarketingBySource(range),
  })
  const { data: byAgent = [] } = useQuery({
    queryKey: ['marketing-analytics', 'by-agent', range],
    queryFn: () => getMarketingByAgent(range),
  })
  const { data: timeseries = [] } = useQuery({
    queryKey: ['marketing-analytics', 'timeseries', range],
    queryFn: () => getMarketingTimeseries(range),
  })
  const { data: cohort = [] } = useQuery({
    queryKey: ['marketing-analytics', 'cohort', range],
    queryFn: () => getMarketingCohort(range),
  })
  const { data: timeToStage = [] } = useQuery({
    queryKey: ['marketing-analytics', 'time-to-stage', range],
    queryFn: () => getMarketingTimeToStage(range),
  })

  const handleExport = async () => {
    try {
      setExporting(true)
      await exportMarketingLeadsCsv(range)
      toast.success('CSV downloaded')
    } catch {
      toast.error('Export failed')
    } finally {
      setExporting(false)
    }
  }

  const chartData = timeseries.map((row) => ({
    day: formatDate(row.day),
    new_leads: row.new_leads,
    converted: row.converted,
    calls: row.calls,
  }))

  const funnelChartData = funnel.map((f) => ({ stage: f.stage, count: f.count }))

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <Link to="/marketing-hub" className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 mb-4 transition-colors">
        <ArrowLeft size={14} /> Back to leads
      </Link>

      <PageHeader
        icon={TrendingUp}
        tone="red"
        title="Marketing Analytics"
        subtitle="Lead conversion, source attribution, and agent performance."
        actions={
          <>
            <div className="inline-flex rounded-2xl bg-zinc-100 dark:bg-zinc-800 p-1">
              {RANGES.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setRange(r.value)}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-xl transition-colors ${
                    range === r.value
                      ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-50 shadow-sm'
                      : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Button variant="secondary" onClick={handleExport} loading={exporting}>
              <Download size={14} /> Export CSV
            </Button>
          </>
        }
      />

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard
          icon={Users}
          label="New leads"
          value={overview?.new_leads ?? '—'}
          delta={overview?.deltas?.new_leads_pct}
          hint={`vs ${overview?.previous?.new_leads ?? 0} prev. period`}
        />
        <KpiCard
          icon={Target}
          label="Conversion rate"
          value={PERCENT(overview?.conversion_rate)}
          delta={overview?.deltas?.conversion_rate_pp}
          deltaIsPercentPoints
          hint={`${overview?.converted ?? 0} converted`}
        />
        <KpiCard
          icon={Clock}
          label="Avg time to convert"
          value={formatHours(overview?.avg_hours_to_convert)}
          hint="from intake → candidate"
        />
        <KpiCard
          icon={Phone}
          label="Calls handled"
          value={overview?.calls_handled ?? '—'}
          hint="distinct 3CX calls"
        />
      </div>

      {/* Top row: Funnel + Time series */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <Card className="p-5 lg:col-span-1">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Funnel</h2>
          {funnelChartData.length === 0 ? (
            <p className="text-sm text-zinc-400">No data yet</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart layout="vertical" data={funnelChartData} margin={{ left: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" stroke="#94a3b8" fontSize={11} />
                  <YAxis type="category" dataKey="stage" stroke="#94a3b8" fontSize={11} width={80} />
                  <Tooltip
                    cursor={{ fill: '#f1f5f9' }}
                    contentStyle={{ borderRadius: 12, border: '1px solid #e4e4e7' }}
                  />
                  <Bar dataKey="count" radius={[0, 8, 8, 0]} fill="#3b82f6">
                    {funnelChartData.map((entry) => (
                      <Bar key={entry.stage} fill={STAGE_COLORS[entry.stage] || '#3b82f6'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card className="p-5 lg:col-span-2">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Daily activity</h2>
          {chartData.length === 0 ? (
            <p className="text-sm text-zinc-400">No data yet</p>
          ) : (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="newLeads" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="converted" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="day" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e4e4e7' }} />
                  <Area type="monotone" dataKey="new_leads" name="New leads" stroke="#3b82f6" fill="url(#newLeads)" />
                  <Area type="monotone" dataKey="converted" name="Converted" stroke="#10b981" fill="url(#converted)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {/* Second row: by-source + time-to-stage */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card className="p-5">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">By source</h2>
          {bySource.length === 0 ? (
            <p className="text-sm text-zinc-400">No data yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="text-left font-semibold pb-2">Source</th>
                    <th className="text-right font-semibold pb-2">Leads</th>
                    <th className="text-right font-semibold pb-2">Qualified</th>
                    <th className="text-right font-semibold pb-2">Converted</th>
                    <th className="text-right font-semibold pb-2">Conv. rate</th>
                  </tr>
                </thead>
                <tbody>
                  {bySource.map((row) => (
                    <tr key={row.source_slug || 'unknown'} className="border-t border-zinc-100">
                      <td className="py-2 text-zinc-900">{row.source_label}</td>
                      <td className="py-2 text-right font-mono text-zinc-700">{row.total}</td>
                      <td className="py-2 text-right font-mono text-zinc-700">{row.qualified}</td>
                      <td className="py-2 text-right font-mono text-emerald-700">{row.converted}</td>
                      <td className="py-2 text-right font-mono font-semibold text-zinc-900">{PERCENT(row.conversion_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Time to convert</h2>
          {timeToStage.length === 0 ? (
            <p className="text-sm text-zinc-400">No conversions in range</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={timeToStage}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="bucket" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: '1px solid #e4e4e7' }} />
                  <Bar dataKey="count" radius={[8, 8, 0, 0]} fill="#8b5cf6" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      {/* Third row: agent leaderboard + cohort */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Agent leaderboard</h2>
          {byAgent.length === 0 ? (
            <p className="text-sm text-zinc-400">No agent activity in range</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="text-left font-semibold pb-2">Agent</th>
                    <th className="text-right font-semibold pb-2">Leads</th>
                    <th className="text-right font-semibold pb-2">Converted</th>
                    <th className="text-right font-semibold pb-2">Calls</th>
                    <th className="text-right font-semibold pb-2">Conv. rate</th>
                  </tr>
                </thead>
                <tbody>
                  {byAgent.map((row) => (
                    <tr key={row.agent_id} className="border-t border-zinc-100">
                      <td className="py-2 text-zinc-900">{row.agent_name}</td>
                      <td className="py-2 text-right font-mono text-zinc-700">{row.leads_assigned}</td>
                      <td className="py-2 text-right font-mono text-emerald-700">{row.converted}</td>
                      <td className="py-2 text-right font-mono text-zinc-700">{row.calls_handled}</td>
                      <td className="py-2 text-right font-mono font-semibold text-zinc-900">{PERCENT(row.conversion_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Weekly cohort retention</h2>
          {cohort.length === 0 ? (
            <p className="text-sm text-zinc-400">No data yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr>
                    <th className="text-left font-semibold pb-2">Week of</th>
                    <th className="text-right font-semibold pb-2">Leads</th>
                    <th className="text-right font-semibold pb-2">Contacted</th>
                    <th className="text-right font-semibold pb-2">Qualified</th>
                    <th className="text-right font-semibold pb-2">Converted</th>
                  </tr>
                </thead>
                <tbody>
                  {cohort.map((row) => (
                    <tr key={row.week} className="border-t border-zinc-100">
                      <td className="py-2 text-zinc-900">{formatDate(row.week)}</td>
                      <td className="py-2 text-right font-mono text-zinc-700">{row.total}</td>
                      <td className="py-2 text-right font-mono text-zinc-700">
                        {row.contacted} <span className="text-zinc-400 text-xs ml-1">({PERCENT(row.contacted / row.total)})</span>
                      </td>
                      <td className="py-2 text-right font-mono text-zinc-700">
                        {row.qualified} <span className="text-zinc-400 text-xs ml-1">({PERCENT(row.qualified / row.total)})</span>
                      </td>
                      <td className="py-2 text-right font-mono text-emerald-700">
                        {row.converted} <span className="text-zinc-400 text-xs ml-1">({PERCENT(row.converted / row.total)})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
