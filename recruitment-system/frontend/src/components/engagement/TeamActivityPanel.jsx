import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Phone, Megaphone, Loader2, AlertTriangle, Search, Download, Target,
  MessageSquare, CalendarDays, CalendarCheck, BadgeCheck, Bookmark, Archive, Check, X,
} from 'lucide-react'
import Papa from 'papaparse'
import {
  getAgentCallActivity, getMyScorecard, nudgeUser,
  getActivitySeries, getEngagementTargets, setEngagementTarget,
} from '../../api'
import { useAuthStore } from '../../stores/authStore'
import { useRealtime } from '../../hooks/useRealtime'
import { colomboDayWindow } from '../../utils/datetime'
import { notify } from '../ui/Toast'
import {
  CallStatCells, CallRecentFeed, LeftoverRow,
  Sparkline, Avatar, DeltaChip, KpiCard, TargetBar, RankBadge, dailyTotals,
} from './ActivityBits'

// Stable refs for useRealtime (connect once per mount).
const LIVE_EVENTS = ['engagement_activity', 'claim_changed']
const LIVE_KEYS = [['engagement', 'call-activity'], ['engagement', 'scorecard'], ['engagement', 'series']]

const SORTABLE = [
  ['calls_logged', 'Calls'], ['messages_sent', 'Msgs'],
  ['screenings', 'Screened'], ['certifications', 'Certified'],
  ['interviews_scheduled', 'Interviews'],
  ['follow_ups', 'Follow Ups'], ['future_pool', 'Future Pool'],
  ['no_answer', 'No answer'], ['open_claims', 'Claims'],
]

// Ranking / medal metric: calls + messages (the agent's outreach volume). The
// old composite "score" column was removed — medals now reflect this directly.
const score = (r) => Number(r.calls_logged || 0) + Number(r.messages_sent || 0)

/**
 * TeamActivityPanel — the admin's team-evaluation cockpit at the very top of
 * the Engagement page. Claim-aware leaderboard with rank, avatars, daily
 * sparklines, score bars, target progress, live socket refresh, agent search,
 * sortable columns, per-agent nudges, inline target editing and CSV export.
 */
