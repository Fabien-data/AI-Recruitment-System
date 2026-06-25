import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Phone, Sparkles, MessageSquare, PhoneMissed, FileText, Bookmark, Flame } from 'lucide-react'
import {
  getMyScorecard, getAgentCallActivity, getDueCandidateTasks, getAwaitingCv,
  getActivitySeries, getEngagementTargets,
} from '../../api'
import { useAuthStore } from '../../stores/authStore'
import { useRealtime } from '../../hooks/useRealtime'
import { colomboDayWindow, colomboDayKey } from '../../utils/datetime'
import {
  CallStatCells, CallRecentFeed, LeftoverRow,
  Sparkline, ProgressRing, dailyTotals, streakFrom,
} from './ActivityBits'

// Stable refs for useRealtime (connect once per mount).
const LIVE_EVENTS = ['engagement_activity', 'claim_changed']
const LIVE_KEYS = [['engagement', 'call-activity'], ['engagement', 'scorecard'], ['engagement', 'series']]

const SPARK_DAYS = 14

/**
 * PersonalScorecard — the agent's growth cockpit at the very top of the
 * Engagement page. Today's progress rings vs the admin-set daily targets,
 * activity streak, 14-day sparkline, claim-aware window stats with trend
 * deltas, tabbed leftovers with one-click jumps back into the chat, and a
 * personal activity feed. Refreshes live as work is logged.
 */
