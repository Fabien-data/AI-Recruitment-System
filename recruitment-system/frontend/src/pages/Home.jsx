import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import {
  Inbox, ClipboardCheck, CalendarDays, MessageSquare, PhoneOff, UserPlus,
  AlertTriangle, Briefcase, ArrowRight, FolderKanban, FileText,
} from 'lucide-react'
import { getWorkToday } from '../api'
import { formatInterviewTime } from '../utils/datetime'
import { useAuthStore, useRole } from '../stores/authStore'
import Dashboard from './Dashboard'

// Per-role "My Work Today" landing queue (UPGRADES.md #3). Admin keeps the rich
// analytics Dashboard; the operational roles land on a queue of what needs action
// now (real counts/lists from /api/me/work-today). Falls back to the Dashboard on
// any error so the home route is never broken.
export default function Home() {
  const { role, isAdmin } = useRole()
  const user = useAuthStore((s) => s.user)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['work-today'],
    queryFn: getWorkToday,
    enabled: !isAdmin,
    staleTime: 60_000,
  })

  if (isAdmin) return <Dashboard />
  if (isError) return <Dashboard /> // never strand the user on a broken home
  if (isLoading) return <HomeSkeleton name={user?.full_name} />

  const q = data?.queues || {}
  const firstName = (user?.full_name || '').trim().split(' ')[0] || 'there'

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          {greeting()}, {firstName}
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Here’s what needs your attention today.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {role === 'project_handler' && (
          <>
            <ListCard
              icon={Inbox} title="New applicants" accent="blue"
              items={q.new_applicants} viewAll={{ to: '/applications?status=screening', label: 'All applications' }}
              empty="No new applicants with a CV right now."
              render={(a) => (
                <Row key={a.application_id} to={`/candidates/${a.candidate_id}`}
                  primary={a.candidate_name} secondary={[a.job_title, a.project_title].filter(Boolean).join(' · ')} />
              )}
            />
            <CountCard icon={ClipboardCheck} title="Screenings due" accent="amber"
              value={q.screenings_due} sub="candidates awaiting certification"
              to="/communications?status=screening" cta="Review screening queue" />
            <ListCard
              icon={CalendarDays} title="Interviews today" accent="indigo"
              items={q.interviews_today} viewAll={{ to: '/interviews', label: 'All interviews' }}
              empty="No interviews scheduled today."
              render={(iv) => (
                <Row key={iv.id} to="/interviews"
                  primary={iv.candidate_name} secondary={iv.job_title}
                  meta={formatInterviewTime(iv.scheduled_datetime)} />
              )}
            />
          </>
        )}

        {role === 'marketing_agent' && (
          <>
            <ListCard
              icon={MessageSquare} title="Needs your reply" accent="rose"
              items={q.needs_reply} viewAll={{ to: '/communications?handoff_state=needs_human', label: 'Open Messages' }}
              empty="No chats waiting on a human right now. 🎉"
              render={(c) => (
                <Row key={c.id} to={`/communications?candidate=${c.id}`} primary={c.name} secondary={c.phone} />
              )}
            />
            <ListCard
              icon={PhoneOff} title="No-answer catch-ups" accent="amber"
              items={q.no_answer_catchups} viewAll={{ to: '/engagement', label: 'Engagement' }}
              empty="No catch-ups due."
              render={(t) => (
                <Row key={t.id} to={`/communications?candidate=${t.candidate_id}`}
                  primary={t.candidate_name} secondary={t.phone}
                  meta={t.due_at ? format(new Date(t.due_at), 'MMM d') : ''} />
              )}
            />
            <ListCard
              icon={UserPlus} title="New leads today" accent="emerald"
              items={q.new_leads_today} viewAll={{ to: '/communications?status=new', label: 'New queue' }}
              empty="No new leads yet today."
              render={(c) => (
                <Row key={c.id} to={`/communications?candidate=${c.id}`}
                  primary={c.name} secondary={c.phone}
                  meta={c.created_at ? format(new Date(c.created_at), 'p') : ''} />
              )}
            />
          </>
        )}

        {role === 'sourcing_department' && (
          <>
            <ListCard
              icon={AlertTriangle} title="Stuck candidates (idle > 2d)" accent="rose"
              items={q.stuck_candidates} viewAll={{ to: '/engagement', label: 'Engagement' }}
              empty="Nothing stuck — pipeline is moving. 🎉"
              render={(c) => (
                <Row key={c.id} to={`/candidates/${c.id}`} primary={c.name} secondary={c.status}
                  meta={c.days_idle != null ? `${Math.floor(c.days_idle)}d` : ''} />
              )}
            />
            <CountCard icon={ClipboardCheck} title="Screenings due" accent="amber"
              value={q.screenings_due} sub="awaiting certification"
              to="/communications?status=screening" cta="Review queue" />
            <ListCard
              icon={CalendarDays} title="Interviews today" accent="indigo"
              items={q.interviews_today} viewAll={{ to: '/interviews', label: 'All interviews' }}
              empty="No interviews today."
              render={(iv) => (
                <Row key={iv.id} to="/interviews" primary={iv.candidate_name} secondary={iv.job_title}
                  meta={formatInterviewTime(iv.scheduled_datetime)} />
              )}
            />
            <PipelineCard pipeline={q.pipeline} />
          </>
        )}

        {/* Awaiting CV — the conversion leak (#7), shown to every operational role */}
        {q.awaiting_cv != null && (
          <CountCard icon={FileText} title="Awaiting CV" accent="rose"
            value={q.awaiting_cv} sub="new leads with no CV on file yet"
            to="/engagement" cta="Chase CVs" />
        )}
      </div>
    </div>
  )
}

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

