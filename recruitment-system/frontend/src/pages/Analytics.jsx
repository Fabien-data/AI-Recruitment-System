import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  TrendingUp, Users, FileText, CheckCircle2, BarChart3,
  Download, RefreshCw
} from 'lucide-react'
import {
  getAnalyticsOverview, getRecruiterPerformance, getAdPerformance
} from '../api'
import { Button } from '../components/ui/Button'
import { StatCardSkeleton } from '../components/ui/Skeleton'

const API_BASE = import.meta.env.VITE_API_URL || ''

const PIPELINE_COLORS = {
  applied: 'bg-blue-400',
  reviewing: 'bg-indigo-400',
  screening: 'bg-cyan-400',
  certified: 'bg-purple-500',
  interview_scheduled: 'bg-orange-400',
  interviewed: 'bg-amber-500',
  selected: 'bg-green-500',
  placed: 'bg-emerald-700',
  rejected: 'bg-red-400',
  transferred: 'bg-gray-400'
}

function ChangeTag({ value }) {
  if (value == null) return null
  const positive = value >= 0
  return (
    <span className={`text-xs font-medium ${positive ? 'text-green-600' : 'text-red-600'}`}>
      {positive ? '↑' : '↓'} {Math.abs(value)}%
    </span>
  )
}

function KpiCard({ label, value, change, icon: Icon, color }) {
  return (
    <div className="card hover:shadow-card-hover transition-shadow">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-gray-600">{label}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{value}</p>
        </div>
        <div className={`p-3 rounded-full ${color}`}>
          <Icon size={20} className="text-white" />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
        <ChangeTag value={change} />
        <span>vs previous period</span>
      </div>
    </div>
  )
}

function FunnelBar({ status, count, maxCount }) {
  const pct = maxCount > 0 ? Math.round((count / maxCount) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <div className="w-28 text-sm text-gray-700 capitalize truncate">{status.replace('_', ' ')}</div>
      <div className="flex-1 bg-gray-100 rounded-full h-5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${PIPELINE_COLORS[status] || 'bg-gray-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="w-12 text-right text-sm font-medium text-gray-800">{count}</div>
    </div>
  )
}

function WeeklyChart({ data }) {
  if (!data?.length) return <p className="text-sm text-gray-400">No weekly data available</p>
  const maxApps = Math.max(...data.map(d => parseInt(d.applications || 0, 10)), 1)
  return (
    <div className="space-y-2">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-3 text-sm">
          <div className="w-20 text-xs text-gray-500 text-right">
            {new Date(d.week).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </div>
          <div className="flex-1 bg-gray-100 rounded h-4">
            <div
              className="bg-blue-400 h-full rounded"
              style={{ width: `${Math.round((parseInt(d.applications, 10) / maxApps) * 100)}%` }}
            />
          </div>
          <div className="w-8 text-xs text-gray-700">{d.applications}</div>
        </div>
      ))}
    </div>
  )
}

