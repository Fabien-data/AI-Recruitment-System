import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  CalendarDays, MessageSquare, Clock, Target, ListTodo, RefreshCw, CheckCircle2, Phone, PhoneMissed,
} from 'lucide-react'
import {
  getStuckCandidates, getEngagementAnalytics, getDailyDigest,
  getDueCandidateTasks, updateCandidateTask, bulkNudgeCandidates, getAgentCallActivity,
} from '../api'
import { useAuthStore, useRole } from '../stores/authStore'

const PRIORITY_STYLES = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300',
}

function StatCard({ icon: Icon, label, value, accent = 'text-slate-700' }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4 flex items-center gap-3">
      <div className={`p-2 rounded-md bg-slate-50 dark:bg-zinc-800/50 ${accent}`}><Icon size={20} /></div>
      <div>
        <div className="text-2xl font-semibold text-slate-800 dark:text-zinc-100">{value ?? '—'}</div>
        <div className="text-xs text-slate-500 dark:text-zinc-400">{label}</div>
      </div>
    </div>
  )
}

const fmtDur = (s) => {
  const n = Number(s || 0)
  if (!n) return '—'
  const m = Math.floor(n / 60); const sec = n % 60
  return m ? `${m}m ${sec}s` : `${sec}s`
}

function CallStatCells({ row }) {
  const cells = [
    ['Calls', row?.calls_logged ?? 0],
    ['Done', row?.answered ?? 0],
    ['No answer', row?.no_answer ?? 0],
    ['Follow-ups', row?.callbacks ?? 0],
    ['Not interested', row?.not_interested ?? 0],
    ['Avg dur.', fmtDur(row?.avg_duration_seconds)],
  ]
  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">
      {cells.map(([label, val]) => (
        <div key={label} className="rounded-lg border border-slate-200 dark:border-zinc-800 px-3 py-2">
          <div className="text-lg font-semibold text-slate-800 dark:text-zinc-100">{val}</div>
          <div className="text-[11px] text-slate-500 dark:text-zinc-400">{label}</div>
        </div>
      ))}
    </div>
  )
}

