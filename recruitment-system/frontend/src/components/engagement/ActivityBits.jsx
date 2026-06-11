import { Link } from 'react-router-dom'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

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

// ── Series helpers ────────────────────────────────────────────────────────────
// /activity-series returns { agent_id: { 'YYYY-MM-DD': {calls,messages,actions,interviews} } }.
// dailyTotals turns one agent's map into an ordered array for the last N days.
export function dailyTotals(agentSeries, days, metrics = ['calls', 'messages', 'actions']) {
  const out = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000)
    const key = d.toISOString().slice(0, 10)
    const row = agentSeries?.[key]
    out.push(row ? metrics.reduce((s, m) => s + Number(row[m] || 0), 0) : 0)
  }
  return out
}

// Consecutive active days counted back from today (today still at 0 doesn't
// break the streak — the day isn't over).
export function streakFrom(daily) {
  if (!daily?.length) return 0
  let i = daily.length - 1
  let streak = 0
  if (daily[i] > 0) { streak++ }
  i--
  for (; i >= 0; i--) {
    if (daily[i] > 0) streak++
    else break
  }
  return streak
}

/** Tiny inline bar sparkline — no chart lib, scales to its container. */
export function Sparkline({ data = [], width = 96, height = 26, className = '' }) {
  const max = Math.max(1, ...data)
  const n = data.length || 1
  const gap = 1.5
  const barW = Math.max(1.5, (width - gap * (n - 1)) / n)
  return (
    <svg width={width} height={height} className={className} aria-hidden="true">
      {data.map((v, i) => {
        const h = Math.max(v > 0 ? 2.5 : 1, (v / max) * (height - 2))
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            rx={1}
            className={v > 0 ? 'fill-indigo-400 dark:fill-indigo-500' : 'fill-slate-200 dark:fill-zinc-700'}
          />
        )
      })}
    </svg>
  )
}

// Deterministic avatar color from the name, initials inside.
const AVATAR_COLORS = [
  'bg-indigo-500', 'bg-violet-500', 'bg-sky-500', 'bg-emerald-500',
  'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-fuchsia-500',
]
export function Avatar({ name, size = 30 }) {
  const str = String(name || '?')
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0
  const color = AVATAR_COLORS[hash % AVATAR_COLORS.length]
  const initials = str.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0 ${color}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials || '?'}
    </span>
  )
}

/** Delta vs previous period as a small chip with sign + %. */
export function DeltaChip({ now, prev }) {
  const a = Number(now || 0); const b = Number(prev || 0)
  if (a === b) {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-zinc-800 text-slate-500 dark:text-zinc-400">
        <Minus size={10} /> 0
      </span>
    )
  }
  const up = a > b
  const Icon = up ? TrendingUp : TrendingDown
  const pct = b > 0 ? Math.round(((a - b) / b) * 100) : null
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${up ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-950/40 text-rose-500 dark:text-rose-400'}`}>
      <Icon size={10} /> {up ? '+' : ''}{a - b}{pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}
    </span>
  )
}

/** KPI summary card for the panel header strip. */
export function KpiCard({ icon: Icon, label, value, prev, accent = 'text-indigo-600 dark:text-indigo-400' }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-2.5 flex items-center gap-2.5 min-w-0">
      <span className={`p-1.5 rounded-lg bg-slate-50 dark:bg-zinc-800/60 ${accent} shrink-0`}><Icon size={16} /></span>
      <div className="min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-xl font-bold text-slate-800 dark:text-zinc-100 leading-tight">{value ?? 0}</span>
          {prev !== undefined && <DeltaChip now={value} prev={prev} />}
        </div>
        <div className="text-[10px] text-slate-500 dark:text-zinc-400 truncate uppercase tracking-wide">{label}</div>
      </div>
    </div>
  )
}

/** Horizontal progress vs a daily-goal target (target × days in window). */
export function TargetBar({ value, target, label }) {
  if (!target) return null
  const pct = Math.min(100, Math.round((Number(value || 0) / target) * 100))
  const done = pct >= 100
  return (
    <div className="min-w-0" title={`${label}: ${value} of ${target} target`}>
      <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-zinc-400 mb-0.5">
        <span className="truncate">{label}</span>
        <span className={done ? 'text-emerald-600 font-semibold' : ''}>{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-100 dark:bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${done ? 'bg-emerald-500' : pct >= 60 ? 'bg-indigo-500' : 'bg-amber-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** SVG progress ring for the personal hero (today vs daily target). */
export function ProgressRing({ value, target, size = 72, stroke = 7, label, sub }) {
  const v = Number(value || 0)
  const t = Math.max(1, Number(target || 0))
  const pct = Math.min(1, v / t)
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const done = v >= t && Number(target || 0) > 0
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-slate-100 dark:stroke-zinc-800" />
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
            strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
            className={done ? 'stroke-emerald-500' : 'stroke-indigo-500'}
            style={{ transition: 'stroke-dashoffset 600ms ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-sm font-bold text-slate-800 dark:text-zinc-100 leading-none">{v}</span>
          {Number(target || 0) > 0 && <span className="text-[9px] text-slate-400 dark:text-zinc-500">/{target}</span>}
        </div>
      </div>
      <div className="text-center leading-tight">
        <div className="text-[10px] font-medium text-slate-600 dark:text-zinc-300">{label}</div>
        {sub && <div className="text-[9px] text-slate-400 dark:text-zinc-500">{sub}</div>}
      </div>
    </div>
  )
}

/** Rank badge — medals for the podium, plain number after. */
export function RankBadge({ rank }) {
  if (rank === 1) return <span className="text-base" title="Top performer">🥇</span>
  if (rank === 2) return <span className="text-base">🥈</span>
  if (rank === 3) return <span className="text-base">🥉</span>
  return <span className="text-[11px] font-semibold text-slate-400 dark:text-zinc-500 w-5 text-center inline-block">{rank}</span>
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
