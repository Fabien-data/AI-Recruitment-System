import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Calendar, CalendarDays, Clock, MapPin, Briefcase, User, Phone,
  CheckCircle2, XCircle, Bell, Star, BarChart3, CalendarCheck, Hourglass, Filter,
  Send, FolderKanban, Download, AlertTriangle, Search, MessageSquare,
  CalendarClock, UserCheck, Copy, LayoutList, CalendarRange, Loader2, CheckCheck,
} from 'lucide-react'
import {
  getInterviews, getInterviewStats, getInterviewsByProject, updateInterview, deleteInterview, sendInterviewReminder,
  getProjects, getProject, updateProject, getInterviewers, bulkUpdateInterviews, exportInterviewsCsv, apiClient,
  downloadUnreachableCsv, getInterviewIds,
} from '../api'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Table } from '../components/ui/Table'
import { EmptyState } from '../components/ui/EmptyState'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Modal } from '../components/ui/Modal'
import { Pagination } from '../components/ui/Pagination'
import { showNotificationToast, showErrorToast } from '../utils/notificationToast'
import { formatInterviewDateTime } from '../utils/datetime'
import toast from 'react-hot-toast'

const PAGE_SIZE = 50
// Mass-notify is sent to the backend in sequential chunks so each HTTP request
// stays well under the platform request timeout even when notifying ~1000
// candidates. The backend throttles within a chunk; we drive chunk-by-chunk and
// show live progress, so the whole run survives a slow chatbot/Meta without a 504.
const NOTIFY_CHUNK = 20

// Download the "couldn't reach on WhatsApp" call list as a CSV and save it.
async function downloadCallListCsv(projectId) {
  try {
    const blob = await downloadUnreachableCsv({ project_id: projectId || undefined })
    triggerBlobDownload(blob, `unreachable-candidates-${new Date().toISOString().slice(0, 10)}.csv`)
  } catch (err) {
    showErrorToast(err, 'Could not download the call list')
  }
}

function triggerBlobDownload(blob, filename) {
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}

// One-tap toast offering the unreachable-candidate call list after a notify run.
function showCallListToast(count, projectId) {
  toast((t) => (
    <span className="flex items-center gap-2 text-sm">
      <AlertTriangle size={16} className="text-amber-500" />
      {count} candidate{count === 1 ? '' : 's'} not on WhatsApp.
      <button
        className="font-semibold text-indigo-600 hover:underline"
        onClick={() => { downloadCallListCsv(projectId); toast.dismiss(t.id) }}
      >
        Download call list (CSV)
      </button>
    </span>
  ), { duration: 12000 })
}

