import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Calendar, CalendarDays, Clock, MapPin, Briefcase, User, Phone,
  CheckCircle2, XCircle, Bell, Star, BarChart3, CalendarCheck, Hourglass, Filter,
  Send, FolderKanban, Download, AlertTriangle,
} from 'lucide-react'
import {
  getInterviews, updateInterview, deleteInterview, sendInterviewReminder, getProjects, apiClient,
  downloadUnreachableCsv,
} from '../api'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Table } from '../components/ui/Table'
import { EmptyState } from '../components/ui/EmptyState'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Modal } from '../components/ui/Modal'
import { showNotificationToast, showErrorToast } from '../utils/notificationToast'
import { formatInterviewDateTime } from '../utils/datetime'
import toast from 'react-hot-toast'

// Download the "couldn't reach on WhatsApp" call list as a CSV and save it.
async function downloadCallListCsv(projectId) {
  try {
    const blob = await downloadUnreachableCsv({ project_id: projectId || undefined })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `unreachable-candidates-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.URL.revokeObjectURL(url)
  } catch (err) {
    showErrorToast(err, 'Could not download the call list')
  }
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

// Interview times are a literal Asia/Colombo wall-clock — render them without a
// browser-timezone shift so the dashboard matches the candidate's WhatsApp invite.
function formatDateTime(dt) {
  return formatInterviewDateTime(dt)
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

const STAT_TONES = {
  blue:    { wrap: 'section-grad-blue ring-blue-200/60 dark:ring-blue-900/60',       label: 'text-blue-700 dark:text-blue-300',       value: 'text-blue-900 dark:text-blue-100',       icon: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200' },
  emerald: { wrap: 'section-grad-emerald ring-emerald-200/60 dark:ring-emerald-900/60', label: 'text-emerald-700 dark:text-emerald-300', value: 'text-emerald-900 dark:text-emerald-100', icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200' },
  purple:  { wrap: 'section-grad-purple ring-purple-200/60 dark:ring-purple-900/60',   label: 'text-purple-700 dark:text-purple-300',   value: 'text-purple-900 dark:text-purple-100',   icon: 'bg-purple-100 text-purple-700 dark:bg-purple-900/60 dark:text-purple-200' },
  amber:   { wrap: 'section-grad-amber ring-amber-200/60 dark:ring-amber-900/60',     label: 'text-amber-700 dark:text-amber-300',     value: 'text-amber-900 dark:text-amber-100',     icon: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200' },
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

function FeedbackModal({ open, interview, onClose, onSave, loading }) {
  const [rating, setRating] = useState(0)
  const [feedback, setFeedback] = useState('')
  const [status, setStatus] = useState('completed')

  useEffect(() => {
    if (open && interview) {
      setRating(interview.rating || 0)
      setFeedback(interview.feedback || '')
      setStatus(interview.status || 'completed')
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

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Outcome</label>
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="input w-full"
          >
            <option value="completed">Completed</option>
            <option value="no_show">No Show</option>
            <option value="cancelled">Cancelled</option>
          </select>
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
          <Button onClick={() => onSave({ status, rating: rating || null, feedback })} loading={loading}>
            Save
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export default function Interviews() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filters, setFilters] = useState({
    status: '',
    date_from: '',
    date_to: '',
    project_id: searchParams.get('project_id') || '',
  })
  const [feedbackTarget, setFeedbackTarget] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())

  const { data: interviews = [], isLoading } = useQuery({
    queryKey: ['interviews', filters],
    queryFn: () => getInterviews(filters)
  })

  // Project list for the project tabs at the top. Inactive projects show up
  // too — recruiters sometimes want to see legacy interviews.
  const { data: projectsData } = useQuery({
    queryKey: ['projects', 'interviews-filter'],
    queryFn: () => getProjects({ limit: 200 }),
    staleTime: 60_000,
  })
  const projects = Array.isArray(projectsData?.data) ? projectsData.data : []

  // Toggle handler — clears selection when project changes so we don't
  // accidentally bulk-notify interviews from a hidden project.
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

  const bulkNotifyMutation = useMutation({
    mutationFn: (ids) => apiClient.post('/api/interviews/bulk-notify', {
      interview_ids: ids,
    }).then(r => r.data),
    onSuccess: (result) => {
      const sent = result?.successes?.length || 0
      const failed = result?.failures?.length || 0
      if (failed > 0) {
        showNotificationToast(
          { success: result.successes || [], failed: result.failures || [] },
          `Notified ${sent} candidate(s)`
        )
      } else {
        showNotificationToast(null, `Notified ${sent} candidate(s)`)
      }
      // Surface candidates we couldn't reach on WhatsApp → downloadable call list.
      const unreachable = (result?.failures || []).filter(
        (f) => (f.errors || []).some((e) => e?.reason === 'no_whatsapp')
      ).length
      if (unreachable > 0) {
        showCallListToast(unreachable, filters.project_id)
      }
      queryClient.invalidateQueries({ queryKey: ['interviews'] })
      clearSelected()
    },
    onError: (err) => showErrorToast(err, 'Bulk notify failed'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateInterview(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interviews'] })
  })

  const cancelMutation = useMutation({
    mutationFn: (id) => deleteInterview(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interviews'] })
  })

  const reminderMutation = useMutation({
    mutationFn: (id) => sendInterviewReminder(id, {}),
    onSuccess: (result) => {
      showNotificationToast(result?.notification, 'Reminder sent')
    },
    onError: (err) => showErrorToast(err, 'Reminder failed'),
  })

  const handleFeedbackSave = (id, data) => {
    updateMutation.mutate({ id, data })
    setFeedbackTarget(null)
  }

  const stats = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000)
    const startOfWeek = new Date(startOfToday)
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay())
    const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000)

    let today = 0, week = 0, completed = 0, cancelled = 0
    for (const iv of interviews) {
      const dt = iv.scheduled_datetime ? new Date(iv.scheduled_datetime) : null
      if (dt && dt >= startOfToday && dt < endOfToday) today++
      if (dt && dt >= startOfWeek && dt < endOfWeek) week++
      if (iv.status === 'completed') completed++
      if (iv.status === 'cancelled' || iv.status === 'no_show') cancelled++
    }
    return { today, week, completed, cancelled }
  }, [interviews])

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <PageHeader
        icon={CalendarDays}
        tone="blue"
        title="Interview Management"
        subtitle="Schedule, track, and complete candidate interviews"
        actions={
          <Button
            variant="secondary"
            onClick={() => downloadCallListCsv(filters.project_id)}
            title="Download the list of candidates we couldn't reach on WhatsApp, to call manually"
          >
            <Download size={16} />
            Call list (no WhatsApp)
          </Button>
        }
      />

      {/* Project tabs — group all interviews by project */}
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

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard tone="blue"    icon={CalendarCheck} label="Today"     value={stats.today} />
        <StatCard tone="purple"  icon={CalendarDays}  label="This Week" value={stats.week} />
        <StatCard tone="emerald" icon={BarChart3}     label="Completed" value={stats.completed} />
        <StatCard tone="amber"   icon={Hourglass}     label="Cancelled / No-show" value={stats.cancelled} />
      </div>

      {/* Filters */}
      <Card className="p-4 mb-6">
        <div className="flex items-center gap-2 mb-3 text-zinc-800 dark:text-zinc-200">
          <Filter size={16} aria-hidden />
          <h2 className="text-sm font-semibold">Filters</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">Status</label>
            <select
              value={filters.status}
              onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}
              className="input w-full"
            >
              <option value="">All statuses</option>
              {Object.entries(STATUS_META).map(([value, meta]) => (
                <option key={value} value={value}>{meta.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">From</label>
            <div className="relative">
              <CalendarDays size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                type="date"
                value={filters.date_from}
                onChange={e => setFilters(f => ({ ...f, date_from: e.target.value }))}
                className="input w-full pl-8"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">To</label>
            <div className="relative">
              <CalendarDays size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden />
              <input
                type="date"
                value={filters.date_to}
                onChange={e => setFilters(f => ({ ...f, date_to: e.target.value }))}
                className="input w-full pl-8"
              />
            </div>
          </div>
          <div className="flex items-end">
            <Button variant="secondary" size="sm" onClick={() => setFilters({ status: '', date_from: '', date_to: '' })}>
              Clear
            </Button>
          </div>
        </div>
      </Card>

      {/* Interview list */}
      <Card className="overflow-hidden p-0">
        {isLoading ? (
          <div className="p-5"><TableSkeleton rows={6} cols={7} /></div>
        ) : interviews.length === 0 ? (
          <EmptyState
            icon={Calendar}
            tone="blue"
            title="No interviews found"
            description="Schedule an interview by certifying an application — it will appear here."
          />
        ) : (
          <>
          <div className="px-4 py-2 border-b border-zinc-100 dark:border-zinc-800/60 flex items-center justify-between text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : `${interviews.length} interview${interviews.length === 1 ? '' : 's'}`}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={selectedIds.size === interviews.length ? clearSelected : selectAllVisible}
                className="text-xs font-medium text-primary-600 hover:text-primary-700"
              >
                {selectedIds.size === interviews.length && interviews.length > 0 ? 'Clear selection' : 'Select all visible'}
              </button>
            </div>
          </div>
          <Table>
            <Table.Head>
              <Table.Tr hover={false}>
                <Table.Th>
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    className="w-4 h-4 rounded accent-primary-600 cursor-pointer"
                    checked={interviews.length > 0 && selectedIds.size === interviews.length}
                    onChange={(e) => e.target.checked ? selectAllVisible() : clearSelected()}
                  />
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
                const accent = STATUS_META[iv.status]?.tone || 'zinc'
                const isSelected = selectedIds.has(iv.id)
                return (
                  <Table.Tr key={iv.id} accent={accent}>
                    <Table.Td>
                      <input
                        type="checkbox"
                        className="w-4 h-4 rounded accent-primary-600 cursor-pointer"
                        checked={isSelected}
                        onChange={() => toggleSelected(iv.id)}
                      />
                    </Table.Td>
                    <Table.Td className="min-w-[200px]">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-xs font-bold shrink-0 ring-2 ring-white dark:ring-zinc-900">
                          {iv.candidate_name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold text-zinc-900 dark:text-zinc-50 truncate text-sm flex items-center gap-1.5">
                            {iv.candidate_name}
                            {iv.whatsapp_unreachable && (
                              <span
                                title="WhatsApp number not working — call this candidate manually"
                                className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 ring-1 ring-inset ring-amber-200 dark:ring-amber-900/60"
                              >
                                <AlertTriangle size={9} /> No WhatsApp
                              </span>
                            )}
                          </p>
                          {iv.candidate_phone && (
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate inline-flex items-center gap-1">
                              <Phone size={10} />{iv.candidate_phone}
                            </p>
                          )}
                        </div>
                      </div>
                    </Table.Td>
                    <Table.Td>
                      <Link to={`/jobs/${iv.job_id}`} className="inline-flex items-center gap-1.5 text-sm text-primary-600 hover:text-primary-700 dark:text-primary-400 font-medium">
                        <Briefcase size={13} />
                        <span className="truncate max-w-[160px]">{iv.job_title}</span>
                      </Link>
                    </Table.Td>
                    <Table.Td>
                      {iv.project_title ? (
                        <Link to={`/projects/${iv.project_id}`} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 dark:bg-indigo-950/40 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:text-indigo-300 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-900/60">
                          <FolderKanban size={10} />
                          <span className="truncate max-w-[140px]">{iv.project_title}</span>
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
                    </Table.Td>
                    <Table.Td>
                      {iv.location ? (
                        <div className="inline-flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300 text-sm">
                          <MapPin size={13} className="text-zinc-400 dark:text-zinc-500" />
                          {iv.location}
                        </div>
                      ) : <span className="text-zinc-400 dark:text-zinc-500 text-sm">TBD</span>}
                    </Table.Td>
                    <Table.Td><StatusPill status={iv.status} /></Table.Td>
                    <Table.Td>
                      {iv.rating ? <RatingStars value={iv.rating} /> : <span className="text-zinc-400 dark:text-zinc-500 text-xs">—</span>}
                    </Table.Td>
                    <Table.Td align="right">
                      <div className="inline-flex items-center justify-end gap-1">
                        {['scheduled', 'confirmed'].includes(iv.status) && (
                          <>
                            <IconAction
                              title="Send reminder"
                              icon={Bell}
                              tone="blue"
                              onClick={() => reminderMutation.mutate(iv.id)}
                            />
                            <IconAction
                              title="Complete / Feedback"
                              icon={CheckCircle2}
                              tone="emerald"
                              onClick={() => setFeedbackTarget(iv)}
                            />
                            <IconAction
                              title="Cancel"
                              icon={XCircle}
                              tone="rose"
                              onClick={() => { if (confirm('Cancel this interview?')) cancelMutation.mutate(iv.id) }}
                            />
                          </>
                        )}
                        {iv.status === 'completed' && !iv.rating && (
                          <IconAction
                            title="Add rating/feedback"
                            icon={Star}
                            tone="amber"
                            onClick={() => setFeedbackTarget(iv)}
                          />
                        )}
                      </div>
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Body>
          </Table>
          </>
        )}
      </Card>

      {/* Floating bulk-action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-900 text-white rounded-2xl shadow-2xl px-6 py-3 flex items-center gap-4">
          <span className="text-sm font-medium">
            {selectedIds.size} interview{selectedIds.size > 1 ? 's' : ''} selected
          </span>
          <Button
            size="sm"
            onClick={() => bulkNotifyMutation.mutate(Array.from(selectedIds))}
            disabled={bulkNotifyMutation.isPending}
            className="bg-blue-500 hover:bg-blue-400 text-white border-0 gap-1"
          >
            <Send size={14} />
            {bulkNotifyMutation.isPending ? 'Notifying…' : 'Send Interview Notification'}
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

function IconAction({ title, icon: Icon, tone = 'blue', onClick }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors ${ICON_TONES[tone]}`}
    >
      <Icon size={15} />
    </button>
  )
}