function CallRecentFeed({ items, showAgent }) {
  if (!items || items.length === 0) return <div className="text-sm text-slate-400 dark:text-zinc-500">No activity yet.</div>
  return (
    <ul className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
      {items.map((r) => (
        <li key={r.id} className="py-2 flex items-start gap-2 text-sm">
          <span className="mt-0.5 shrink-0">{r.outcome === 'answered' ? '✅' : r.outcome === 'no_answer' ? '📵' : r.outcome === 'callback' ? '🔁' : '📝'}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Link to={`/communications?candidate=${r.candidate_id}`} className="font-medium text-slate-800 dark:text-zinc-100 hover:underline">{r.candidate_name || 'Candidate'}</Link>
              {r.outcome && <span className="text-[11px] text-slate-500 dark:text-zinc-400">{String(r.outcome).replace(/_/g, ' ')}</span>}
              {r.disposition && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300">{String(r.disposition).replace(/_/g, ' ')}</span>}
            </div>
            {r.remark && <div className="text-xs text-slate-500 dark:text-zinc-400 truncate">{r.remark}</div>}
            <div className="text-[11px] text-slate-400 dark:text-zinc-500">{showAgent ? `${r.agent_name} · ` : ''}{r.called_at ? new Date(r.called_at).toLocaleString() : ''}</div>
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function Engagement() {
  const qc = useQueryClient()
  const [days, setDays] = useState(2)
  const [analyticsDays, setAnalyticsDays] = useState(30)

  const currentUser = useAuthStore((s) => s.user)
  const { isAdmin } = useRole()
  const [callDays, setCallDays] = useState(7)
  const [focusAgentId, setFocusAgentId] = useState(null) // admin: which agent to drill into
  const digest = useQuery({ queryKey: ['engagement', 'digest'], queryFn: getDailyDigest })
  const callFrom = () => new Date(Date.now() - callDays * 86400000).toISOString()

  // Admin: whole-team overview (all agents) — drives the agent table + selector.
  const teamActivity = useQuery({
    enabled: isAdmin,
    queryKey: ['engagement', 'call-activity', 'team', callDays],
    queryFn: () => getAgentCallActivity({ date_from: callFrom() }),
  })
  // Focused agent's own call log + stats: agents = themselves; admin = the selected agent.
  const focusId = isAdmin ? focusAgentId : currentUser?.id
  const focusActivity = useQuery({
    enabled: !!focusId,
    queryKey: ['engagement', 'call-activity', 'focus', callDays, focusId],
    queryFn: () => getAgentCallActivity({ date_from: callFrom(), agent_id: focusId }),
  })
  const analytics = useQuery({
    queryKey: ['engagement', 'analytics', analyticsDays],
    queryFn: () => getEngagementAnalytics({ days: analyticsDays }),
  })
  const stuck = useQuery({
    queryKey: ['engagement', 'stuck', days],
    queryFn: () => getStuckCandidates({ days }),
  })
  // Due work: agents see their own follow-ups; admins see the whole team's.
  // Scoped to callback tasks so no-answer catch-ups don't show twice.
  const scope = isAdmin ? {} : { mine: 'true' }
  const tasks = useQuery({
    queryKey: ['engagement', 'due-tasks', 'callback', isAdmin ? 'all' : currentUser?.id],
    queryFn: () => getDueCandidateTasks({ ...scope, task_type: 'callback' }),
  })
  // Catch-up: candidates an agent called with no answer — need a retry.
  const catchUp = useQuery({
    queryKey: ['engagement', 'due-tasks', 'no_answer', isAdmin ? 'all' : currentUser?.id],
    queryFn: () => getDueCandidateTasks({ ...scope, task_type: 'no_answer' }),
  })

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
          <h1 className="text-xl font-semibold text-slate-800 dark:text-zinc-100">Engagement</h1>
          <p className="text-sm text-slate-500 dark:text-zinc-400">Re-engagement health, stuck candidates, and callback tasks.</p>
        </div>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ['engagement'] })}
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-zinc-300 hover:text-slate-900"
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
        <StatCard icon={ListTodo} label="Due work" value={d.tasks_due} accent="text-rose-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Analytics */}
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-medium text-slate-800 dark:text-zinc-100">Re-engagement funnel</h2>
            <select
              value={analyticsDays}
              onChange={(e) => setAnalyticsDays(Number(e.target.value))}
              className="text-xs bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-800 rounded px-2 py-1"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
          <div className="flex items-end gap-4 mb-4">
            <div>
              <div className="text-3xl font-semibold text-slate-800 dark:text-zinc-100">{funnel.candidates_nudged ?? 0}</div>
              <div className="text-xs text-slate-500 dark:text-zinc-400">nudged</div>
            </div>
            <div className="text-slate-300 text-2xl pb-1">→</div>
            <div>
              <div className="text-3xl font-semibold text-emerald-600">{funnel.candidates_replied ?? 0}</div>
              <div className="text-xs text-slate-500 dark:text-zinc-400">replied</div>
            </div>
            <div className="ml-auto text-right">
              <div className="text-2xl font-semibold text-slate-800 dark:text-zinc-100">{funnel.reply_rate_pct ?? 0}%</div>
              <div className="text-xs text-slate-500 dark:text-zinc-400">reply rate</div>
            </div>
          </div>
          <div className="text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">Messages sent ({a.total_sent ?? 0})</div>
          <div className="space-y-1">
            {(a.sent_by_type || []).map((row) => (
              <div key={row.type} className="flex justify-between text-sm">
                <span className="text-slate-600 dark:text-zinc-300">{String(row.type || '').replace(/_/g, ' ')}</span>
                <span className="text-slate-800 dark:text-zinc-100 font-medium">{row.sent}</span>
              </div>
            ))}
            {(!a.sent_by_type || a.sent_by_type.length === 0) && (
              <div className="text-sm text-slate-400 dark:text-zinc-500">No proactive messages in this window.</div>
            )}
          </div>
        </div>

        {/* Due callback tasks */}
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4 lg:col-span-2">
          <h2 className="font-medium text-slate-800 dark:text-zinc-100 mb-3">Due work</h2>
          {tasks.isLoading ? (
            <div className="text-sm text-slate-400 dark:text-zinc-500">Loading…</div>
          ) : (tasks.data || []).length === 0 ? (
            <div className="text-sm text-slate-400 dark:text-zinc-500">No tasks due. 🎉</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {(tasks.data || []).map((t) => (
                <div key={t.id} className="py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <Link to={`/communications?candidate=${t.candidate_id}`} className="text-sm font-medium text-slate-800 dark:text-zinc-100 hover:underline">
                      {t.candidate_name || t.candidate_phone || 'Candidate'}
                    </Link>
                    <div className="text-xs text-slate-500 dark:text-zinc-400 truncate">
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

        {/* Catch-up — no-answer calls that need a retry (this agent's, or all for admins). */}
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4 lg:col-span-3">
          <h2 className="font-medium text-slate-800 dark:text-zinc-100 mb-3 flex items-center gap-2">
            <PhoneMissed size={16} className="text-rose-600" /> Catch-up · No answer
            {(catchUp.data || []).length > 0 && (
              <span className="text-[11px] font-semibold bg-rose-100 text-rose-700 rounded-full px-2 py-0.5">{(catchUp.data || []).length}</span>
            )}
          </h2>
          {catchUp.isLoading ? (
            <div className="text-sm text-slate-400 dark:text-zinc-500">Loading…</div>
          ) : (catchUp.data || []).length === 0 ? (
            <div className="text-sm text-slate-400 dark:text-zinc-500">No missed calls to catch up on. 🎉</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 divide-y md:divide-y-0 divide-slate-100">
              {(catchUp.data || []).map((t) => (
                <div key={t.id} className="py-2 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <Link to={`/communications?candidate=${t.candidate_id}`} className="text-sm font-medium text-slate-800 dark:text-zinc-100 hover:underline">
                      {t.candidate_name || t.candidate_phone || 'Candidate'}
                    </Link>
                    <div className="text-xs text-slate-500 dark:text-zinc-400 truncate">
                      {new Date(t.due_at).toLocaleString()} · {t.note || 'No answer'}
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

      {/* Agent call activity (calling-console engagement) */}
      {!isAdmin ? (
        // ── Agent: their own conversation-panel call log + stats ──────────────
        (() => {
          const a = focusActivity.data || {}
          const mine = (a.per_agent || [])[0]
          return (
            <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-medium text-slate-800 dark:text-zinc-100 flex items-center gap-2">
                  <Phone size={16} className="text-rose-500" /> My call activity
                </h2>
                <select value={callDays} onChange={(e) => setCallDays(Number(e.target.value))} className="text-xs bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-800 rounded px-2 py-1">
                  <option value={1}>Today</option>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                </select>
              </div>
              <CallStatCells row={mine} />
              <p className="text-xs font-medium text-slate-500 dark:text-zinc-400 mb-2">Recent activity</p>
              <CallRecentFeed items={a.recent || []} showAgent={false} />
            </div>
          )
        })()
      ) : (
        // ── Admin: team overview + per-user drill-down ───────────────────────
        (() => {
          const team = teamActivity.data || {}
          const perAgent = team.per_agent || []
          const focusedRow = perAgent.find((r) => r.agent_id === focusAgentId)
          const focused = focusAgentId ? (focusActivity.data || {}) : null
          return (
            <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-medium text-slate-800 dark:text-zinc-100 flex items-center gap-2">
                  <Phone size={16} className="text-rose-500" /> Team call activity
                </h2>
                <select value={callDays} onChange={(e) => setCallDays(Number(e.target.value))} className="text-xs bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-800 rounded px-2 py-1">
                  <option value={1}>Today</option>
                  <option value={7}>7 days</option>
                  <option value={30}>30 days</option>
                </select>
              </div>

              {/* Per-agent table — click a row to view that agent's call log + stats */}
              {teamActivity.isLoading ? (
                <div className="text-sm text-slate-400 dark:text-zinc-500">Loading…</div>
              ) : perAgent.length === 0 ? (
                <div className="text-sm text-slate-400 dark:text-zinc-500">No calls logged in this window.</div>
              ) : (
                <div className="overflow-x-auto mb-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 dark:text-zinc-400 border-b border-slate-100 dark:border-zinc-800">
                        <th className="py-2 pr-3">Agent</th>
                        <th className="py-2 pr-3">Calls</th>
                        <th className="py-2 pr-3">Done</th>
                        <th className="py-2 pr-3">No answer</th>
                        <th className="py-2 pr-3">Follow-ups</th>
                        <th className="py-2 pr-3">Not interested</th>
                        <th className="py-2 pr-3">Avg dur.</th>
                        <th className="py-2 pr-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {perAgent.map((r) => (
                        <tr
                          key={r.agent_id || r.agent_name}
                          onClick={() => setFocusAgentId(r.agent_id === focusAgentId ? null : r.agent_id)}
                          className={`border-b border-slate-50 dark:border-zinc-800/60 cursor-pointer ${r.agent_id === focusAgentId ? 'bg-indigo-50' : 'hover:bg-slate-50 dark:bg-zinc-800/50'}`}
                        >
                          <td className="py-2 pr-3 font-medium text-slate-800 dark:text-zinc-100">{r.agent_name}{r.agent_id === currentUser?.id ? ' (you)' : ''}</td>
                          <td className="py-2 pr-3 text-slate-600 dark:text-zinc-300">{r.calls_logged}</td>
                          <td className="py-2 pr-3 text-emerald-700">{r.answered}</td>
                          <td className="py-2 pr-3 text-rose-700">{r.no_answer}</td>
                          <td className="py-2 pr-3 text-amber-700">{r.callbacks}</td>
                          <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-300">{r.not_interested}</td>
                          <td className="py-2 pr-3 text-slate-600 dark:text-zinc-300">{fmtDur(r.avg_duration_seconds)}</td>
                          <td className="py-2 pr-3 text-indigo-600 text-xs font-medium">{r.agent_id === focusAgentId ? 'Hide' : 'View'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Drill-down: the focused agent's own call log + stats, else the team feed */}
              {focusAgentId ? (
                <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold text-slate-800 dark:text-zinc-100">{focusedRow?.agent_name || 'Agent'} — call log &amp; stats</p>
                    <button type="button" onClick={() => setFocusAgentId(null)} className="text-xs text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:text-zinc-100">× Back to team</button>
                  </div>
                  <CallStatCells row={(focused.per_agent || [])[0] || focusedRow} />
                  <p className="text-xs font-medium text-slate-500 dark:text-zinc-400 mb-2">Recent activity</p>
                  <CallRecentFeed items={focused.recent || []} showAgent={false} />
                </div>
              ) : (
                <div>
                  <p className="text-xs font-medium text-slate-500 dark:text-zinc-400 mb-2">Recent activity (all agents)</p>
                  <CallRecentFeed items={team.recent || []} showAgent={true} />
                  {(team.by_disposition || []).length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {(team.by_disposition).map((d) => (
                        <span key={d.disposition} className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-600 dark:text-zinc-300">
                          {String(d.disposition).replace(/_/g, ' ')}: {d.count}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()
      )}

      {/* Stuck candidates */}
      <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium text-slate-800 dark:text-zinc-100">
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
            <label className="text-xs text-slate-500 dark:text-zinc-400 flex items-center gap-2">
              Idle for at least
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="text-xs bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-800 rounded px-2 py-1"
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
          <div className="text-sm text-slate-400 dark:text-zinc-500">Loading…</div>
        ) : (stuck.data?.candidates || []).length === 0 ? (
          <div className="text-sm text-slate-400 dark:text-zinc-500">No stuck candidates. 🎉</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 dark:text-zinc-400 border-b border-slate-100 dark:border-zinc-800">
                  <th className="py-2 pr-3">Candidate</th>
                  <th className="py-2 pr-3">Stage</th>
                  <th className="py-2 pr-3">Idle</th>
                  <th className="py-2 pr-3">Next best action</th>
                </tr>
              </thead>
              <tbody>
                {(stuck.data?.candidates || []).map((c) => (
                  <tr key={c.id} className="border-b border-slate-50 dark:border-zinc-800/60 hover:bg-slate-50 dark:bg-zinc-800/50">
                    <td className="py-2 pr-3">
                      <Link to={`/candidates/${c.id}`} className="font-medium text-slate-800 dark:text-zinc-100 hover:underline">
                        {c.name || c.phone || 'Candidate'}
                      </Link>
                      {c.phone && <div className="text-xs text-slate-400 dark:text-zinc-500">{c.phone}</div>}
                    </td>
                    <td className="py-2 pr-3 capitalize text-slate-600 dark:text-zinc-300">{c.status}</td>
                    <td className="py-2 pr-3 text-slate-600 dark:text-zinc-300">{c.days_since_contact}d</td>
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