const STATUS_META = {
  scheduled: { tone: 'blue',    label: 'Scheduled',  pill: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 ring-blue-200 dark:ring-blue-900/60' },
  confirmed: { tone: 'emerald', label: 'Confirmed',  pill: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-900/60' },
  completed: { tone: 'purple',  label: 'Completed',  pill: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 ring-purple-200 dark:ring-purple-900/60' },
  cancelled: { tone: 'rose',    label: 'Cancelled',  pill: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 ring-rose-200 dark:ring-rose-900/60' },
  no_show:   { tone: 'amber',   label: 'No Show',    pill: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 ring-amber-200 dark:ring-amber-900/60' },
}

// Candidate's WhatsApp response to the invite (persisted candidate_response).
// 'confirmed' is intentionally omitted — the status pill already shows Confirmed.
const RESPONSE_META = {
  reschedule: { label: 'Reschedule requested', pill: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 ring-purple-200 dark:ring-purple-900/60' },
  cant_make:  { label: "Can't make it",        pill: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 ring-rose-200 dark:ring-rose-900/60' },
}

// Structured hiring outcome (separate from status + rating).
const OUTCOME_META = {
  passed:         { label: 'Passed',         pill: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-900/60' },
  failed:         { label: 'Failed',         pill: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 ring-rose-200 dark:ring-rose-900/60' },
  pending_review: { label: 'Pending review', pill: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 ring-amber-200 dark:ring-amber-900/60' },
}

// Interview times are a literal Asia/Colombo wall-clock — render them without a
// browser-timezone shift so the dashboard matches the candidate's WhatsApp invite.
function formatDateTime(dt) {
  return formatInterviewDateTime(dt)
}

function dayKey(dt) {
  if (!dt) return 'No date'
  // Use the literal wall-clock date portion (first 10 chars of ISO-ish string).
  const s = String(dt)
  return s.length >= 10 ? s.slice(0, 10) : s
}

// Overdue = still scheduled/confirmed but the time has passed.
function isOverdue(iv) {
  if (!['scheduled', 'confirmed'].includes(iv.status) || !iv.scheduled_datetime) return false
  return new Date(iv.scheduled_datetime).getTime() < Date.now()
}

// Due for a day-of check-in: active and within ~2h of now (or already past).
function isCheckinTime(iv) {
  if (!['scheduled', 'confirmed'].includes(iv.status) || !iv.scheduled_datetime) return false
  return new Date(iv.scheduled_datetime).getTime() <= Date.now() + 2 * 60 * 60 * 1000
}

function RatingStars({ value, onChange }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} onClick={() => onChange && onChange(n)} type="button" className={onChange ? 'cursor-pointer' : 'cursor-default'}>
          <Star
            size={16}
            className={n <= (value || 0) ? 'text-amber-400 fill-amber-400' : 'text-zinc-300 dark:text-zinc-600'}
          />
        </button>
      ))}
    </div>
  )
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || { label: status || 'unknown', pill: 'bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700' }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ring-1 ring-inset px-2 py-0.5 text-xs font-semibold ${meta.pill}`}>
      {meta.label}
    </span>
  )
}

function OutcomeBadge({ outcome }) {
  const meta = OUTCOME_META[outcome]
  if (!meta) return null
  return (
    <span className={`inline-flex items-center rounded-full ring-1 ring-inset px-2 py-0.5 text-[11px] font-semibold ${meta.pill}`}>
      {meta.label}
    </span>
  )
}

// Candidate-driven response badge (Reschedule requested / Can't make it) shown
// alongside the status pill so an in-progress reschedule is visible at a glance.
function ResponseBadge({ response }) {
  const meta = RESPONSE_META[response]
  if (!meta) return null
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ring-1 ring-inset px-2 py-0.5 text-[11px] font-semibold ${meta.pill}`}>
      {meta.label}
    </span>
  )
}

const STAT_TONES = {
  blue:    { wrap: 'section-grad-blue ring-blue-200/60 dark:ring-blue-900/60',       label: 'text-blue-700 dark:text-blue-300',       value: 'text-blue-900 dark:text-blue-100',       icon: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200' },
  emerald: { wrap: 'section-grad-emerald ring-emerald-200/60 dark:ring-emerald-900/60', label: 'text-emerald-700 dark:text-emerald-300', value: 'text-emerald-900 dark:text-emerald-100', icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200' },
  purple:  { wrap: 'section-grad-purple ring-purple-200/60 dark:ring-purple-900/60',   label: 'text-purple-700 dark:text-purple-300',   value: 'text-purple-900 dark:text-purple-100',   icon: 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-200' },
  amber:   { wrap: 'section-grad-amber ring-amber-200/60 dark:ring-amber-900/60',     label: 'text-amber-700 dark:text-amber-300',     value: 'text-amber-900 dark:text-amber-100',     icon: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200' },
  rose:    { wrap: 'ring-rose-200/60 dark:ring-rose-900/60 bg-rose-50/60 dark:bg-rose-950/20', label: 'text-rose-700 dark:text-rose-300', value: 'text-rose-900 dark:text-rose-100', icon: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-200' },
}

function StatCard({ tone = 'blue', icon: Icon, label, value }) {
  const t = STAT_TONES[tone] || STAT_TONES.blue
  return (
    <div className={`relative overflow-hidden rounded-2xl ring-1 ring-inset bg-white dark:bg-zinc-900 p-4 ${t.wrap}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className={`text-[10px] font-semibold uppercase tracking-wider ${t.label}`}>{label}</p>
          <p className={`mt-1 text-2xl font-bold tracking-tight ${t.value}`}>{value}</p>
        </div>
        {Icon && (
          <div className={`rounded-xl p-2.5 shadow-sm ${t.icon}`}>
            <Icon size={18} aria-hidden />
          </div>
        )}
      </div>
    </div>
  )
}

// Complete an interview: outcome status + structured outcome + rating + notes.
function FeedbackModal({ open, interview, onClose, onSave, loading }) {
  const [rating, setRating] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [status, setStatus] = useState('completed')
  const [outcome, setOutcome] = useState('')

  useEffect(() => {
    if (open && interview) {
      setRating(interview.rating || 0)
      setFeedback(interview.feedback || '')
      setStatus(interview.status === 'scheduled' || interview.status === 'confirmed' ? 'completed' : (interview.status || 'completed'))
      setOutcome(interview.outcome || '')
    }
  }, [open, interview])

  if (!interview) return null

  return (
    <Modal open={open} onClose={onClose} title="Complete Interview" size="md">
      <div className="space-y-5">
        <div className="rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 ring-1 ring-inset ring-zinc-200 dark:ring-zinc-800 p-3 text-sm">
          <p className="font-semibold text-zinc-900 dark:text-zinc-50">{interview.candidate_name}</p>
          <p className="text-zinc-500 dark:text-zinc-400">{interview.job_title}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} className="input w-full">
              <option value="completed">Completed</option>
              <option value="no_show">No Show</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Outcome</label>
            <select value={outcome} onChange={e => setOutcome(e.target.value)} className="input w-full">
              <option value="">No decision</option>
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="pending_review">Pending review</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Rating</label>
          <RatingStars value={rating} onChange={setRating} />
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Feedback</label>
          <textarea
            value={feedback}
            onChange={e => setFeedback(e.target.value)}
            rows={4}
            placeholder="Interview notes, strengths, concerns..."
            className="input w-full resize-none"
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ status, rating: rating || null, feedback, outcome: outcome || null })} loading={loading}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// Pick a new date/time for one or many interviews (re-sends the invite).
function RescheduleModal({ open, title, count = 1, onClose, onSave, loading }) {
  const [dt, setDt] = useState('')
  useEffect(() => { if (open) setDt('') }, [open])
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {count > 1 ? `${count} interviews` : 'This interview'} will be moved and the candidate{count > 1 ? 's' : ''} re-notified of the new time.
        </p>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">New date &amp; time</label>
          <input type="datetime-local" value={dt} onChange={e => setDt(e.target.value)} className="input w-full" />
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => dt && onSave(dt)} loading={loading} disabled={!dt}>Reschedule</Button>
        </div>
      </div>
    </Modal>
  )
}

// Day-of one-tap check-in for an interview happening now.
function CheckinModal({ open, interview, onClose, onAttended, onNoShow, onReschedule, loading }) {
  if (!interview) return null
  return (
    <Modal open={open} onClose={onClose} title="Check-in" size="sm">
      <div className="space-y-4">
        <div className="rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 ring-1 ring-inset ring-zinc-200 dark:ring-zinc-800 p-3 text-sm">
          <p className="font-semibold text-zinc-900 dark:text-zinc-50">{interview.candidate_name}</p>
          <p className="text-zinc-500 dark:text-zinc-400">{interview.job_title} · {formatDateTime(interview.scheduled_datetime)}</p>
        </div>
        <div className="grid grid-cols-1 gap-2">
          <Button onClick={onAttended} loading={loading} className="bg-emerald-600 hover:bg-emerald-500 text-white border-0 justify-center gap-2">
            <UserCheck size={16} /> Attended
          </Button>
          <Button onClick={onNoShow} loading={loading} variant="secondary" className="justify-center gap-2 text-amber-700 dark:text-amber-300">
            <AlertTriangle size={16} /> No show
          </Button>
          <Button onClick={onReschedule} variant="secondary" className="justify-center gap-2">
            <CalendarClock size={16} /> Reschedule
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// Confirm step before a (possibly large) mass-notify. States the count plainly
// and is honest about the out-of-window/template reality so an agent never
// assumes "955 sent" when many will queue until the candidate replies.
function NotifyConfirmModal({ open, count, onClose, onConfirm }) {
  if (!open) return null
  return (
    <Modal open={open} onClose={onClose} title={`Notify ${count} candidate${count === 1 ? '' : 's'}?`} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Each selected candidate will be sent (or re-sent) their interview invitation on WhatsApp. This runs in the background with live progress — keep the tab open until it finishes.
        </p>
        <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 ring-1 ring-inset ring-amber-200 dark:ring-amber-900/50 p-3 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>Candidates who haven&apos;t messaged in the last 24&nbsp;h can only receive this immediately if the interview template is approved by Meta. Otherwise their invite is <strong>queued</strong> and delivered automatically when they next reply. You&apos;ll see the exact breakdown as it sends.</span>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={onConfirm} disabled={count === 0} className="bg-blue-600 hover:bg-blue-500 text-white border-0 gap-1">
            <Send size={14} /> Send to {count}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function NotifySummaryChip({ label, value, tone }) {
  const t = STAT_TONES[tone] || STAT_TONES.blue
  return (
    <div className={`flex items-center justify-between gap-2 rounded-lg ring-1 ring-inset px-2.5 py-1.5 ${t.wrap}`}>
      <span className={`text-[11px] font-semibold ${t.label}`}>{label}</span>
      <span className={`text-sm font-bold tabular-nums ${t.value}`}>{value || 0}</span>
    </div>
  )
}

// Live progress + honest delivery breakdown for a chunked mass-notify run.
// While running it can't be dismissed; when done it offers "Retry failed" (which
// also clears previously out-of-window invites once the Meta template is live).
function NotifyProgressModal({ state, onClose, onRetry }) {
  if (!state) return null
  const { running, total, done, summary, failedIds } = state
  const s = summary || {}
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const failedCount = failedIds?.length || 0
  return (
    <Modal open onClose={running ? () => {} : onClose} title={running ? 'Sending invitations…' : 'Notification complete'} size="sm">
      <div className="space-y-4">
        <div>
          <div className="flex justify-between text-xs text-zinc-500 dark:text-zinc-400 mb-1">
            <span className="inline-flex items-center gap-1">
              {running && <Loader2 size={12} className="animate-spin" />}{done} / {total}
            </span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NotifySummaryChip label="Sent now" value={s.sent} tone="emerald" />
          <NotifySummaryChip label="Queued" value={s.queued} tone="blue" />
          <NotifySummaryChip label="Out of window" value={s.out_of_window} tone="amber" />
          <NotifySummaryChip label="No WhatsApp" value={s.no_whatsapp} tone="rose" />
          <NotifySummaryChip label="Rate-limited" value={s.rate_limited} tone="amber" />
          <NotifySummaryChip label="Other errors" value={(s.token_expired || 0) + (s.other || 0)} tone="rose" />
        </div>
        {(s.queued > 0 || s.out_of_window > 0) && !running && (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Queued invites deliver automatically when the candidate next replies. Out-of-window invites need the approved Meta interview template — once it&apos;s live, use “Retry failed” to deliver them.
          </p>
        )}
        {running ? (
          <p className="text-xs text-center text-zinc-500 dark:text-zinc-400">Keep this tab open until it finishes.</p>
        ) : (
          <div className="flex justify-end gap-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
            {failedCount > 0 && (
              <Button variant="secondary" onClick={() => onRetry(failedIds)} className="gap-1">
                <Send size={14} /> Retry failed ({failedCount})
              </Button>
            )}
            <Button onClick={onClose} className="gap-1"><CheckCheck size={14} /> Done</Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default function Interviews() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filters, setFilters] = useState({
    status: '',
    filter: '', // quick tab: '' | 'rescheduled'
    date_from: '',
    date_to: '',
    project_id: searchParams.get('project_id') || '',
    interviewer_id: '',
    outcome: '',
    search: '',
    location: '',        // venue contains-filter
    interview_date: '',  // single interview-day filter
    response: '',        // candidate_response drill-down (confirmed|reschedule|cant_make|no_answer)
  })
  const [page, setPage] = useState(1)
  const [view, setView] = useState('table') // 'table' | 'agenda' | 'by-project'
  const [feedbackTarget, setFeedbackTarget] = useState(null)
  const [rescheduleTarget, setRescheduleTarget] = useState(null) // single interview
  const [checkinTarget, setCheckinTarget] = useState(null)
  const [bulkRescheduleOpen, setBulkRescheduleOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [selectAllLoading, setSelectAllLoading] = useState(false)
  // { open, ids } — confirm dialog before a (potentially large) notify run.
  const [confirmNotify, setConfirmNotify] = useState(null)
  // { running, total, done, summary, failedIds } — live progress of a chunked run.
  const [notifyState, setNotifyState] = useState(null)

  // Reset to first page whenever a filter changes.
  useEffect(() => { setPage(1) }, [filters])

  const listParams = useMemo(
    () => ({ ...filters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    [filters, page]
  )

  const { data: listData, isLoading } = useQuery({
    queryKey: ['interviews', listParams],
    queryFn: () => getInterviews(listParams),
    keepPreviousData: true,
  })
  // Backward-compatible: old endpoint returned a bare array; new returns {data,total}.
  const interviews = Array.isArray(listData) ? listData : (listData?.data || [])
  const total = Array.isArray(listData) ? listData.length : (listData?.total || 0)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Accurate stats across ALL matching rows (server-side), not just this page.
  const { data: stats } = useQuery({
    queryKey: ['interview-stats', filters],
    queryFn: () => getInterviewStats(filters),
    staleTime: 15_000,
  })

  // Per-project scoreboard — only fetched while the by-project view is open.
  const { data: byProjectData, isLoading: byProjectLoading } = useQuery({
    queryKey: ['interviews-by-project', filters],
    queryFn: () => getInterviewsByProject(filters),
    enabled: view === 'by-project',
    staleTime: 15_000,
  })
  const byProject = Array.isArray(byProjectData?.projects) ? byProjectData.projects : []

  const { data: projectsData } = useQuery({
    queryKey: ['projects', 'interviews-filter'],
    queryFn: () => getProjects({ limit: 200 }),
    staleTime: 60_000,
  })
  const projects = Array.isArray(projectsData?.data) ? projectsData.data : []

  const { data: interviewersData } = useQuery({
    queryKey: ['interviewers'],
    queryFn: () => getInterviewers(),
    staleTime: 60_000,
  })
  const interviewers = Array.isArray(interviewersData) ? interviewersData : (interviewersData?.data || [])

  const setProjectFilter = (id) => {
    setSelectedIds(new Set())
    setFilters((f) => ({ ...f, project_id: id }))
    const next = new URLSearchParams(searchParams)
    if (id) next.set('project_id', id)
    else next.delete('project_id')
    setSearchParams(next, { replace: true })
  }

  const toggleSelected = (id) => setSelectedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const selectAllVisible = () => setSelectedIds(new Set(interviews.map(iv => iv.id)))
  const clearSelected = () => setSelectedIds(new Set())

  // Select EVERY notifiable interview matching the current filters (across all
  // pages) — the "notify all 955 in this project at once" path. Fetches just the
  // ids so the selection isn't capped to the 50 rows on screen.
  const selectAllMatching = async () => {
    setSelectAllLoading(true)
    try {
      const res = await getInterviewIds({ ...filters })
      const ids = Array.isArray(res?.ids) ? res.ids : []
      setSelectedIds(new Set(ids))
      if (res?.capped) {
        toast(`Selected the first ${ids.length}. Narrow the filter to include the rest.`, { icon: '⚠️', duration: 8000 })
      } else if (ids.length === 0) {
        toast('No candidates to notify for this filter')
      } else {
        toast.success(`Selected ${ids.length} candidate${ids.length === 1 ? '' : 's'}`)
      }
    } catch (err) {
      showErrorToast(err, 'Could not select all matching')
    } finally {
      setSelectAllLoading(false)
    }
  }

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['interviews'] })
    queryClient.invalidateQueries({ queryKey: ['interview-stats'] })
  }

  // Chunked, resumable mass-notify. Sends the interview WhatsApp to every given
  // interview id in sequential batches of NOTIFY_CHUNK, accumulating an honest
  // per-reason delivery breakdown and the list of ids that didn't reach the
  // candidate (for "Retry failed"). Drives a live progress modal; never relies on
  // a single huge request that could 504 part-way through.
  const runNotify = async (idList) => {
    const all = Array.from(idList || [])
    if (all.length === 0) return
    const summary = { sent: 0, queued: 0, out_of_window: 0, no_whatsapp: 0, rate_limited: 0, token_expired: 0, other: 0 }
    let failedIds = []
    setNotifyState({ running: true, total: all.length, done: 0, summary: { ...summary }, failedIds: [] })
    for (let i = 0; i < all.length; i += NOTIFY_CHUNK) {
      const batch = all.slice(i, i + NOTIFY_CHUNK)
      try {
        const res = await apiClient
          .post('/api/interviews/bulk-notify', { interview_ids: batch })
          .then((r) => r.data)
        const ds = res?.delivery_summary || {}
        for (const k of Object.keys(summary)) summary[k] += Number(ds[k] || 0)
        if (Array.isArray(res?.failed_interview_ids)) failedIds = failedIds.concat(res.failed_interview_ids)
      } catch (err) {
        // Whole-chunk failure (network / timeout): count the batch as errored and
        // queue every id in it for retry so nothing is silently lost.
        summary.other += batch.length
        failedIds = failedIds.concat(batch)
      }
      setNotifyState({
        running: true,
        total: all.length,
        done: Math.min(i + NOTIFY_CHUNK, all.length),
        summary: { ...summary },
        failedIds: [...failedIds],
      })
    }
    setNotifyState({ running: false, total: all.length, done: all.length, summary: { ...summary }, failedIds: [...failedIds] })
    invalidateAll()
    if (summary.no_whatsapp > 0) showCallListToast(summary.no_whatsapp, filters.project_id)
  }

  const bulkUpdateMutation = useMutation({
    mutationFn: (body) => bulkUpdateInterviews(body),
    onSuccess: (result) => {
      toast.success(`Updated ${result?.updated ?? 0} interview(s)`)
      invalidateAll()
      clearSelected()
      setBulkRescheduleOpen(false)
    },
    onError: (err) => showErrorToast(err, 'Bulk update failed'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateInterview(id, data),
    onSuccess: () => invalidateAll(),
  })

  const cancelMutation = useMutation({
    mutationFn: (id) => deleteInterview(id),
    onSuccess: () => invalidateAll(),
  })

  const reminderMutation = useMutation({
    mutationFn: (id) => sendInterviewReminder(id, {}),
    onSuccess: (result) => showNotificationToast(result?.notification, 'Reminder sent'),
    onError: (err) => showErrorToast(err, 'Reminder failed'),
  })

  const handleFeedbackSave = (id, data) => {
    updateMutation.mutate({ id, data })
    setFeedbackTarget(null)
  }

  const handleReschedule = (dt) => {
    if (!rescheduleTarget) return
    updateMutation.mutate({ id: rescheduleTarget.id, data: { scheduled_datetime: dt } })
    setRescheduleTarget(null)
  }

  const handleCheckin = (status) => {
    if (!checkinTarget) return
    updateMutation.mutate({ id: checkinTarget.id, data: { status } })
    setCheckinTarget(null)
  }

  const copyPhone = (phone) => {
    if (!phone) return
    navigator.clipboard?.writeText(phone).then(
      () => toast.success('Phone copied'),
      () => toast.error('Could not copy'),
    )
  }

  const exportCsv = async () => {
    try {
      const blob = await exportInterviewsCsv(filters)
      triggerBlobDownload(blob, `interviews-${new Date().toISOString().slice(0, 10)}.csv`)
    } catch (err) {
      showErrorToast(err, 'Could not export interviews')
    }
  }

  const clearFilters = () => setFilters((f) => ({
    status: '', filter: '', date_from: '', date_to: '', project_id: f.project_id, interviewer_id: '', outcome: '', search: '',
    location: '', interview_date: '', response: '',
  }))

  // Drill from a per-project scoreboard chip into the filtered interview table.
  const drillToProject = (projectId, patch = {}) => {
    setSelectedIds(new Set())
    setFilters((f) => ({
      ...f, project_id: projectId,
      status: '', filter: '', response: '', // reset response/status dimensions first
      ...patch,
    }))
    const next = new URLSearchParams(searchParams)
    if (projectId) next.set('project_id', projectId); else next.delete('project_id')
    setSearchParams(next, { replace: true })
    setView('table')
  }

  // Quick status tabs (under the project tabs). 'rescheduled' uses the dedicated
  // backend filter (reschedule_count > 0); the others map onto iv.status.
  const STATUS_TABS = [
    { key: 'all', label: 'All' },
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'confirmed', label: 'Confirmed' },
    { key: 'completed', label: 'Completed' },
    { key: 'rescheduled', label: 'Rescheduled' },
  ]
  const activeTab = filters.filter === 'rescheduled' ? 'rescheduled' : (filters.status || 'all')
  const setTab = (key) => {
    setSelectedIds(new Set())
    setFilters((f) => ({
      ...f,
      status: ['scheduled', 'confirmed', 'completed'].includes(key) ? key : '',
      filter: key === 'rescheduled' ? 'rescheduled' : '',
    }))
  }

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={CalendarDays}
        tone="blue"
        title="Interview Management"
        subtitle="Schedule, track, and complete candidate interviews"
        actions={
          <div className="flex items-center gap-2">
            <ViewToggle view={view} onChange={setView} />
            <Button variant="secondary" onClick={exportCsv} title="Export the current filtered list to CSV">
              <Download size={16} /> Export CSV
            </Button>
            <Button
              variant="secondary"
              onClick={() => downloadCallListCsv(filters.project_id)}
              title="Download the list of candidates we couldn't reach on WhatsApp, to call manually"
            >
              <Phone size={16} /> Call list
            </Button>
          </div>
        }
      />

      {/* Project tabs */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setProjectFilter('')}
          className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium transition ${
            !filters.project_id
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700'
          }`}
        >
          All Projects
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setProjectFilter(p.id)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition ${
              filters.project_id === p.id
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700'
            }`}
          >
            <FolderKanban size={12} />
            <span className="truncate max-w-[200px]">{p.title}</span>
          </button>
        ))}
      </div>

      {/* Quick status tabs */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition ${
              activeTab === t.key
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'bg-white text-zinc-700 border border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700'
            }`}
          >
            {t.key === 'rescheduled' && <CalendarClock size={12} />}
            {t.label}
            {t.key === 'rescheduled' && stats?.rescheduled ? (
              <span className="ml-0.5 inline-flex items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/50 px-1.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">{stats.rescheduled}</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Per-project interview details — injected into the bulk interview invite. */}
      {filters.project_id && <InterviewConfigEditor projectId={filters.project_id} />}

      {/* Stats strip — server-side aggregates (accurate across all rows). */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-6">
        <StatCard tone="blue"    icon={CalendarCheck} label="Today"      value={stats?.today ?? '—'} />
        <StatCard tone="purple"  icon={CalendarDays}  label="This Week"  value={stats?.this_week ?? '—'} />
        <StatCard tone="rose"    icon={AlertTriangle} label="Overdue"    value={stats?.overdue ?? '—'} />
        <StatCard tone="emerald" icon={BarChart3}     label="Completed"  value={stats?.completed ?? '—'} />
        <StatCard tone="amber"   icon={Hourglass}     label="Cancelled / No-show" value={(Number(stats?.cancelled || 0) + Number(stats?.no_show || 0)) || (stats ? 0 : '—')} />
        <StatCard tone="blue"    icon={Send}          label="Pending send" value={stats?.pending_send ?? '—'} />
        {/* Candidate-driven WhatsApp button outcomes. */}
        <StatCard tone="emerald" icon={CheckCircle2}  label="Confirmed"    value={stats?.confirmed ?? '—'} />
        <StatCard tone="purple"  icon={CalendarClock} label="Reschedule requested" value={stats?.reschedule_requested ?? '—'} />
        <StatCard tone="rose"    icon={XCircle}       label="Can't make it" value={stats?.cant_make ?? '—'} />
      </div>

      {/* Filters */}
      <Card className="p-4 mb-6">
        <div className="flex items-center gap-2 mb-3 text-zinc-800 dark:text-zinc-200">
          <Filter size={16} aria-hidden />
          <h2 className="text-sm font-semibold">Filters</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
          <div className="xl:col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Search candidate</label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                type="text"
                placeholder="Name or phone…"
                value={filters.search}
                onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
                className="input w-full pl-8"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Status</label>
            <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} className="input w-full">
              <option value="">All statuses</option>
              {Object.entries(STATUS_META).map(([value, meta]) => (
                <option key={value} value={value}>{meta.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Interviewer</label>
            <select value={filters.interviewer_id} onChange={e => setFilters(f => ({ ...f, interviewer_id: e.target.value }))} className="input w-full">
              <option value="">All interviewers</option>
              {interviewers.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">From</label>
            <input type="date" value={filters.date_from} onChange={e => setFilters(f => ({ ...f, date_from: e.target.value }))} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">To</label>
            <input type="date" value={filters.date_to} onChange={e => setFilters(f => ({ ...f, date_to: e.target.value }))} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Interview day</label>
            <input type="date" value={filters.interview_date} onChange={e => setFilters(f => ({ ...f, interview_date: e.target.value }))} className="input w-full" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Venue</label>
            <div className="relative">
              <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                type="text"
                placeholder="e.g. Colombo…"
                value={filters.location}
                onChange={e => setFilters(f => ({ ...f, location: e.target.value }))}
                className="input w-full pl-8"
              />
            </div>
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button>
        </div>
      </Card>

      {/* Per-project scoreboard OR the interview list */}
      {view === 'by-project' ? (
        <InterviewsByProject projects={byProject} loading={byProjectLoading} onDrill={drillToProject} />
      ) : (
      <Card className="overflow-hidden p-0">
        {isLoading ? (
          <div className="p-5"><TableSkeleton rows={6} cols={7} /></div>
        ) : interviews.length === 0 ? (
          <EmptyState
            icon={Calendar}
            tone="blue"
            title="No interviews found"
            description="Schedule interviews from Applications (bulk schedule) — they'll appear here."
          />
        ) : (
          <>
            <div className="px-4 py-2 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between gap-3 text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : `${total} interview${total === 1 ? '' : 's'}`}
              </span>
              {activeTab !== 'rescheduled' && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={selectedIds.size >= interviews.length && interviews.length > 0 ? clearSelected : selectAllVisible}
                    className="text-xs font-medium text-primary-600 hover:text-primary-700"
                  >
                    {selectedIds.size >= interviews.length && interviews.length > 0 ? 'Clear selection' : 'Select all on page'}
                  </button>
                  {total > interviews.length && (
                    <button
                      type="button"
                      onClick={selectAllMatching}
                      disabled={selectAllLoading}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-700 disabled:opacity-50"
                      title={`Select every notifiable candidate matching this filter${filters.project_id ? ' in this project' : ''}`}
                    >
                      {selectAllLoading ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />}
                      {selectAllLoading ? 'Selecting…' : `Select all ${total} matching`}
                    </button>
                  )}
                </div>
              )}
            </div>

            {activeTab === 'rescheduled' ? (
              <RescheduledTable interviews={interviews} onCopyPhone={copyPhone} />
            ) : view === 'agenda' ? (
              <AgendaView
                interviews={interviews}
                onReschedule={setRescheduleTarget}
                onCheckin={setCheckinTarget}
                onComplete={setFeedbackTarget}
                onReminder={(id) => reminderMutation.mutate(id)}
                onCancel={(id) => { if (confirm('Cancel this interview?')) cancelMutation.mutate(id) }}
              />
            ) : (
              <InterviewTable
                interviews={interviews}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelected}
                onSelectAll={(checked) => checked ? selectAllVisible() : clearSelected()}
                allChecked={interviews.length > 0 && selectedIds.size >= interviews.length}
                onReminder={(id) => reminderMutation.mutate(id)}
                onComplete={setFeedbackTarget}
                onReschedule={setRescheduleTarget}
                onCheckin={setCheckinTarget}
                onCancel={(id) => { if (confirm('Cancel this interview?')) cancelMutation.mutate(id) }}
                onCopyPhone={copyPhone}
              />
            )}

            <Pagination
              page={page}
              totalPages={totalPages}
              total={total}
              pageSize={PAGE_SIZE}
              onChange={setPage}
            />
          </>
        )}
      </Card>
      )}

      {/* Floating bulk-action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white rounded-2xl shadow-2xl px-5 py-3 flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <Button size="sm" onClick={() => setConfirmNotify({ open: true, ids: Array.from(selectedIds) })} disabled={!!notifyState?.running} className="bg-blue-500 hover:bg-blue-400 text-white border-0 gap-1">
            <Send size={14} /> {notifyState?.running ? 'Notifying…' : 'Notify'}
          </Button>
          <Button size="sm" onClick={() => setBulkRescheduleOpen(true)} className="bg-indigo-500 hover:bg-indigo-400 text-white border-0 gap-1">
            <CalendarClock size={14} /> Reschedule
          </Button>
          <Button size="sm" onClick={() => bulkUpdateMutation.mutate({ interview_ids: Array.from(selectedIds), status: 'completed' })} disabled={bulkUpdateMutation.isPending} className="bg-emerald-500 hover:bg-emerald-400 text-white border-0 gap-1">
            <CheckCircle2 size={14} /> Mark completed
          </Button>
          <Button size="sm" onClick={() => bulkUpdateMutation.mutate({ interview_ids: Array.from(selectedIds), status: 'no_show' })} disabled={bulkUpdateMutation.isPending} className="bg-amber-500 hover:bg-amber-400 text-white border-0 gap-1">
            <AlertTriangle size={14} /> No-show
          </Button>
          <button onClick={clearSelected} className="text-zinc-400 hover:text-white text-sm">Clear</button>
        </div>
      )}

      <FeedbackModal
        open={!!feedbackTarget}
        interview={feedbackTarget}
        onClose={() => setFeedbackTarget(null)}
        onSave={(data) => handleFeedbackSave(feedbackTarget.id, data)}
        loading={updateMutation.isPending}
      />

      <RescheduleModal
        open={!!rescheduleTarget}
        title="Reschedule interview"
        count={1}
        onClose={() => setRescheduleTarget(null)}
        onSave={handleReschedule}
        loading={updateMutation.isPending}
      />

      <RescheduleModal
        open={bulkRescheduleOpen}
        title="Reschedule selected"
        count={selectedIds.size}
        onClose={() => setBulkRescheduleOpen(false)}
        onSave={(dt) => bulkUpdateMutation.mutate({ interview_ids: Array.from(selectedIds), scheduled_datetime: dt })}
        loading={bulkUpdateMutation.isPending}
      />

      <CheckinModal
        open={!!checkinTarget}
        interview={checkinTarget}
        onClose={() => setCheckinTarget(null)}
        onAttended={() => handleCheckin('completed')}
        onNoShow={() => handleCheckin('no_show')}
        onReschedule={() => { const t = checkinTarget; setCheckinTarget(null); setRescheduleTarget(t) }}
        loading={updateMutation.isPending}
      />

      <NotifyConfirmModal
        open={!!confirmNotify?.open}
        count={confirmNotify?.ids?.length || 0}
        onClose={() => setConfirmNotify(null)}
        onConfirm={() => {
          const ids = confirmNotify?.ids || []
          setConfirmNotify(null)
          runNotify(ids)
        }}
      />

      <NotifyProgressModal
        state={notifyState}
        onRetry={(ids) => runNotify(ids)}
        onClose={() => { setNotifyState(null); clearSelected() }}
      />
    </div>
  )
}

function ViewToggle({ view, onChange }) {
  const opt = (key, Icon, label) => (
    <button
      type="button"
      onClick={() => onChange(key)}
      title={label}
      className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium transition ${
        view === key ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-white text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
      }`}
    >
      <Icon size={15} />
    </button>
  )
  return (
    <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      {opt('table', LayoutList, 'Table view')}
      {opt('agenda', CalendarRange, 'Agenda view')}
      {opt('by-project', FolderKanban, 'By-project scoreboard')}
    </div>
  )
}

function CandidateCell({ iv, onCopyPhone }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-xs font-bold shrink-0 ring-2 ring-white dark:ring-zinc-900">
        {iv.candidate_name?.charAt(0)?.toUpperCase() || '?'}
      </div>
      <div className="min-w-0">
        <Link
          to={iv.candidate_id ? `/candidates/${iv.candidate_id}` : '#'}
          className="font-semibold text-zinc-900 dark:text-zinc-50 truncate text-sm hover:text-primary-600 flex items-center gap-1.5"
        >
          {iv.candidate_name}
          {iv.whatsapp_unreachable && (
            <span title="WhatsApp not working — call manually" className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-200 dark:ring-amber-900/60">
              <AlertTriangle size={9} /> No WhatsApp
            </span>
          )}
        </Link>
        {iv.candidate_phone && (
          <button type="button" onClick={() => onCopyPhone?.(iv.candidate_phone)} title="Copy phone" className="text-xs text-zinc-500 dark:text-zinc-400 truncate inline-flex items-center gap-1 hover:text-primary-600">
            <Phone size={10} />{iv.candidate_phone}<Copy size={9} className="opacity-50" />
          </button>
        )}
      </div>
    </div>
  )
}

// Shared per-row action buttons.
function RowActions({ iv, onReminder, onComplete, onReschedule, onCheckin, onCancel }) {
  const active = ['scheduled', 'confirmed'].includes(iv.status)
  return (
    <div className="inline-flex items-center justify-end gap-1">
      {iv.candidate_id && (
        <IconAction title="Open chat" icon={MessageSquare} tone="blue" to={`/communications?candidate=${iv.candidate_id}`} />
      )}
      {active && (
        <>
          <IconAction title="Reschedule" icon={CalendarClock} tone="purple" onClick={() => onReschedule(iv)} />
          <IconAction title="Send reminder" icon={Bell} tone="blue" onClick={() => onReminder(iv.id)} />
          {isCheckinTime(iv)
            ? <IconAction title="Check-in (attended / no-show)" icon={UserCheck} tone="emerald" onClick={() => onCheckin(iv)} />
            : <IconAction title="Complete / Feedback" icon={CheckCircle2} tone="emerald" onClick={() => onComplete(iv)} />}
          <IconAction title="Cancel" icon={XCircle} tone="rose" onClick={() => onCancel(iv.id)} />
        </>
      )}
      {iv.status === 'completed' && !iv.rating && (
        <IconAction title="Add rating/feedback" icon={Star} tone="amber" onClick={() => onComplete(iv)} />
      )}
    </div>
  )
}

function InterviewTable({ interviews, selectedIds, onToggleSelect, onSelectAll, allChecked, onReminder, onComplete, onReschedule, onCheckin, onCancel, onCopyPhone }) {
  return (
    <Table>
      <Table.Head>
        <Table.Tr hover={false}>
          <Table.Th>
            <input type="checkbox" aria-label="Select all" className="w-4 h-4 rounded accent-primary-600 cursor-pointer" checked={allChecked} onChange={(e) => onSelectAll(e.target.checked)} />
          </Table.Th>
          <Table.Th icon={User}>Candidate</Table.Th>
          <Table.Th icon={Briefcase}>Job</Table.Th>
          <Table.Th icon={FolderKanban}>Project</Table.Th>
          <Table.Th icon={User}>Interviewer</Table.Th>
          <Table.Th icon={Clock}>Date &amp; Time</Table.Th>
          <Table.Th icon={MapPin}>Location</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>Rating</Table.Th>
          <Table.Th align="right">Actions</Table.Th>
        </Table.Tr>
      </Table.Head>
      <Table.Body>
        {interviews.map(iv => {
          const overdue = isOverdue(iv)
          const accent = overdue ? 'rose' : (STATUS_META[iv.status]?.tone || 'zinc')
          return (
            <Table.Tr key={iv.id} accent={accent}>
              <Table.Td>
                <input type="checkbox" className="w-4 h-4 rounded accent-primary-600 cursor-pointer" checked={selectedIds.has(iv.id)} onChange={() => onToggleSelect(iv.id)} />
              </Table.Td>
              <Table.Td className="min-w-[200px]"><CandidateCell iv={iv} onCopyPhone={onCopyPhone} /></Table.Td>
              <Table.Td>
                <Link to={`/jobs/${iv.job_id}`} className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium">
                  <Briefcase size={13} /><span className="truncate max-w-[160px]">{iv.job_title}</span>
                </Link>
              </Table.Td>
              <Table.Td>
                {iv.project_title ? (
                  <Link to={`/projects/${iv.project_id}`} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-950/40 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-900/60">
                    <FolderKanban size={10} /><span className="truncate max-w-[140px]">{iv.project_title}</span>
                  </Link>
                ) : <span className="text-zinc-400 text-sm">—</span>}
              </Table.Td>
              <Table.Td>
                <span className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300 text-sm">
                  {iv.interviewer_name
                    ? (<><User size={13} className="text-zinc-400 dark:text-zinc-500" /><span className="truncate max-w-[120px]">{iv.interviewer_name}</span></>)
                    : <span className="text-zinc-400">—</span>}
                </span>
              </Table.Td>
              <Table.Td className="whitespace-nowrap">
                <div className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300 text-sm">
                  <Clock size={13} className="text-zinc-400 dark:text-zinc-500" />
                  {formatDateTime(iv.scheduled_datetime)}
                </div>
                {overdue && (
                  <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-rose-100 dark:bg-rose-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:text-rose-300">Overdue</span>
                )}
              </Table.Td>
              <Table.Td>
                {iv.location ? (
                  <div className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300 text-sm">
                    <MapPin size={13} className="text-zinc-400 dark:text-zinc-500" />{iv.location}
                  </div>
                ) : <span className="text-zinc-400 dark:text-zinc-500 text-sm">TBD</span>}
              </Table.Td>
              <Table.Td>
                <div className="flex flex-col items-start gap-1">
                  <StatusPill status={iv.status} />
                  <ResponseBadge response={iv.candidate_response} />
                  <OutcomeBadge outcome={iv.outcome} />
                </div>
              </Table.Td>
              <Table.Td>
                {iv.rating ? <RatingStars value={iv.rating} /> : <span className="text-zinc-400 dark:text-zinc-500 text-xs">—</span>}
              </Table.Td>
              <Table.Td align="right">
                <RowActions iv={iv} onReminder={onReminder} onComplete={onComplete} onReschedule={onReschedule} onCheckin={onCheckin} onCancel={onCancel} />
              </Table.Td>
            </Table.Tr>
          )
        })}
      </Table.Body>
    </Table>
  )
}

// Rescheduled view: candidates who moved their interview at least once, showing
// the move (from day → to day + venue) and how many times they rescheduled.
function RescheduledTable({ interviews, onCopyPhone }) {
  if (!interviews.length) {
    return <EmptyState icon={CalendarClock} title="No reschedules yet" message="When a candidate taps Reschedule and picks another day, they'll appear here." />
  }
  return (
    <Table>
      <Table.Head>
        <Table.Tr hover={false}>
          <Table.Th icon={User}>Candidate</Table.Th>
          <Table.Th icon={Briefcase}>Job</Table.Th>
          <Table.Th icon={FolderKanban}>Project</Table.Th>
          <Table.Th icon={CalendarClock}>Moved from → to</Table.Th>
          <Table.Th>Times</Table.Th>
          <Table.Th>Status</Table.Th>
        </Table.Tr>
      </Table.Head>
      <Table.Body>
        {interviews.map((iv) => (
          <Table.Tr key={iv.id} accent="purple">
            <Table.Td className="min-w-[200px]"><CandidateCell iv={iv} onCopyPhone={onCopyPhone} /></Table.Td>
            <Table.Td>
              <Link to={`/jobs/${iv.job_id}`} className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium">
                <Briefcase size={13} /><span className="truncate max-w-[160px]">{iv.job_title}</span>
              </Link>
            </Table.Td>
            <Table.Td>
              {iv.project_title ? (
                <Link to={`/projects/${iv.project_id}`} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-950/40 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-900/60">
                  <FolderKanban size={10} /><span className="truncate max-w-[140px]">{iv.project_title}</span>
                </Link>
              ) : <span className="text-zinc-400 text-sm">—</span>}
            </Table.Td>
            <Table.Td className="whitespace-nowrap">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-zinc-400 dark:text-zinc-500 line-through">{iv.rescheduled_from_datetime ? formatDateTime(iv.rescheduled_from_datetime) : '—'}</span>
                <span className="text-zinc-400">→</span>
                <span className="font-medium text-zinc-800 dark:text-zinc-200">{formatDateTime(iv.scheduled_datetime)}</span>
              </div>
              {iv.location && (
                <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                  <MapPin size={11} />{iv.location}
                </div>
              )}
            </Table.Td>
            <Table.Td>
              <span className="inline-flex items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/40 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-200 dark:ring-amber-900/60">
                {iv.reschedule_count || 1}×
              </span>
            </Table.Td>
            <Table.Td><StatusPill status={iv.status} /></Table.Td>
          </Table.Tr>
        ))}
      </Table.Body>
    </Table>
  )
}

// Agenda view: this page's interviews grouped by day.
function AgendaView({ interviews, onReschedule, onCheckin, onComplete, onReminder, onCancel }) {
  const groups = useMemo(() => {
    const map = new Map()
    for (const iv of interviews) {
      const k = dayKey(iv.scheduled_datetime)
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(iv)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [interviews])

  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
      {groups.map(([day, items]) => (
        <div key={day} className="p-4">
          <div className="mb-2 flex items-center gap-2">
            <CalendarDays size={14} className="text-zinc-400" />
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{day}</h3>
            <span className="text-xs text-zinc-400">{items.length}</span>
          </div>
          <div className="space-y-2">
            {items.map((iv) => {
              const overdue = isOverdue(iv)
              return (
                <div key={iv.id} className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${overdue ? 'border-rose-200 dark:border-rose-900/50 bg-rose-50/40 dark:bg-rose-950/10' : 'border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900'}`}>
                  <div className="min-w-0 flex items-center gap-3">
                    <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 tabular-nums whitespace-nowrap">{formatDateTime(iv.scheduled_datetime)}</span>
                    <div className="min-w-0">
                      <Link to={iv.candidate_id ? `/candidates/${iv.candidate_id}` : '#'} className="text-sm font-medium text-zinc-900 dark:text-zinc-50 hover:text-primary-600 truncate block">
                        {iv.candidate_name}
                      </Link>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{iv.job_title}{iv.interviewer_name ? ` · ${iv.interviewer_name}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <ResponseBadge response={iv.candidate_response} />
                    <StatusPill status={iv.status} />
                    <RowActions iv={iv} onReminder={onReminder} onComplete={onComplete} onReschedule={onReschedule} onCheckin={onCheckin} onCancel={onCancel} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// Per-project interview scoreboard (totals-only). Each card shows how many
// candidates were scheduled for interview, and within that how many Confirmed /
// Rescheduled / Can't-make-it / No-answer. Every number drills into the filtered
// table via onDrill(project_id, filterPatch).
const SCORE_CHIPS = [
  { key: 'confirmed',         label: 'Confirmed',           tone: 'emerald', patch: { status: 'confirmed' } },
  { key: 'rescheduled',       label: 'Rescheduled',         tone: 'purple',  patch: { response: 'reschedule' } },
  { key: 'cant_make',         label: "Can't make it",       tone: 'rose',    patch: { response: 'cant_make' } },
  { key: 'no_answer',         label: 'No answer',           tone: 'amber',   patch: { response: 'no_answer' } },
  { key: 'completed',         label: 'Completed',           tone: 'purple',  patch: { status: 'completed' } },
  { key: 'cancelled_no_show', label: 'Cancelled / No-show', tone: 'rose',    patch: { status: 'cancelled' } },
]

function ScoreChip({ label, value, tone, onClick }) {
  const t = STAT_TONES[tone] || STAT_TONES.blue
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between gap-2 rounded-xl ring-1 ring-inset px-2.5 py-1.5 text-left transition hover:brightness-105 ${t.wrap}`}
    >
      <span className={`text-[11px] font-semibold ${t.label}`}>{label}</span>
      <span className={`text-sm font-bold tabular-nums ${t.value}`}>{value ?? 0}</span>
    </button>
  )
}

function InterviewsByProject({ projects, loading, onDrill }) {
  if (loading) {
    return <div className="p-5"><TableSkeleton rows={4} cols={4} /></div>
  }
  if (!projects.length) {
    return (
      <EmptyState
        icon={FolderKanban}
        tone="blue"
        title="No interviews to summarise"
        description="Once interviews are scheduled, each project's confirmed / rescheduled / can't-make breakdown appears here."
      />
    )
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {projects.map((p) => (
        <Card key={p.project_id || 'none'} className="p-4">
          <div className="flex items-start justify-between gap-2 mb-3">
            <button
              type="button"
              onClick={() => onDrill(p.project_id, {})}
              className="inline-flex items-center gap-1.5 font-semibold text-zinc-900 dark:text-zinc-50 hover:text-primary-600 text-left min-w-0"
            >
              <FolderKanban size={14} className="text-indigo-500 shrink-0" />
              <span className="truncate max-w-[200px]">{p.project_title}</span>
            </button>
            <button
              type="button"
              onClick={() => onDrill(p.project_id, {})}
              title="Scheduled for interview — view all"
              className="shrink-0 text-right"
            >
              <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Scheduled</p>
              <p className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 tabular-nums">{p.total ?? 0}</p>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {SCORE_CHIPS.map((c) => (
              <ScoreChip key={c.key} label={c.label} value={p[c.key]} tone={c.tone} onClick={() => onDrill(p.project_id, c.patch)} />
            ))}
          </div>
          {p.not_sent ? (
            <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">{p.not_sent} not yet invited</p>
          ) : null}
        </Card>
      ))}
    </div>
  )
}

const ICON_TONES = {
  blue:    'text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950/40',
  emerald: 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950/40',
  rose:    'text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40',
  amber:   'text-amber-600 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40',
  purple:  'text-purple-600 hover:bg-purple-50 dark:text-purple-300 dark:hover:bg-purple-950/40',
}

function IconAction({ title, icon: Icon, tone = 'blue', onClick, to }) {
  const cls = `inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${ICON_TONES[tone]}`
  if (to) {
    return <Link to={to} title={title} className={cls}><Icon size={15} /></Link>
  }
  return (
    <button type="button" title={title} onClick={onClick} className={cls}>
      <Icon size={15} />
    </button>
  )
}

// Per-project interview details. Saved to projects.interview_config and injected
// into the bulk interview invite + the candidate-driven reschedule day picker.
// SHARED_FIELDS apply to every interview day; the per-day rows (interview_config
// .days[]) carry their own date / venue / time window (e.g. 20 Jun – Colombo,
// 21 Jun – Kurunegala), with optional per-day overrides of the shared text.
const SHARED_FIELDS = [
  { key: 'location', label: 'Default location (used when a day has no venue)', placeholder: 'e.g. Dewan Office, Colombo 03', type: 'text' },
  { key: 'what_to_bring', label: 'What to bring', placeholder: 'e.g. NIC and original certificates', type: 'text' },
  { key: 'dress_code', label: 'Dress code', placeholder: 'e.g. Smart casual', type: 'text' },
  { key: 'date_guidance', label: 'Date guidance', placeholder: 'e.g. Weekdays this month', type: 'text' },
  { key: 'time_guidance', label: 'Time guidance', placeholder: 'e.g. 9:00 AM – 5:00 PM', type: 'text' },
  { key: 'extra_notes', label: 'Extra notes', placeholder: 'Anything else candidates should know', type: 'textarea' },
]
const ADVANCED_FIELDS = [
  { key: 'slot_minutes', label: 'Slot minutes', placeholder: '30' },
  { key: 'per_day_limit', label: 'Interviews / day', placeholder: '8' },
  { key: 'workday_start_hour', label: 'Day start (hour)', placeholder: '9' },
  { key: 'workday_end_hour', label: 'Day end (hour)', placeholder: '17' },
]
const SHARED_KEYS = SHARED_FIELDS.map((f) => f.key)
const ADVANCED_KEYS = ADVANCED_FIELDS.map((f) => f.key)

const newDayId = () => {
  const raw = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `d${Date.now()}${Math.floor(Math.random() * 1e6)}`
  return raw.replace(/-/g, '').slice(0, 16)
}
const emptyInterviewDay = () => ({ id: newDayId(), date: '', location: '', time_start: '09:00', time_end: '17:00', capacity: '', what_to_bring: '', dress_code: '', notes: '' })

function InterviewConfigEditor({ projectId }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [shared, setShared] = useState({})
  const [days, setDays] = useState([])
  const [expanded, setExpanded] = useState(() => new Set())

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  })

  useEffect(() => {
    const cfg = project?.interview_config || {}
    const s = {}
    for (const k of [...SHARED_KEYS, ...ADVANCED_KEYS]) s[k] = cfg[k] ?? ''
    setShared(s)
    setDays(Array.isArray(cfg.days) && cfg.days.length
      ? cfg.days.map((d) => ({ ...emptyInterviewDay(), ...d, capacity: d.capacity ?? '' }))
      : [])
    setExpanded(new Set())
  }, [project?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const saveMut = useMutation({
    mutationFn: () => {
      // Shared fields: coerce the advanced numerics, drop empties for a clean blob.
      const cfg = { ...shared }
      for (const k of ADVANCED_KEYS) cfg[k] = cfg[k] === '' || cfg[k] == null ? undefined : Number(cfg[k])
      for (const k of SHARED_KEYS) if (cfg[k] === '') cfg[k] = undefined
      // Per-day rows: keep only complete days, sorted by date.
      cfg.days = days
        .filter((d) => d.date && (d.location || '').trim())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((d) => ({
          id: d.id || newDayId(),
          date: d.date,
          location: d.location.trim(),
          time_start: d.time_start || '09:00',
          time_end: d.time_end || '17:00',
          capacity: d.capacity === '' || d.capacity == null ? null : Number(d.capacity),
          what_to_bring: (d.what_to_bring || '').trim() || null,
          dress_code: (d.dress_code || '').trim() || null,
          notes: (d.notes || '').trim() || null,
        }))
      return updateProject(projectId, { interview_config: cfg })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      toast.success('Interview details saved')
    },
    onError: (e) => toast.error(e?.response?.data?.error || 'Could not save interview details'),
  })

  const onSave = () => {
    // Block save if a started day is missing date or venue; warn on dup dates.
    const started = days.filter((d) => d.date || (d.location || '').trim())
    if (started.some((d) => !d.date || !(d.location || '').trim())) {
      toast.error('Each interview day needs both a date and a venue')
      return
    }
    const dates = started.map((d) => d.date)
    if (new Set(dates).size !== dates.length) toast('Heads up: two interview days share the same date', { icon: '⚠️' })
    saveMut.mutate()
  }

  const setS = (k, v) => setShared((f) => ({ ...f, [k]: v }))
  const setDay = (i, k, v) => setDays((ds) => ds.map((d, j) => (j === i ? { ...d, [k]: v } : d)))
  const removeDay = (i) => setDays((ds) => ds.filter((_, j) => j !== i))
  const addDay = () => setDays((ds) => [...ds, emptyInterviewDay()])
  const toggleOverrides = (id) => setExpanded((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  return (
    <Card className="mb-6">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="inline-flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-50">
          <CalendarClock size={16} /> Interview details for this project
        </span>
        <span className="text-xs text-zinc-500">{open ? 'Hide' : 'Edit'}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-5">
          {/* Shared details — apply to every interview day unless overridden */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {SHARED_FIELDS.map((f) => (
              <div key={f.key} className={f.type === 'textarea' ? 'sm:col-span-2' : ''}>
                <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">{f.label}</label>
                {f.type === 'textarea' ? (
                  <textarea className="input w-full" rows={2} placeholder={f.placeholder} value={shared[f.key] || ''} onChange={(e) => setS(f.key, e.target.value)} />
                ) : (
                  <input className="input w-full" placeholder={f.placeholder} value={shared[f.key] || ''} onChange={(e) => setS(f.key, e.target.value)} />
                )}
              </div>
            ))}
          </div>

          {/* Interview days — date-specific venue + time (e.g. 20 Jun Colombo, 21 Jun Kurunegala) */}
          <div>
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-2 inline-flex items-center gap-1">
              <CalendarDays size={13} /> Interview days
            </p>
            <div className="space-y-2">
              {days.length === 0 && (
                <p className="text-xs text-zinc-400 dark:text-zinc-500">No specific days yet — add one to offer date-specific interviews and let candidates reschedule between them.</p>
              )}
              {days.map((d, i) => (
                <div key={d.id} className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3 space-y-2">
                  <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
                    <div className="col-span-2 sm:col-span-3">
                      <label className="block text-[11px] text-zinc-500 dark:text-zinc-400 mb-1">Date</label>
                      <input type="date" className="input w-full" value={d.date || ''} onChange={(e) => setDay(i, 'date', e.target.value)} />
                    </div>
                    <div className="col-span-2 sm:col-span-4">
                      <label className="block text-[11px] text-zinc-500 dark:text-zinc-400 mb-1">Venue</label>
                      <input className="input w-full" placeholder="e.g. Dewan Office, Kurunegala" value={d.location || ''} onChange={(e) => setDay(i, 'location', e.target.value)} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] text-zinc-500 dark:text-zinc-400 mb-1">From</label>
                      <input type="time" className="input w-full" value={d.time_start || ''} onChange={(e) => setDay(i, 'time_start', e.target.value)} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] text-zinc-500 dark:text-zinc-400 mb-1">To</label>
                      <input type="time" className="input w-full" value={d.time_end || ''} onChange={(e) => setDay(i, 'time_end', e.target.value)} />
                    </div>
                    <div className="flex justify-end sm:col-span-1">
                      <IconAction title="Remove this day" icon={XCircle} tone="rose" onClick={() => removeDay(i)} />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="w-28">
                      <label className="block text-[11px] text-zinc-500 dark:text-zinc-400 mb-1">Capacity</label>
                      <input type="number" min="0" className="input w-full" placeholder="∞" value={d.capacity ?? ''} onChange={(e) => setDay(i, 'capacity', e.target.value)} />
                    </div>
                    <button type="button" className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline mt-4" onClick={() => toggleOverrides(d.id)}>
                      {expanded.has(d.id) ? 'Hide overrides' : 'Per-day overrides'}
                    </button>
                  </div>
                  {expanded.has(d.id) && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                      <input className="input w-full" placeholder="What to bring (override)" value={d.what_to_bring || ''} onChange={(e) => setDay(i, 'what_to_bring', e.target.value)} />
                      <input className="input w-full" placeholder="Dress code (override)" value={d.dress_code || ''} onChange={(e) => setDay(i, 'dress_code', e.target.value)} />
                      <input className="input w-full" placeholder="Notes (override)" value={d.notes || ''} onChange={(e) => setDay(i, 'notes', e.target.value)} />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="mt-2">
              <Button variant="secondary" size="sm" onClick={addDay} className="gap-1"><CalendarDays size={14} /> Add interview day</Button>
            </div>
          </div>

          {/* Scheduling fallback — only used for projects without specific days */}
          <div>
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Scheduling fallback (used when no specific days are set)</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {ADVANCED_FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="block text-[11px] text-zinc-500 dark:text-zinc-400 mb-1">{f.label}</label>
                  <input type="number" className="input w-full" placeholder={f.placeholder} value={shared[f.key] ?? ''} onChange={(e) => setS(f.key, e.target.value)} />
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={onSave} loading={saveMut.isPending}>Save interview details</Button>
          </div>
        </div>
      )}
    </Card>
  )
}