export default function TeamActivityPanel() {
  const currentUser = useAuthStore((s) => s.user)
  const qc = useQueryClient()
  const [callDays, setCallDays] = useState(7)
  const [focusAgentId, setFocusAgentId] = useState(null)
  const [nudgeFor, setNudgeFor] = useState(null)
  const [nudgeMsg, setNudgeMsg] = useState('')
  const [q, setQ] = useState('')                       // agent search
  const [sortKey, setSortKey] = useState('calls_logged')
  const [sortDir, setSortDir] = useState('desc')
  const [editTargets, setEditTargets] = useState(false) // inline targets editor
  const [draftTargets, setDraftTargets] = useState({})  // user_id -> {daily_calls, daily_messages}

  // "Today" = the Asia/Colombo calendar day (midnight→now), 7/30 = that many
  // Colombo calendar days ending today — NOT a rolling 24h/Nx24h span. prevFrom is
  // the equally-long window immediately before, for the KPI deltas.
  const callFrom = () => colomboDayWindow(callDays).from
  const prevFrom = () => colomboDayWindow(callDays).prevFrom

  // Live refresh whenever any agent logs a call / sends a message / claims.
  useRealtime({ events: LIVE_EVENTS, invalidateKeys: LIVE_KEYS })

  const teamActivity = useQuery({
    queryKey: ['engagement', 'call-activity', 'team', callDays],
    queryFn: () => getAgentCallActivity({ date_from: callFrom() }),
  })
  // Previous window of the same length → KPI deltas.
  const prevActivity = useQuery({
    queryKey: ['engagement', 'call-activity', 'team-prev', callDays],
    queryFn: () => getAgentCallActivity({ date_from: prevFrom(), date_to: callFrom() }),
  })
  const sparkDays = callDays === 1 ? 7 : Math.min(callDays, 30)
  const seriesQ = useQuery({
    queryKey: ['engagement', 'series', 'team', sparkDays],
    queryFn: () => getActivitySeries({ days: sparkDays }),
  })
  const targetsQ = useQuery({
    queryKey: ['engagement', 'targets'],
    queryFn: getEngagementTargets,
  })
  const focusActivity = useQuery({
    enabled: !!focusAgentId,
    queryKey: ['engagement', 'call-activity', 'focus', callDays, focusAgentId],
    queryFn: () => getAgentCallActivity({ date_from: callFrom(), agent_id: focusAgentId }),
  })
  const focusScorecard = useQuery({
    enabled: !!focusAgentId,
    queryKey: ['engagement', 'scorecard', focusAgentId, callDays],
    queryFn: () => getMyScorecard({ agent_id: focusAgentId, days: callDays }),
  })

  const nudgeMut = useMutation({
    mutationFn: (data) => nudgeUser(data),
    onSuccess: () => {
      notify.success({ title: 'Nudge sent', message: 'The agent has been notified.' })
      setNudgeFor(null); setNudgeMsg('')
    },
    onError: (e) => {
      if (e?.response?.status === 409) {
        notify.info({ title: 'Already nudged', message: 'This user was nudged in the last 24 hours.' })
      } else {
        notify.error({ title: 'Nudge failed', message: e?.response?.data?.error || e.message })
      }
    },
  })
  const targetMut = useMutation({
    mutationFn: ({ userId, data }) => setEngagementTarget(userId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['engagement', 'targets'] }),
    onError: (e) => notify.error({ title: 'Could not save target', message: e?.response?.data?.error || e.message }),
  })

  const team = teamActivity.data || {}
  const perAgent = team.per_agent || []
  const totals = team.totals || {}
  const prevTotals = prevActivity.data?.totals || {}
  const series = seriesQ.data?.series || {}
  const targetsByUser = useMemo(() => {
    const m = {}
    for (const t of targetsQ.data?.targets || []) m[t.user_id] = t
    return m
  }, [targetsQ.data])

  const median = useMemo(() => {
    const s = perAgent.map(score).sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length / 2)] : 0
  }, [perAgent])
  const isLow = (r) => median > 0 && score(r) < median * 0.5
  const maxScore = Math.max(1, ...perAgent.map(score))

  const rows = useMemo(() => {
    const ranked = [...perAgent].sort((a, b) => score(b) - score(a))
    const rankById = new Map(ranked.map((r, i) => [r.agent_id, i + 1]))
    let list = perAgent.map((r) => ({ ...r, score: score(r), rank: rankById.get(r.agent_id) }))
    if (q.trim()) {
      const needle = q.trim().toLowerCase()
      list = list.filter((r) => String(r.agent_name || '').toLowerCase().includes(needle))
    }
    const dir = sortDir === 'asc' ? 1 : -1
    list.sort((a, b) => (Number(a[sortKey] || 0) - Number(b[sortKey] || 0)) * dir || a.rank - b.rank)
    return list
  }, [perAgent, q, sortKey, sortDir])

  const onSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    else { setSortKey(key); setSortDir('desc') }
  }

  const exportCsv = () => {
    const csv = Papa.unparse(rows.map((r) => ({
      Rank: r.rank, Agent: r.agent_name,
      Calls: r.calls_logged,
      Messages: r.messages_sent, Screenings: r.screenings, Certified: r.certifications,
      Interviews: r.interviews_scheduled,
      'Follow ups': r.follow_ups, 'Future Pool': r.future_pool,
      'No answer': r.no_answer, Actions: r.actions_total,
      'Open claims': r.open_claims,
      'Daily call target': targetsByUser[r.agent_id]?.daily_calls || '',
    })))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `team-activity-${callDays}d-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const openNudge = (e, r) => {
    e.stopPropagation()
    setNudgeFor(r.agent_id === nudgeFor ? null : r.agent_id)
    setNudgeMsg(`Hi ${String(r.agent_name || '').split(' ')[0]}, your engagement is below the team's pace this week — let's pick it up. Check your scorecard on the Engagement page.`)
  }

  const draftFor = (id) => draftTargets[id] || {
    daily_calls: targetsByUser[id]?.daily_calls ?? 0,
    daily_messages: targetsByUser[id]?.daily_messages ?? 0,
  }
  const saveTarget = (id) => {
    const d = draftFor(id)
    targetMut.mutate({ userId: id, data: d })
  }

  const focusedRow = perAgent.find((r) => r.agent_id === focusAgentId)
  const focused = focusAgentId ? (focusActivity.data || {}) : null

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      {/* Header band */}
      <div className="px-4 pt-4 pb-3 bg-gradient-to-r from-indigo-50/80 via-white to-white dark:from-indigo-950/30 dark:via-zinc-900 dark:to-zinc-900">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-zinc-100 flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-indigo-600 text-white"><Phone size={14} /></span>
              Team activity
            </h2>
            <p className="text-[11px] text-slate-500 dark:text-zinc-400 mt-0.5">
              Every call &amp; message is credited to the agent who made it · rapid clicks on one candidate count as a single call · updates live
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditTargets((v) => !v)}
              className={`inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded-lg border transition-colors ${editTargets ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'}`}
              title="Set daily call/message goals per agent"
            >
              <Target size={12} /> Targets
            </button>
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-zinc-700 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800"
              title="Download this table as CSV"
            >
              <Download size={12} /> CSV
            </button>
            <select value={callDays} onChange={(e) => setCallDays(Number(e.target.value))} className="text-xs bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-700 rounded-lg px-2 py-1.5">
              <option value={1}>Today</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
            </select>
          </div>
        </div>

        {/* KPI strip with deltas vs the previous window */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2 mt-3">
          <KpiCard icon={Phone} label="Calls" value={Number(totals.calls_logged || 0)} prev={Number(prevTotals.calls_logged || 0)} accent="text-rose-500" />
          <KpiCard icon={MessageSquare} label="Messages" value={Number(totals.messages_sent || 0)} prev={Number(prevTotals.messages_sent || 0)} accent="text-sky-500" />
          <KpiCard icon={BadgeCheck} label="Certified" value={Number(totals.certifications || 0)} prev={Number(prevTotals.certifications || 0)} accent="text-emerald-500" />
          <KpiCard icon={CalendarCheck} label="Interviews" value={Number(totals.interviews_scheduled || 0)} prev={Number(prevTotals.interviews_scheduled || 0)} accent="text-indigo-500" />
          <KpiCard icon={CalendarDays} label="Follow ups" value={Number(totals.follow_ups || 0)} prev={Number(prevTotals.follow_ups || 0)} accent="text-cyan-500" />
          <KpiCard icon={Archive} label="Future Pool" value={Number(totals.future_pool || 0)} prev={Number(prevTotals.future_pool || 0)} accent="text-violet-500" />
          <KpiCard icon={Bookmark} label="Open claims" value={Number(totals.open_claims || 0)} accent="text-violet-500" />
        </div>
      </div>

      <div className="p-4">
        {/* Search */}
        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1 max-w-xs">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find an agent…"
              className="w-full pl-8 pr-2 py-1.5 text-xs bg-slate-50 dark:bg-zinc-800/60 border border-slate-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 text-slate-700 dark:text-zinc-200"
            />
          </div>
          <span className="text-[10px] text-slate-400 dark:text-zinc-500">Click a column to sort · click a row to drill in</span>
        </div>

        {/* Leaderboard */}
        {teamActivity.isLoading ? (
          <div className="text-sm text-slate-400 dark:text-zinc-500 py-6 text-center">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-slate-400 dark:text-zinc-500 py-6 text-center">No activity in this window.</div>
        ) : (
          <div className="overflow-x-auto mb-4 -mx-1 px-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-slate-500 dark:text-zinc-400 border-b border-slate-100 dark:border-zinc-800">
                  <th className="py-2 pr-3 font-medium">Agent</th>
                  <th className="py-2 pr-3 font-medium">Trend</th>
                  {SORTABLE.map(([key, label]) => (
                    <th
                      key={key}
                      onClick={() => onSort(key)}
                      className={`py-2 pr-3 font-medium cursor-pointer select-none whitespace-nowrap hover:text-slate-800 dark:hover:text-zinc-200 ${sortKey === key ? 'text-indigo-600 dark:text-indigo-400' : ''}`}
                    >
                      {label}{sortKey === key ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
                    </th>
                  ))}
                  <th className="py-2 pr-3 font-medium">{editTargets ? 'Daily targets' : 'Target progress'}</th>
                  <th className="py-2 pr-1" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const spark = dailyTotals(series[r.agent_id], sparkDays)
                  const target = targetsByUser[r.agent_id]
                  const callGoal = (target?.daily_calls || 0) * callDays
                  const draft = draftFor(r.agent_id)
                  return (
                    <tr
                      key={r.agent_id || r.agent_name}
                      onClick={() => !editTargets && setFocusAgentId(r.agent_id === focusAgentId ? null : r.agent_id)}
                      className={`border-b border-slate-50 dark:border-zinc-800/60 ${editTargets ? '' : 'cursor-pointer'} transition-colors ${r.agent_id === focusAgentId ? 'bg-indigo-50 dark:bg-indigo-950/30' : 'hover:bg-slate-50 dark:hover:bg-zinc-800/40'}`}
                    >
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <RankBadge rank={r.rank} />
                          <Avatar name={r.agent_name} size={28} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-slate-800 dark:text-zinc-100 truncate">{r.agent_name}</span>
                              {r.agent_id === currentUser?.id && <span className="text-[9px] font-semibold px-1 py-px rounded bg-indigo-100 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300">YOU</span>}
                              {isLow(r) && (
                                <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold px-1.5 py-px rounded-full bg-amber-100 text-amber-700" title="Engagement below 50% of the team median in this window">
                                  <AlertTriangle size={9} /> LOW
                                </span>
                              )}
                            </div>
                            {/* Relative score bar vs the top performer */}
                            <div className="h-1 w-28 rounded-full bg-slate-100 dark:bg-zinc-800 mt-1 overflow-hidden">
                              <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${Math.round((r.score / maxScore) * 100)}%` }} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3"><Sparkline data={spark} width={84} height={24} /></td>
                      <td className="py-2.5 pr-3 text-slate-600 dark:text-zinc-300">
                        {r.calls_logged}
                      </td>
                      <td className="py-2.5 pr-3 text-sky-700 dark:text-sky-300">{r.messages_sent ?? 0}</td>
                      <td className="py-2.5 pr-3 text-amber-700 dark:text-amber-400">{r.screenings ?? 0}</td>
                      <td className="py-2.5 pr-3 text-emerald-700 dark:text-emerald-400">{r.certifications ?? 0}</td>
                      <td className="py-2.5 pr-3 text-indigo-700 dark:text-indigo-300">{r.interviews_scheduled ?? 0}</td>
                      <td className="py-2.5 pr-3 text-cyan-700 dark:text-cyan-300">{r.follow_ups ?? 0}</td>
                      <td className="py-2.5 pr-3 text-violet-700 dark:text-violet-300">{r.future_pool ?? 0}</td>
                      <td className="py-2.5 pr-3 text-rose-700 dark:text-rose-400">{r.no_answer}</td>
                      <td className="py-2.5 pr-3 text-violet-700 dark:text-violet-300">{r.open_claims ?? 0}</td>
                      <td className="py-2.5 pr-3 min-w-[120px]" onClick={(e) => editTargets && e.stopPropagation()}>
                        {editTargets ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number" min="0" max="500"
                              value={draft.daily_calls}
                              onChange={(e) => setDraftTargets((p) => ({ ...p, [r.agent_id]: { ...draft, daily_calls: e.target.value } }))}
                              className="w-14 px-1.5 py-1 text-[11px] bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded"
                              title="Daily calls target"
                            />
                            <input
                              type="number" min="0" max="500"
                              value={draft.daily_messages}
                              onChange={(e) => setDraftTargets((p) => ({ ...p, [r.agent_id]: { ...draft, daily_messages: e.target.value } }))}
                              className="w-14 px-1.5 py-1 text-[11px] bg-white dark:bg-zinc-800 border border-slate-200 dark:border-zinc-700 rounded"
                              title="Daily messages target"
                            />
                            <button
                              type="button"
                              disabled={targetMut.isPending}
                              onClick={() => saveTarget(r.agent_id)}
                              className="p-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                              title="Save targets"
                            >
                              <Check size={11} />
                            </button>
                          </div>
                        ) : callGoal > 0 ? (
                          <TargetBar value={r.calls_logged} target={callGoal} label="calls" />
                        ) : (
                          <span className="text-[10px] text-slate-300 dark:text-zinc-600">no target</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-1 whitespace-nowrap">
                        {r.agent_id && r.agent_id !== currentUser?.id && (
                          <button
                            type="button"
                            onClick={(e) => openNudge(e, r)}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 hover:text-amber-800 mr-2"
                            title="Send this agent an engagement check-in notification"
                          >
                            <Megaphone size={12} /> Nudge
                          </button>
                        )}
                        {!editTargets && <span className="text-indigo-600 dark:text-indigo-400 text-[11px] font-medium">{r.agent_id === focusAgentId ? 'Hide' : 'View'}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Nudge popover */}
        {nudgeFor && (
          <div className="mb-4 p-3 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/20" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-2 flex items-center gap-1">
              <Megaphone size={13} /> Nudge {perAgent.find((r) => r.agent_id === nudgeFor)?.agent_name || 'agent'}
            </p>
            <textarea
              value={nudgeMsg}
              onChange={(e) => setNudgeMsg(e.target.value)}
              rows={2}
              className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-amber-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 resize-none"
            />
            <div className="flex items-center justify-end gap-2 mt-2">
              <button type="button" onClick={() => setNudgeFor(null)} className="text-[11px] text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"><X size={11} /> Cancel</button>
              <button
                type="button"
                disabled={nudgeMut.isPending}
                onClick={() => nudgeMut.mutate({ user_id: nudgeFor, message: nudgeMsg.trim() })}
                className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-60"
              >
                {nudgeMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Megaphone size={12} />} Send nudge
              </button>
            </div>
          </div>
        )}

        {/* Drill-down: focused agent — trend, leftovers, log */}
        {focusAgentId ? (
          <div className="rounded-xl border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50/40 dark:bg-indigo-950/20 p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-slate-800 dark:text-zinc-100 flex items-center gap-2">
                <Avatar name={focusedRow?.agent_name} size={24} /> {focusedRow?.agent_name || 'Agent'} — activity, trend &amp; leftovers
              </p>
              <button type="button" onClick={() => setFocusAgentId(null)} className="text-xs text-slate-500 dark:text-zinc-400 hover:text-slate-800 dark:hover:text-zinc-100">× Back to team</button>
            </div>
            <CallStatCells
              row={focusScorecard.data?.current || (focused.per_agent || [])[0] || focusedRow}
              prev={focusScorecard.data?.previous}
            />
            {(focusScorecard.data?.leftovers?.open_claims || []).length > 0 && (
              <div className="mb-3">
                <p className="text-xs font-medium text-slate-500 dark:text-zinc-400 mb-1">
                  Claimed chats still open ({focusScorecard.data.leftovers.open_claims.length})
                </p>
                <div className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-60 overflow-y-auto">
                  {focusScorecard.data.leftovers.open_claims.map((c) => (
                    <LeftoverRow
                      key={c.id}
                      candidateId={c.id}
                      name={c.name || c.phone}
                      detail={`${String(c.status || '').replace(/_/g, ' ')} · held ${c.days_held}d`}
                      hint={c.suggest_release ? 'Interview scheduled — agent can release this claim' : null}
                      action="Open"
                    />
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs font-medium text-slate-500 dark:text-zinc-400 mb-2">Recent activity</p>
            <CallRecentFeed items={focused?.recent || []} showAgent={false} />
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
    </div>
  )
}
