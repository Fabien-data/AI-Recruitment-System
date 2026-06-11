import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Phone, Sparkles, MessageSquare, PhoneMissed, FileText, Bookmark } from 'lucide-react'
import { getMyScorecard, getAgentCallActivity, getDueCandidateTasks, getAwaitingCv } from '../../api'
import { useAuthStore } from '../../stores/authStore'
import { CallStatCells, CallRecentFeed, LeftoverRow } from './ActivityBits'

/**
 * PersonalScorecard — the agent's own growth view, rendered at the VERY TOP of
 * the Engagement page for non-admins. Claim-aware stats with trend vs the
 * previous period, plus every leftover (claimed chats, due callbacks, no-answer
 * catch-ups, awaiting-CV) with a one-click jump back into the conversation.
 */
export default function PersonalScorecard() {
  const currentUser = useAuthStore((s) => s.user)
  const [days, setDays] = useState(7)
  const callFrom = () => new Date(Date.now() - days * 86400000).toISOString()

  const scorecard = useQuery({
    queryKey: ['engagement', 'scorecard', 'me', days],
    queryFn: () => getMyScorecard({ days }),
  })
  // Personal recent feed (the /call-logs endpoint self-scopes non-admins).
  const activity = useQuery({
    queryKey: ['engagement', 'call-activity', 'focus', days, currentUser?.id],
    queryFn: () => getAgentCallActivity({ date_from: callFrom(), agent_id: currentUser?.id }),
  })
  // Same query keys as the page-level sections so the cache is shared.
  const tasks = useQuery({
    queryKey: ['engagement', 'due-tasks', 'callback', currentUser?.id],
    queryFn: () => getDueCandidateTasks({ mine: 'true', task_type: 'callback' }),
  })
  const catchUp = useQuery({
    queryKey: ['engagement', 'due-tasks', 'no_answer', currentUser?.id],
    queryFn: () => getDueCandidateTasks({ mine: 'true', task_type: 'no_answer' }),
  })
  const awaitingCv = useQuery({
    queryKey: ['engagement', 'awaiting-cv'],
    queryFn: getAwaitingCv,
  })

  const cur = scorecard.data?.current || {}
  const prev = scorecard.data?.previous || {}
  const claims = scorecard.data?.leftovers?.open_claims || []

  // Encouraging one-liner: the biggest mover vs the previous window.
  const trendLine = () => {
    const metrics = [
      ['calls', 'calls_logged'], ['messages', 'messages_sent'],
      ['screenings', 'screenings'], ['interviews', 'interviews_scheduled'],
    ]
    let best = null
    for (const [label, key] of metrics) {
      const d = Number(cur[key] || 0) - Number(prev[key] || 0)
      if (!best || d > best.d) best = { label, d }
    }
    if (best && best.d > 0) return `Up ${best.d} on ${best.label} vs the previous ${days === 1 ? 'day' : `${days} days`} — keep it going! 🚀`
    if (best && best.d === 0) return 'Holding steady vs the previous period.'
    return 'A fresh window — claim a chat and make the first move. 💪'
  }

  const leftoverCount = claims.length + (tasks.data || []).length + (catchUp.data || []).length

  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg border border-slate-200 dark:border-zinc-800 p-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-medium text-slate-800 dark:text-zinc-100 flex items-center gap-2">
          <Phone size={16} className="text-rose-500" /> My activity &amp; growth
        </h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-800 rounded px-2 py-1">
          <option value={1}>Today</option>
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
        </select>
      </div>
      <p className="text-xs text-slate-500 dark:text-zinc-400 mb-3 flex items-center gap-1">
        <Sparkles size={12} className="text-amber-500" /> {trendLine()}
        <span className="text-slate-300 dark:text-zinc-600 mx-1">·</span>
        <span className="text-[11px]">Calls &amp; messages count once you've claimed the chat.</span>
      </p>

      <CallStatCells row={cur} prev={prev} />

      {/* Leftovers — pick up where you left off */}
      <div className="mb-4">
        <p className="text-xs font-semibold text-slate-600 dark:text-zinc-300 uppercase tracking-wide mb-2">
          Pick up where you left off{leftoverCount > 0 ? ` (${leftoverCount})` : ''}
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3">
          {/* My claimed chats */}
          <div>
            <p className="text-[11px] font-medium text-violet-700 dark:text-violet-300 mb-1 flex items-center gap-1">
              <Bookmark size={12} /> My claimed chats ({claims.length})
            </p>
            {claims.length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-zinc-500">No open claims — claim a chat to start working it.</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-56 overflow-y-auto">
                {claims.map((c) => (
                  <LeftoverRow
                    key={c.id}
                    candidateId={c.id}
                    name={c.name || c.phone}
                    detail={`${String(c.status || '').replace(/_/g, ' ')} · held ${c.days_held}d`}
                    hint={c.suggest_release ? 'Interview scheduled — you can release this claim ✅' : null}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Due callbacks */}
          <div>
            <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 mb-1 flex items-center gap-1">
              <MessageSquare size={12} /> Due callbacks ({(tasks.data || []).length})
            </p>
            {(tasks.data || []).length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-zinc-500">Nothing due. 🎉</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-56 overflow-y-auto">
                {(tasks.data || []).slice(0, 5).map((t) => (
                  <LeftoverRow
                    key={t.id}
                    candidateId={t.candidate_id}
                    name={t.candidate_name || t.candidate_phone}
                    detail={`${new Date(t.due_at).toLocaleString()} · ${t.note || 'callback'}`}
                  />
                ))}
              </div>
            )}
          </div>

          {/* No-answer catch-ups */}
          <div>
            <p className="text-[11px] font-medium text-rose-700 dark:text-rose-300 mb-1 flex items-center gap-1">
              <PhoneMissed size={12} /> No-answer catch-ups ({(catchUp.data || []).length})
            </p>
            {(catchUp.data || []).length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-zinc-500">All caught up. 🎉</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-56 overflow-y-auto">
                {(catchUp.data || []).slice(0, 5).map((t) => (
                  <LeftoverRow
                    key={t.id}
                    candidateId={t.candidate_id}
                    name={t.candidate_name || t.candidate_phone}
                    detail={`${new Date(t.due_at).toLocaleString()} · ${t.note || 'No answer'}`}
                    action="Retry"
                  />
                ))}
              </div>
            )}
          </div>

          {/* Awaiting CV (top 5) */}
          <div>
            <p className="text-[11px] font-medium text-blue-700 dark:text-blue-300 mb-1 flex items-center gap-1">
              <FileText size={12} /> Awaiting CV ({awaitingCv.data?.total ?? 0})
            </p>
            {(awaitingCv.data?.candidates || []).length === 0 ? (
              <p className="text-xs text-slate-400 dark:text-zinc-500">Every new lead has a CV. 🎉</p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-56 overflow-y-auto">
                {(awaitingCv.data.candidates || []).slice(0, 5).map((c) => (
                  <LeftoverRow
                    key={c.id}
                    candidateId={c.id}
                    name={c.name || c.phone}
                    detail={`No CV · waiting ${Math.floor(c.days_since_created)}d`}
                    action="Chase"
                  />
                ))}
                {(awaitingCv.data?.total ?? 0) > 5 && (
                  <Link to="/engagement" className="block py-1.5 text-[11px] text-blue-600 hover:text-blue-800">
                    View all {awaitingCv.data.total} in the Awaiting CV section below ↓
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="text-xs font-medium text-slate-500 dark:text-zinc-400 mb-2">My recent activity</p>
      <CallRecentFeed items={activity.data?.recent || []} showAgent={false} />
    </div>
  )
}
