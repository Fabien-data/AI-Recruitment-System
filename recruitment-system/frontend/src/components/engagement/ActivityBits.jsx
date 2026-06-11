import { Link } from 'react-router-dom'
import { TrendingUp, TrendingDown } from 'lucide-react'

/**
 * ActivityBits — shared building blocks for the Engagement activity panels
 * (TeamActivityPanel for admins, PersonalScorecard for agents). Moved out of
 * Engagement.jsx so both panels render the same stat cells and activity feed.
 */

export const fmtDur = (s) => {
  const n = Number(s || 0)
  if (!n) return '—'
  const m = Math.floor(n / 60); const sec = n % 60
  return m ? `${m}m ${sec}s` : `${sec}s`
}

// Action-aware icons/labels for the engagement timeline (call_logs.action_type).
export const ACTION_ICON = { call: '📞', assign: '📋', certify: '✅', interview: '📅', follow_up: '🔁', no_answer: '📵', not_interested: '🚫', note: '📝' }
export const ACTION_LABEL = { call: 'call', assign: 'assigned to job', certify: 'certified', interview: 'interview scheduled', follow_up: 'follow-up', no_answer: 'no answer', not_interested: 'not interested', note: 'note' }
export function feedIcon(r) {
  if (r.action_type && ACTION_ICON[r.action_type]) return ACTION_ICON[r.action_type]
  return r.outcome === 'answered' ? '📞' : r.outcome === 'no_answer' ? '📵' : r.outcome === 'callback' ? '🔁' : '📝'
}
export function feedLabel(r) {
  if (r.action_type && r.action_type !== 'call' && ACTION_LABEL[r.action_type]) return ACTION_LABEL[r.action_type]
  return r.outcome ? String(r.outcome).replace(/_/g, ' ') : 'logged'
}

// Small green/red trend badge: current vs the previous period's value.
function DeltaBadge({ now, prev }) {
  const a = Number(now || 0); const b = Number(prev || 0)
  if (a === b) return null
  const up = a > b
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${up ? 'text-emerald-600' : 'text-rose-500'}`}>
      <Icon size={11} /> {up ? '+' : ''}{a - b}
    </span>
  )
}

/**
 * Per-agent stat cells. Pass `prev` (the previous window's aggregate from
 * /my-scorecard) to show trend deltas next to each number.
 */
export function CallStatCells({ row, prev }) {
  const cells = [
    ['Calls', 'calls_logged'],
    ['Screenings', 'screenings'],
    ['Certified', 'certifications'],
    ['Interviews', 'interviews_scheduled'],
    ['Messages', 'messages_sent'],
    ['No answer', 'no_answer'],
    ['Follow-ups', 'follow_ups'],
  ]
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
      {cells.map(([label, key]) => (
        <div key={label} className="rounded-lg border border-slate-200 dark:border-zinc-800 px-3 py-2">
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-semibold text-slate-800 dark:text-zinc-100">
              {row?.[key] ?? (key === 'follow_ups' ? row?.callbacks : null) ?? 0}
            </span>
            {prev && <DeltaBadge now={row?.[key] ?? 0} prev={prev?.[key] ?? 0} />}
          </div>
          <div className="text-[11px] text-slate-500 dark:text-zinc-400">{label}</div>
        </div>
      ))}
      <div className="rounded-lg border border-slate-200 dark:border-zinc-800 px-3 py-2">
        <div className="text-lg font-semibold text-slate-800 dark:text-zinc-100">{fmtDur(row?.avg_duration_seconds)}</div>
        <div className="text-[11px] text-slate-500 dark:text-zinc-400">Avg call</div>
      </div>
    </div>
  )
}

export function CallRecentFeed({ items, showAgent }) {
  if (!items || items.length === 0) return <div className="text-sm text-slate-400 dark:text-zinc-500">No activity yet.</div>
  return (
    <ul className="divide-y divide-slate-100 dark:divide-zinc-800 max-h-80 overflow-y-auto">
      {items.map((r) => (
        <li key={r.id} className="py-2 flex items-start gap-2 text-sm">
          <span className="mt-0.5 shrink-0">{feedIcon(r)}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Link to={`/communications?candidate=${r.candidate_id}`} className="font-medium text-slate-800 dark:text-zinc-100 hover:underline">{r.candidate_name || 'Candidate'}</Link>
              <span className="text-[11px] text-slate-500 dark:text-zinc-400">{feedLabel(r)}</span>
              {r.job_title && (r.action_type === 'assign' || r.action_type === 'certify' || r.action_type === 'interview') && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300">{r.job_title}</span>
              )}
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

/**
 * One leftover row — a claimed chat / due callback / catch-up / awaiting-CV
 * item with a quick "Continue" link straight into the conversation.
 */
export function LeftoverRow({ candidateId, name, detail, hint, action = 'Continue' }) {
  return (
    <div className="py-2 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <Link to={`/communications?candidate=${candidateId}`} className="text-sm font-medium text-slate-800 dark:text-zinc-100 hover:underline">
          {name || 'Candidate'}
        </Link>
        <div className="text-xs text-slate-500 dark:text-zinc-400 truncate">{detail}</div>
        {hint && <div className="text-[11px] text-indigo-600 dark:text-indigo-400">{hint}</div>}
      </div>
      <Link
        to={`/communications?candidate=${candidateId}`}
        className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400"
      >
        {action} ›
      </Link>
    </div>
  )
}