const ACCENTS = {
  blue: 'text-blue-600 dark:text-blue-400',
  amber: 'text-amber-600 dark:text-amber-400',
  indigo: 'text-indigo-600 dark:text-indigo-400',
  rose: 'text-rose-600 dark:text-rose-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
}

function CardShell({ icon: Icon, title, accent = 'blue', badge, children, footer }) {
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4 flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-medium text-zinc-800 dark:text-zinc-100 flex items-center gap-2 text-sm">
          <Icon size={16} className={ACCENTS[accent]} /> {title}
        </h2>
        {badge != null && (
          <span className="text-[11px] font-semibold bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-full px-2 py-0.5">
            {badge}
          </span>
        )}
      </div>
      <div className="flex-1">{children}</div>
      {footer}
    </div>
  )
}

function ListCard({ icon, title, accent, items, render, empty, viewAll }) {
  const list = Array.isArray(items) ? items : []
  return (
    <CardShell icon={icon} title={title} accent={accent} badge={list.length}>
      {list.length === 0 ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 py-6 text-center">{empty}</p>
      ) : (
        <div className="space-y-1">{list.slice(0, 8).map(render)}</div>
      )}
      {viewAll && (
        <Link to={viewAll.to} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline">
          {viewAll.label} <ArrowRight size={12} />
        </Link>
      )}
    </CardShell>
  )
}

function Row({ to, primary, secondary, meta }) {
  return (
    <Link to={to} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors">
      <div className="min-w-0">
        <p className="text-xs font-medium text-zinc-800 dark:text-zinc-100 truncate">{primary || 'Unknown'}</p>
        {secondary && <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate capitalize">{secondary}</p>}
      </div>
      {meta && <span className="text-[11px] text-zinc-400 flex-shrink-0">{meta}</span>}
    </Link>
  )
}

function CountCard({ icon, title, accent, value, sub, to, cta }) {
  return (
    <CardShell icon={icon} title={title} accent={accent}>
      <div className="py-2">
        <p className="text-4xl font-semibold text-zinc-900 dark:text-zinc-50">{value ?? 0}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{sub}</p>
      </div>
      <Link to={to} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline">
        {cta} <ArrowRight size={12} />
      </Link>
    </CardShell>
  )
}

function PipelineCard({ pipeline }) {
  const p = pipeline || {}
  const order = [
    ['new', 'New', 'blue'], ['screening', 'Screening', 'amber'],
    ['certified', 'Certified', 'emerald'], ['interview_scheduled', 'Interview', 'indigo'],
    ['future_pool', 'Future pool', 'zinc'],
  ]
  return (
    <CardShell icon={FolderKanban} title="Pipeline" accent="indigo">
      <div className="grid grid-cols-2 gap-2 py-1">
        {order.map(([key, label]) => (
          <Link key={key} to={`/communications?status=${key}`}
            className="rounded-lg border border-zinc-100 dark:border-zinc-800 px-2.5 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors">
            <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{p[key] ?? 0}</p>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</p>
          </Link>
        ))}
      </div>
    </CardShell>
  )
}

function HomeSkeleton({ name }) {
  const firstName = (name || '').trim().split(' ')[0] || 'there'
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{greeting()}, {firstName}</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading your work…</p>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 p-4 h-48 animate-pulse" />
        ))}
      </div>
    </div>
  )
}