export default function PersonalScorecard() {
  const currentUser = useAuthStore((s) => s.user)
  const [days, setDays] = useState(7)
  const [tab, setTab] = useState('claims')
  // Colombo calendar-day window (Today = midnight→now), matching the team panel.
  const callFrom = () => colomboDayWindow(days).from

  useRealtime({ events: LIVE_EVENTS, invalidateKeys: LIVE_KEYS })

  const scorecard = useQuery({
    queryKey: ['engagement', 'scorecard', 'me', days],
    queryFn: () => getMyScorecard({ days }),
  })
  const activity = useQuery({
    queryKey: ['engagement', 'call-activity', 'focus', days, currentUser?.id],
    queryFn: () => getAgentCallActivity({ date_from: callFrom(), agent_id: currentUser?.id }),
  })
  const seriesQ = useQuery({
    queryKey: ['engagement', 'series', 'me', SPARK_DAYS],
    queryFn: () => getActivitySeries({ days: SPARK_DAYS }),
  })
  const targetsQ = useQuery({
    queryKey: ['engagement', 'targets', 'me'],
    queryFn: getEngagementTargets,
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
  const mySeries = seriesQ.data?.series?.[currentUser?.id] || {}
  const myTarget = (targetsQ.data?.targets || [])[0] || {}

  const todayKey = colomboDayKey()
  const today = mySeries[todayKey] || { calls: 0, messages: 0, actions: 0, interviews: 0 }
  const spark = useMemo(() => dailyTotals(mySeries, SPARK_DAYS), [mySeries])
  const streak = streakFrom(spark)

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

  const TABS = [
    { key: 'claims', label: 'My claims', icon: Bookmark, count: claims.length, color: 'text-violet-600 dark:text-violet-400' },
    { key: 'callbacks', label: 'Callbacks', icon: MessageSquare, count: (tasks.data || []).length, color: 'text-amber-600 dark:text-amber-400' },
    { key: 'catchups', label: 'Catch-ups', icon: PhoneMissed, count: (catchUp.data || []).length, color: 'text-rose-600 dark:text-rose-400' },
    { key: 'cv', label: 'Awaiting CV', icon: FileText, count: awaitingCv.data?.total ?? 0, color: 'text-blue-600 dark:text-blue-400' },
  ]

  const firstName = String(currentUser?.full_name || 'there').split(' ')[0]

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      {/* Hero band */}
      <div className="px-4 pt-4 pb-3 bg-gradient-to-r from-violet-50/80 via-white to-white dark:from-violet-950/30 dark:via-zinc-900 dark:to-zinc-900">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <h2 className="font-semibold text-slate-800 dark:text-zinc-100 flex items-center gap-2">
              <span className="p-1.5 rounded-lg bg-violet-600 text-white"><Phone size={14} /></span>
              Hey {firstName} — your day at a glance
              {streak >= 2 && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400" title={`${streak} active days in a row`}>
                  <Flame size={11} /> {streak}-day streak
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5 flex items-center gap-1">
              <Sparkles size={12} className="text-amber-500" /> {trendLine()}
            </p>
          </div>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs bg-white dark:bg-zinc-800 text-slate-700 dark:text-zinc-200 border border-slate-200 dark:border-zinc-700 rounded-lg px-2 py-1.5">
            <option value={1}>Today</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>

        {/* Today's rings vs daily targets + 14-day sparkline */}
        <div className="flex items-center gap-5 mt-3 flex-wrap">
          <ProgressRing
            value={today.calls}
            target={myTarget.daily_calls || 0}
            label="Calls today"
            sub={myTarget.daily_calls ? 'vs daily target' : 'no target set'}
          />
          <ProgressRing
            value={today.messages}
            target={myTarget.daily_messages || 0}
            label="Messages today"
            sub={myTarget.daily_messages ? 'vs daily target' : 'no target set'}
          />
          <ProgressRing
            value={today.actions}
            target={myTarget.daily_actions || 0}
            label="Actions today"
            sub={myTarget.daily_actions ? 'vs daily target' : 'no target set'}
          />
          <div className="flex-1 min-w-[140px]">
            <div className="text-[10px] text-slate-500 dark:text-zinc-400 uppercase tracking-wide mb-1">Last {SPARK_DAYS} days</div>
            <Sparkline data={spark} width={200} height={36} />
          </div>
        </div>
      </div>

      <div className="p-4">
        <p className="text-[11px] text-slate-400 dark:text-zinc-500 mb-2">
          Every call &amp; message you make is counted · rapid clicks on one candidate count as a single call.
        </p>
        <CallStatCells row={cur} prev={prev} />

        {/* Leftovers — tabbed, every row jumps straight into the chat */}
        <div className="mb-4">
          <div className="flex items-center gap-1 mb-2 border-b border-slate-100 dark:border-zinc-800 -mx-1 px-1 overflow-x-auto">
            {TABS.map((t) => {
              const Icon = t.icon
              const active = tab === t.key
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-2 border-b-2 -mb-px whitespace-nowrap transition-colors ${active ? 'border-indigo-500 text-slate-800 dark:text-zinc-100' : 'border-transparent text-slate-500 dark:text-zinc-400 hover:text-slate-700 dark:hover:text-zinc-200'}`}
                >
                  <Icon size={13} className={t.color} /> {t.label}
                  {t.count > 0 && (
                    <span className={`text-[10px] font-bold px-1.5 py-px rounded-full ${active ? 'bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300' : 'bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400'}`}>
                      {t.count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          <div className="max-h-64 overflow-y-auto">
            {tab === 'claims' && (
              claims.length === 0 ? (
                <p className="text-xs text-slate-400 dark:text-zinc-500 py-3">No open claims — claim a chat to start working it.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-zinc-800">
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
              )
            )}
            {tab === 'callbacks' && (
              (tasks.data || []).length === 0 ? (
                <p className="text-xs text-slate-400 dark:text-zinc-500 py-3">Nothing due. 🎉</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-zinc-800">
                  {(tasks.data || []).map((t) => (
                    <LeftoverRow
                      key={t.id}
                      candidateId={t.candidate_id}
                      name={t.candidate_name || t.candidate_phone}
                      detail={`${new Date(t.due_at).toLocaleString()} · ${t.note || 'callback'}`}
                    />
                  ))}
                </div>
              )
            )}
            {tab === 'catchups' && (
              (catchUp.data || []).length === 0 ? (
                <p className="text-xs text-slate-400 dark:text-zinc-500 py-3">All caught up. 🎉</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-zinc-800">
                  {(catchUp.data || []).map((t) => (
                    <LeftoverRow
                      key={t.id}
                      candidateId={t.candidate_id}
                      name={t.candidate_name || t.candidate_phone}
                      detail={`${new Date(t.due_at).toLocaleString()} · ${t.note || 'No answer'}`}
                      action="Retry"
                    />
                  ))}
                </div>
              )
            )}
            {tab === 'cv' && (
              (awaitingCv.data?.candidates || []).length === 0 ? (
                <p className="text-xs text-slate-400 dark:text-zinc-500 py-3">Every new lead has a CV. 🎉</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-zinc-800">
                  {(awaitingCv.data.candidates || []).slice(0, 15).map((c) => (
                    <LeftoverRow
                      key={c.id}
                      candidateId={c.id}
                      name={c.name || c.phone}
                      detail={`No CV · waiting ${Math.floor(c.days_since_created)}d`}
                      action="Chase"
                    />
                  ))}
                  {(awaitingCv.data?.total ?? 0) > 15 && (
                    <Link to="/engagement" className="block py-2 text-[11px] text-blue-600 hover:text-blue-800">
                      View all {awaitingCv.data.total} in the Awaiting CV section below ↓
                    </Link>
                  )}
                </div>
              )
            )}
          </div>
        </div>

        <p className="text-xs font-medium text-slate-500 dark:text-zinc-400 mb-2">My recent activity</p>
        <CallRecentFeed items={activity.data?.recent || []} showAgent={false} />
      </div>
    </div>
  )
}
