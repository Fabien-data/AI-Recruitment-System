import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Phone, Megaphone, Loader2, AlertTriangle } from 'lucide-react'
import { getAgentCallActivity, getMyScorecard, nudgeUser } from '../../api'
import { useAuthStore } from '../../stores/authStore'
import { notify } from '../ui/Toast'
import { CallStatCells, CallRecentFeed, LeftoverRow } from './ActivityBits'

/**
 * TeamActivityPanel — the admin's team-evaluation view, rendered at the VERY
 * TOP of the Engagement page. Claim-aware numbers (a call/message only counts
 * while the agent held the chat claim), open-claims workload, a "low
 * engagement" flag vs the team median, and a per-agent Nudge action that
 * notifies the agent in-app.
 */
export default function TeamActivityPanel() {
  const currentUser = useAuthStore((s) => s.user)
  const [callDays, setCallDays] = useState(7)
  const [focusAgentId, setFocusAgentId] = useState(null)
  const [nudgeFor, setNudgeFor] = useState(null)   // agent row the nudge popover is open for
  const [nudgeMsg, setNudgeMsg] = useState('')

  const callFrom = () => new Date(Date.now() - callDays * 86400000).toISOString()

  const teamActivity = useQuery({
    queryKey: ['engagement', 'call-activity', 'team', callDays],
    queryFn: () => getAgentCallActivity({ date_from: callFrom() }),
  })
  const focusActivity = useQuery({
    enabled: !!focusAgentId,
    queryKey: ['engagement', 'call-activity', 'focus', callDays, focusAgentId],
    queryFn: () => getAgentCallActivity({ date_from: callFrom(), agent_id: focusAgentId }),
  })
  // Trend + leftovers for the focused agent (admin drill-down of the scorecard).
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

  const team = teamActivity.data || {}
  const perAgent = team.per_agent || []
  const focusedRow = perAgent.find((r) => r.agent_id === focusAgentId)
  const focused = focusAgentId ? (focusActivity.data || {}) : null

  // Engagement score for the "low" flag: claim-aware calls + messages + actions
  // compared to the team median — rows under 50% of median get the amber badge.
  const score = (r) => Number(r.calls_logged || 0) + Number(r.messages_sent || 0) + Number(r.actions_total || 0)
  const sorted = perAgent.map(score).sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  const isLow = (r) => median > 0 && score(r) < median * 0.5

  const openNudge = (e, r) => {
    e.stopPropagation()
    setNudgeFor(r.agent_id === nudgeFor ? null : r.agent_id)
    setNudgeMsg(`Hi ${String(r.agent_name || '').split(' ')[0]}, your engagement is below the team's pace this week — let's pick it up. Check your scorecard on the Engagement page.`)
  }

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-slate-800 dark:text-zinc-100 flex items-center gap-2">
          <Phone size={16} className="text-rose-500" /> Team activity (calls · messages · screenings · certifications · interviews)
        </h2>
        <select value={callDays} onChange={(e) => setCallDays(Number(e.target.value))} className="text-xs bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-800 rounded px-2 py-1">
          <option value={1}>Today</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
        </select>
      </div>
      <p className="text-[11px] text-slate-400 dark:text-zinc-500 -mt-2 mb-3">
        Calls and messages count only while the agent holds the chat claim — claim first, then work.
      </p>

      {/* Per-agent table — click a row to drill into that agent */}
      {teamActivity.isLoading ? (
        <div className="text-sm text-slate-400 dark:text-zinc-500">Loading…</div>
      ) : perAgent.length === 0 ? (
        <div className="text-sm text-slate-400 dark:text-zinc-500">No activity in this window.</div>
      ) : (
        <div className="overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 dark:text-zinc-400 border-b border-slate-100 dark:border-zinc-800">
                <th className="py-2 pr-3">Agent</th>
                <th className="py-2 pr-3" title="Phone calls logged while holding the chat claim">Calls</th>
                <th className="py-2 pr-3" title="Messages sent while holding the chat claim">Messages</th>
                <th className="py-2 pr-3" title="Moved to Screening (job assigned)">Screenings</th>
                <th className="py-2 pr-3">Certified</th>
                <th className="py-2 pr-3">Interviews</th>
                <th className="py-2 pr-3">No answer</th>
                <th className="py-2 pr-3" title="All non-call actions">Actions</th>
                <th className="py-2 pr-3" title="Chats this agent currently holds">Claims</th>
                <th className="py-2 pr-3"></th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {perAgent.map((r) => (
                <tr
                  key={r.agent_id || r.agent_name}
                  onClick={() => setFocusAgentId(r.agent_id === focusAgentId ? null : r.agent_id)}
                  className={`border-b border-slate-50 dark:border-zinc-800/60 cursor-pointer ${r.agent_id === focusAgentId ? 'bg-indigo-50 dark:bg-indigo-950/30' : 'hover:bg-slate-50 dark:hover:bg-zinc-800/50'}`}
                >
                  <td className="py-2 pr-3 font-medium text-slate-800 dark:text-zinc-100">
                    <span className="inline-flex items-center gap-1.5">
                      {r.agent_name}{r.agent_id === currentUser?.id ? ' (you)' : ''}
                      {isLow(r) && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700" title="Engagement below 50% of the team median in this window">
                          <AlertTriangle size={10} /> low
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-slate-600 dark:text-zinc-300" title={Number(r.calls_unclaimed || 0) > 0 ? `+${r.calls_unclaimed} call(s) logged without holding the claim (not counted)` : undefined}>
                    {r.calls_logged}
                    {Number(r.calls_unclaimed || 0) > 0 && <span className="text-[10px] text-slate-400 dark:text-zinc-500"> (+{r.calls_unclaimed})</span>}
                  </td>
                  <td className="py-2 pr-3 text-sky-700 dark:text-sky-300">{r.messages_sent ?? 0}</td>
                  <td className="py-2 pr-3 text-amber-700">{r.screenings ?? 0}</td>
                  <td className="py-2 pr-3 text-emerald-700">{r.certifications ?? 0}</td>
                  <td className="py-2 pr-3 text-indigo-700 dark:text-indigo-300">{r.interviews_scheduled ?? 0}</td>
                  <td className="py-2 pr-3 text-rose-700">{r.no_answer}</td>
                  <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-300">{r.actions_total ?? 0}</td>
                  <td className="py-2 pr-3 text-violet-700 dark:text-violet-300">{r.open_claims ?? 0}</td>
                  <td className="py-2 pr-3">
                    {r.agent_id && r.agent_id !== currentUser?.id && (
                      <button
                        type="button"
                        onClick={(e) => openNudge(e, r)}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-600 hover:text-amber-800"
                        title="Send this agent an engagement check-in notification"
                      >
                        <Megaphone size={12} /> Nudge
                      </button>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-indigo-600 text-xs font-medium">{r.agent_id === focusAgentId ? 'Hide' : 'View'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Nudge popover */}
      {nudgeFor && (
        <div className="mb-4 p-3 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/20" onClick={(e) => e.stopPropagation()}>
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
            <button type="button" onClick={() => setNudgeFor(null)} className="text-[11px] text-slate-500 hover:text-slate-700">Cancel</button>
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

      {/* Drill-down: the focused agent's stats (with trend), leftovers and log */}
      {focusAgentId ? (
        <div className="rounded-lg border border-indigo-100 dark:border-indigo-900/50 bg-indigo-50/40 dark:bg-indigo-950/20 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-slate-800 dark:text-zinc-100">{focusedRow?.agent_name || 'Agent'} — activity, trend &amp; leftovers</p>
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
  )
}