export default function Analytics() {
  const [period, setPeriod] = useState('30')

  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['analytics-overview', period],
    queryFn: () => getAnalyticsOverview({ period })
  })

  const { data: recruiterPerf = [], isLoading: recruiterLoading } = useQuery({
    queryKey: ['recruiter-performance', period],
    queryFn: () => getRecruiterPerformance({ period })
  })

  const { data: adPerf = [], isLoading: adLoading } = useQuery({
    queryKey: ['ad-performance'],
    queryFn: getAdPerformance
  })

  const handleExport = () => {
    const token = localStorage.getItem('token')
    window.location.href = `${API_BASE}/api/analytics/export?period=${period}&token=${token}`
  }

  const funnel = overview?.funnel || []
  const maxFunnelCount = Math.max(...funnel.map(f => parseInt(f.count, 10)), 1)

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Analytics</h1>
          <p className="text-gray-600 mt-1">Pipeline performance, conversion rates, and ad attribution</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={period}
            onChange={e => setPeriod(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="60">Last 60 days</option>
            <option value="90">Last 90 days</option>
          </select>
          <Button variant="secondary" size="sm" onClick={handleExport}>
            <Download size={14} className="mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        {overviewLoading ? (
          Array.from({ length: 5 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <KpiCard
              label="Applications"
              value={overview?.applications?.value ?? '—'}
              change={overview?.applications?.change_pct}
              icon={FileText}
              color="bg-blue-500"
            />
            <KpiCard
              label="Certified"
              value={overview?.certified?.value ?? '—'}
              change={overview?.certified?.change_pct}
              icon={CheckCircle2}
              color="bg-purple-500"
            />
            <KpiCard
              label="Selected"
              value={overview?.selected?.value ?? '—'}
              change={overview?.selected?.change_pct}
              icon={Users}
              color="bg-green-500"
            />
            <KpiCard
              label="Unique Candidates"
              value={overview?.unique_candidates?.value ?? '—'}
              change={overview?.unique_candidates?.change_pct}
              icon={Users}
              color="bg-indigo-500"
            />
            <KpiCard
              label="Conversion Rate"
              value={overview?.conversion_rate?.value != null ? `${overview.conversion_rate.value}%` : '—'}
              change={overview?.conversion_rate?.change_pct}
              icon={TrendingUp}
              color="bg-orange-500"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Pipeline Funnel */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <BarChart3 size={18} />
            Pipeline Funnel
          </h2>
          {overviewLoading ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : funnel.length === 0 ? (
            <p className="text-sm text-gray-400">No data available</p>
          ) : (
            <div className="space-y-2">
              {funnel.map(f => (
                <FunnelBar key={f.status} status={f.status} count={parseInt(f.count, 10)} maxCount={maxFunnelCount} />
              ))}
            </div>
          )}
        </div>

        {/* Weekly Trend */}
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Weekly Applications</h2>
          {overviewLoading ? (
            <p className="text-sm text-gray-400">Loading...</p>
          ) : (
            <WeeklyChart data={overview?.weekly_trend} />
          )}
        </div>
      </div>

      {/* Recruiter Performance */}
      <div className="card mb-6">
        <h2 className="text-lg font-semibold mb-4">Recruiter Performance</h2>
        {recruiterLoading ? (
          <p className="text-sm text-gray-400">Loading...</p>
        ) : recruiterPerf.length === 0 ? (
          <p className="text-sm text-gray-400">No data available</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500 border-b">
                <tr>
                  <th className="pb-2 font-medium">Recruiter</th>
                  <th className="pb-2 font-medium text-right">Candidates Certified</th>
                  <th className="pb-2 font-medium text-right">Avg. Hours to Certify</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {recruiterPerf.map(r => (
                  <tr key={r.user_id}>
                    <td className="py-2">{r.full_name}</td>
                    <td className="py-2 text-right font-medium">{r.total_certified || 0}</td>
                    <td className="py-2 text-right text-gray-600">{r.avg_hours_to_certify ?? '—'}h</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Ad Performance */}
      {adPerf.length > 0 && (
        <div className="card">
          <h2 className="text-lg font-semibold mb-4">Ad Performance</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500 border-b">
                <tr>
                  <th className="pb-2 font-medium">Campaign</th>
                  <th className="pb-2 font-medium">Job</th>
                  <th className="pb-2 font-medium text-right">Clicks</th>
                  <th className="pb-2 font-medium text-right">Conversions</th>
                  <th className="pb-2 font-medium text-right">Conv. Rate</th>
                  <th className="pb-2 font-medium text-center">Active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {adPerf.map(ad => (
                  <tr key={ad.id}>
                    <td className="py-2">{ad.campaign_name || ad.ad_ref}</td>
                    <td className="py-2 text-gray-600">{ad.job_title || '—'}</td>
                    <td className="py-2 text-right">{ad.clicks}</td>
                    <td className="py-2 text-right">{ad.conversions}</td>
                    <td className="py-2 text-right font-medium">{ad.conversion_rate_pct}%</td>
                    <td className="py-2 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${ad.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {ad.is_active ? 'Active' : 'Paused'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
