import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays, MessageSquare, Clock, Target, ListTodo, RefreshCw, CheckCircle2,
} from 'lucide-react'
import {
  getStuckCandidates, getEngagementAnalytics, getDailyDigest,
  getDueCandidateTasks, updateCandidateTask, bulkNudgeCandidates,
} from '../api'

const PRIORITY_STYLES = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-slate-100 text-slate-600',
}

function StatCard({ icon: Icon, label, value, accent = 'text-slate-700' }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 flex items-center gap-3">
      <div className={`p-2 rounded-md bg-slate-50 ${accent}`}><Icon size={20} /></div>
      <div>
        <div className="text-2xl font-semibold text-slate-800">{value ?? '—'}</div>
        <div className="text-xs text-slate-500">{label}</div>
      </div>
    </div>
  )
}

export default function Engagement() {
  const qc = useQueryClient()
  const [days, setDays] = useState(2)
  const [analyticsDays, setAnalyticsDays] = useState(30)

  const digest = useQuery({ queryKey: ['engagement', 'digest'], queryFn: getDailyDigest })
  const analytics = useQuery({
    queryKey: ['engagement', 'analytics', analyticsDays],
    queryFn: () => getEngagementAnalytics({ days: analyticsDays }),
  })
  const stuck = useQuery({
    queryKey: ['engagement', 'stuck', days],
    queryFn: () => getStuckCandidates({ days }),
  })
  const tasks = useQuery({ queryKey: ['engagement', 'due-tasks'], queryFn: () => getDueCandidateTasks({}) })

  const completeTask = useMutation({
    mutationFn: (id) => updateCandidateTask(id, { status: 'done' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engagement', 'due-tasks'] }),
  })

  const bulkNudge = useMutation({
    mutationFn: (ids) => bulkNudgeCandidates(ids),
    onSuccess: (data) => {
      window.alert(`Nudged ${data?.dispatched ?? 0} of ${data?.requested ?? 0} candidate(s).`)
      qc.invalidateQueries({ queryKey: ['engagement'] })
    },
    onError: (e) => window.alert(`Bulk nudge failed: ${e?.response?.data?.error || e.message}`),
  })

  const d = digest.data || {}
  const a = analytics.data || {}
  const funnel = a.funnel || {}

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Engagement</h1>
          <p className="text-sm text-slate-500">Re-engagement health, stuck candidates, and callback tasks.</p>
        </div>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ['engagement'] })}
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {/* Daily digest cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard icon={CalendarDays} label="Interviews today" value={d.interviews_today} accent="text-indigo-600" />
        <StatCard icon={MessageSquare} label="Re-engaged (24h)" value={d.reengaged_today} accent="text-emerald-600" />
        <StatCard icon={Clock} label="Newly stuck" value={d.new_stuck} accent="text-amber-600" />
        <StatCard icon={Target} label="Job re-engagements" value={d.job_matches_today} accent="text-sky-600" />
        <StatCard icon={ListTodo} label="Callback tasks due" value={d.tasks_due} accent="text-rose-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Analytics */}
        <div className="bg-white rounded-lg border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium text-slate-800">Re-engagement funnel</h2>
            <select
              value={analyticsDays}
              onChange={(e) => setAnalyticsDays(Number(e.target.value))}
              className="text-xs border border-slate-200 rounded px-2 py-1"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
          <div className="flex items-end gap-4 mb-4">
            <div>
              <div className="text-3xl font-semibold text-slate-800">{funnel.candidates_nudged ?? 0}</div>
              <div className="text-xs text-slate-500">nudged</div>
            </div>
            <div className="text-slate-300 text-2xl pb-1">→</div>
            <div>
              <div className="text-3xl font-semibold text-emerald-600">{funnel.candidates_replied ?? 0}</div>
              <div className="text-xs text-slate-500">replied</div>
            </div>
            <div className="ml-auto text-right">
              <div className="text-2xl font-semibold text-slate-800">{funnel.reply_rate_pct ?? 0}%</div>
              <div className="text-xs text-slate-500">reply rate</div>
            </div>
          </div>
          <div className="text-xs font-medium text-slate-500 mb-1">Messages sent ({a.total_sent ?? 0})</div>
          <div className="space-y-1">
            {(a.sent_by_type || []).map((row) => (
              <div key={row.type} className="flex justify-between text-sm">
                <span className="text-slate-600">{String(row.type || '').replace(/_/g, ' ')}</span>
                <span className="text-slate-800 font-medium">{row.sent}</span>
              </div>
            ))}
            {(!a.sent_by_type || a.sent_by_type.length === 0) && (
              <div className="text-sm text-slate-400">No proactive messages in this window.</div>
            )}
          </div>
        </div>

        {/* Due callback tasks */}
        <div className="bg-white rounded-lg border border-slate-200 p-4 lg:col-span-2">
          <h2 className="font-medium text-slate-800 mb-3">Callback tasks due</h2>
          {tasks.isLoading ? (
            <div className="text-sm text-slate-400">Loading…</div>
          ) : (tasks.data || []).length === 0 ? (
            <div className="text-sm text-slate-400">No tasks due. 🎉</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {(tasks.data || []).map((t) => (
                <div key={t.id} className="py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <Link to={`/candidates/${t.candidate_id}`} className="text-sm font-medium text-slate-800 hover:underline">
                      {t.candidate_name || t.candidate_phone || 'Candidate'}
                    </Link>
                    <div className="text-xs text-slate-500 truncate">
                      {new Date(t.due_at).toLocaleString()} · {t.note || t.task_type}
                    </div>
                  </div>
                  <button
                    onClick={() => completeTask.mutate(t.id)}
                    disabled={completeTask.isPending}
                    className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:text-emerald-900"
                  >
                    <CheckCircle2 size={15} /> Done
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Stuck candidates */}
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-slate-800">
            Stuck candidates {stuck.data ? `(${stuck.data.total})` : ''}
          </h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const ids = (stuck.data?.candidates || []).map((c) => c.id)
                if (ids.length && window.confirm(`Send a re-engagement nudge to all ${ids.length} shown candidate(s)?`)) {
                  bulkNudge.mutate(ids)
                }
              }}
              disabled={bulkNudge.isPending || !(stuck.data?.candidates || []).length}
              className="text-xs px-2.5 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {bulkNudge.isPending ? 'Nudging…' : 'Nudge all shown'}
            </button>
            <label className="text-xs text-slate-500 flex items-center gap-2">
              Idle for at least
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="text-xs border border-slate-200 rounded px-2 py-1"
              >
                <option value={1}>1 day</option>
                <option value={2}>2 days</option>
                <option value={5}>5 days</option>
                <option value={7}>7 days</option>
              </select>
            </label>
          </div>
        </div>
        {stuck.isLoading ? (
          <div className="text-sm text-slate-400">Loading…</div>
        ) : (stuck.data?.candidates || []).length === 0 ? (
          <div className="text-sm text-slate-400">No stuck candidates. 🎉</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-100">
                  <th className="py-2 pr-3">Candidate</th>
                  <th className="py-2 pr-3">Stage</th>
                  <th className="py-2 pr-3">Idle</th>
                  <th className="py-2 pr-3">Next best action</th>
                </tr>
              </thead>
              <tbody>
                {(stuck.data?.candidates || []).map((c) => (
                  <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-2 pr-3">
                      <Link to={`/candidates/${c.id}`} className="font-medium text-slate-800 hover:underline">
                        {c.name || c.phone || 'Candidate'}
                      </Link>
                      {c.phone && <div className="text-xs text-slate-400">{c.phone}</div>}
                    </td>
                    <td className="py-2 pr-3 capitalize text-slate-600">{c.status}</td>
                    <td className="py-2 pr-3 text-slate-600">{c.days_since_contact}d</td>
                    <td className="py-2 pr-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${PRIORITY_STYLES[c.next_action?.priority] || PRIORITY_STYLES.low}`}>
                        {c.next_action?.label || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
