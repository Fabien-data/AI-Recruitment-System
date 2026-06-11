import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Phone, PhoneOff, Loader2, Plus, RotateCcw, Check, X, Briefcase, AlertCircle, BadgeCheck, CalendarClock, Trash2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { clsx } from 'clsx'
import { useAuthStore } from '../../stores/authStore'
import { dispositionClasses, dispositionLabel } from './DispositionSelect'
import { CertifyDialog, ScheduleInterviewDialog } from './StageActionDialogs'
import { InlineCreateRole } from './InlineCreateRole'

/**
 * CallRemarksPanel — the per-candidate call/remark engagement log + quick actions.
 *
 * The four quick actions drive the agent workflow:
 *   Follow-up      → opens a remark, logs a callback task (Engagement "Due work").
 *   No answer      → opens an optional note, logs a 'no_answer' task that surfaces
 *                    in the agent's Engagement "Catch-up" list.
 *   Done → <next>  → smart-advances the candidate one canonical stage. From New it
 *                    opens a Project→Job picker (assigns + logs the role); from
 *                    Screening/Certified it advances directly.
 *   Not interested → reason quick-select + optional remark, marks the lead rejected.
 */
const API_BASE = import.meta.env.VITE_API_URL || ''
async function apiFetch(path, opts = {}) {
  const token = useAuthStore.getState().token
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    ...opts,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status}: ${res.statusText}`)
    err.status = res.status
    err.body = data
    throw err
  }
  return data
}

const OUTCOMES = [
  { value: '', label: 'Outcome…' },
  { value: 'answered', label: 'Answered' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'busy', label: 'Busy' },
  { value: 'callback', label: 'Follow-up' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'not_interested', label: 'Not interested' },
  { value: 'note', label: 'Note only' },
]
const outcomeLabel = (v) => OUTCOMES.find((o) => o.value === v)?.label || v

// Smart "Done → advance" — the next canonical stage from the current one.
const NEXT_STAGE = {
  new: { value: 'screening', label: 'Screening', needsJob: true },
  screening: { value: 'certified', label: 'Certified' },
  certified: { value: 'interview_scheduled', label: 'Interview' },
}
const NOT_INTERESTED_REASONS = ['Not interested', 'Salary too low', 'Wrong location/country', 'Already employed', 'Changed mind', 'Other']

// Action-aware log labels (call_logs.action_type, migration 040) so the timeline
// reads as what the agent DID — "Assigned to job", "Certified", "Interview
// scheduled" — instead of every entry looking like a phone call.
const ACTION_META = {
  call: { label: 'Call', cls: 'text-zinc-700 dark:text-zinc-200' },
  assign: { label: 'Assigned to job', cls: 'text-emerald-700 dark:text-emerald-300' },
  certify: { label: 'Certified', cls: 'text-emerald-700 dark:text-emerald-300' },
  interview: { label: 'Interview scheduled', cls: 'text-indigo-700 dark:text-indigo-300' },
  follow_up: { label: 'Follow-up set', cls: 'text-amber-700 dark:text-amber-300' },
  no_answer: { label: 'No answer', cls: 'text-rose-600 dark:text-rose-300' },
  not_interested: { label: 'Not interested', cls: 'text-zinc-600 dark:text-zinc-300' },
  note: { label: 'Note', cls: 'text-zinc-700 dark:text-zinc-200' },
}
const logHead = (l) => {
  const at = l.action_type
  if (at && at !== 'call' && ACTION_META[at]) return ACTION_META[at]
  return { label: l.outcome ? outcomeLabel(l.outcome) : 'Logged', cls: 'text-zinc-700 dark:text-zinc-200' }
}

export function CallRemarksPanel({ candidateId, candidateStatus, candidateName, defaultProjectId = '', defaultJobId = '', claimedByMe = false, onReleaseClaim, releasePending = false, onRemoved }) {
  const queryClient = useQueryClient()
  // "Reject & remove" is destructive — gate it on candidates:edit (admins pass).
  const authUser = useAuthStore((s) => s.user)
  const authPerms = useAuthStore((s) => s.sectionPermissions) || []
  const canRemove = authUser?.role === 'admin'
    || !!authPerms.find((p) => p.section_key === 'candidates')?.can_edit
  const [outcome, setOutcome] = useState('')
  const [remark, setRemark] = useState('')
  const [open, setOpen] = useState(false)            // detailed "Log call" form
  const [panel, setPanel] = useState(null)           // 'followup'|'no_answer'|'not_interested'|'assign'
  const [panelNote, setPanelNote] = useState('')
  const [reason, setReason] = useState('')
  const [projId, setProjId] = useState('')
  const [jobId, setJobId] = useState('')
  const [actionError, setActionError] = useState(null)
  const [certifyOpen, setCertifyOpen] = useState(false)       // Certified popup
  const [interviewOpen, setInterviewOpen] = useState(false)   // Interview popup
  // After scheduling an interview on a chat the agent CLAIMED, offer to release
  // the claim (the shared-pool claim — NOT the bot-takeover release).
  const [releasePrompt, setReleasePrompt] = useState(false)

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['call-logs', candidateId],
    queryFn: () => apiFetch(`/api/communications/candidate/${candidateId}/call-logs`),
    enabled: !!candidateId,
  })

  const stageKey = String(candidateStatus || 'new').toLowerCase()
  const next = NEXT_STAGE[stageKey] || null

  const { data: projects = [] } = useQuery({
    queryKey: ['cr-projects'],
    queryFn: () => apiFetch('/api/projects?limit=500').then((r) => (Array.isArray(r) ? r : (r?.data || r?.projects || []))),
    enabled: panel === 'assign',
    staleTime: 60 * 1000,
    refetchOnMount: 'always',
    retry: 2,
  })
  const { data: jobs = [] } = useQuery({
    queryKey: ['cr-jobs', projId],
    queryFn: () => apiFetch(`/api/projects/${projId}/jobs`).then((r) => (Array.isArray(r) ? r : (r?.data || r?.jobs || []))),
    enabled: panel === 'assign' && !!projId,
  })

  const closePanels = () => { setPanel(null); setPanelNote(''); setReason(''); setProjId(''); setJobId(''); setActionError(null) }

  const addMut = useMutation({
    mutationFn: (body) => apiFetch(`/api/communications/candidate/${candidateId}/call-logs`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      setOutcome(''); setRemark(''); setOpen(false); closePanels()
      queryClient.invalidateQueries({ queryKey: ['call-logs', candidateId] })
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })       // status / contacted change
      queryClient.invalidateQueries({ queryKey: ['engagement'] })         // stats + due work + catch-up
      queryClient.invalidateQueries({ queryKey: ['candidate', candidateId] })
      queryClient.invalidateQueries({ queryKey: ['candidate-detail', candidateId] })
    },
    onError: (err) => {
      if (err?.status === 422 && err?.body?.code === 'screening_gate') {
        setActionError(err.body.error || 'Upload a CV/resume before moving the candidate to Screening.')
      } else {
        setActionError(err?.message || 'Something went wrong.')
      }
    },
  })

  // ── Quick-action click handlers ─────────────────────────────────────────────
  const togglePanel = (key) => { setActionError(null); setPanel((p) => (p === key ? null : key)) }
  const onDone = () => {
    if (!next || addMut.isPending) return
    setActionError(null)
    // New → Screening assigns a role inline. Screening → Certified and
    // Certified → Interview open the popups so the candidate is auto-notified
    // (a bare status change must never silently skip the message).
    if (next.needsJob) { setPanel((p) => (p === 'assign' ? null : 'assign')) }
    else if (next.value === 'certified') { setCertifyOpen(true) }
    else if (next.value === 'interview_scheduled') { setInterviewOpen(true) }
    else { addMut.mutate({ outcome: 'answered', set_candidate_status: next.value }) }
  }

  const submitFollowup = () => addMut.mutate({
    outcome: 'callback', create_followup: true, task_type: 'callback',
    followup_note: panelNote.trim() || 'Need to follow up', remark: panelNote.trim() || undefined,
  })
  const submitNoAnswer = () => addMut.mutate({
    outcome: 'no_answer', create_followup: true, task_type: 'no_answer',
    followup_note: panelNote.trim() || 'No answer', remark: panelNote.trim() || undefined,
  })
  const submitNotInterested = () => addMut.mutate({
    outcome: 'not_interested', set_candidate_status: 'rejected',
    reason: reason || 'Not interested', remark: panelNote.trim() || undefined,
  })

  // "Reject & remove" — hide the candidate from the system entirely (reversible
  // by an admin). Stronger than "Not interested" (Future Pool, re-engageable).
  const removeMut = useMutation({
    mutationFn: () => apiFetch(`/api/candidates/${candidateId}/remove`, {
      method: 'POST',
      body: JSON.stringify({ reason: (reason || panelNote.trim() || undefined) }),
    }),
    onSuccess: () => {
      closePanels()
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      queryClient.invalidateQueries({ queryKey: ['engagement'] })
      onRemoved?.()
    },
    onError: (err) => setActionError(err?.message || 'Could not remove the candidate.'),
  })
  const submitAssign = () => {
    if (!jobId) return
    addMut.mutate({ outcome: 'answered', set_candidate_status: 'screening', job_id: jobId, remark: panelNote.trim() || undefined })
  }

  const QUICK = [
    { key: 'followup', label: 'Follow-up', icon: RotateCcw, cls: 'border-amber-200 text-amber-700 hover:bg-amber-50', onClick: () => togglePanel('followup'), active: panel === 'followup' },
    { key: 'no_answer', label: 'No answer', icon: PhoneOff, cls: 'border-rose-200 text-rose-700 hover:bg-rose-50', onClick: () => togglePanel('no_answer'), active: panel === 'no_answer' },
    { key: 'done', label: next ? `Done → ${next.label}` : 'Done', icon: Check, cls: 'border-emerald-200 text-emerald-700 hover:bg-emerald-50', onClick: onDone, active: panel === 'assign', disabled: !next },
    { key: 'not_interested', label: 'Not interested', icon: X, cls: 'border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800', onClick: () => togglePanel('not_interested'), active: panel === 'not_interested' },
  ]

  const canSubmit = Boolean(outcome || remark.trim()) && !addMut.isPending
  const submit = (e) => {
    e.preventDefault()
    if (!canSubmit) return
    addMut.mutate({ outcome: outcome || undefined, remark: remark.trim() || undefined })
  }

  return (
    <div className="px-4 pb-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] text-zinc-400 dark:text-zinc-500 uppercase tracking-wide">Call log &amp; remarks</p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-[11px] text-indigo-600 hover:text-indigo-700 inline-flex items-center gap-1"
        >
          <Plus size={12} /> Log call
        </button>
      </div>

      {/* One-tap quick outcomes — Follow-up / No answer / Done / Not interested. */}
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        {QUICK.map((q) => {
          const Icon = q.icon
          return (
            <button
              key={q.key}
              type="button"
              disabled={addMut.isPending || q.disabled}
              onClick={q.onClick}
              className={clsx(
                'inline-flex items-center justify-center gap-1 text-[11px] font-medium px-1.5 py-1.5 rounded-lg border bg-white dark:bg-zinc-900 disabled:opacity-50 transition-colors',
                q.cls,
                q.active && 'ring-2 ring-primary-400'
              )}
              title={q.disabled ? 'No further stage' : `Log "${q.label}"`}
            >
              <Icon size={12} /> {q.label}
            </button>
          )
        })}
      </div>

      {/* Stage actions — open the auto-notify popups directly from any stage. */}
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        <button
          type="button"
          disabled={addMut.isPending}
          onClick={() => { setActionError(null); setCertifyOpen(true) }}
          title="Certify & notify the candidate"
          className={clsx(
            'inline-flex items-center justify-center gap-1 text-[11px] font-medium px-1.5 py-1.5 rounded-lg border bg-white dark:bg-zinc-900 disabled:opacity-50 transition-colors border-emerald-200 text-emerald-700 hover:bg-emerald-50',
            certifyOpen && 'ring-2 ring-primary-400'
          )}
        >
          <BadgeCheck size={12} /> Certify
        </button>
        <button
          type="button"
          disabled={addMut.isPending}
          onClick={() => { setActionError(null); setInterviewOpen(true) }}
          title="Schedule interview & send the invite"
          className={clsx(
            'inline-flex items-center justify-center gap-1 text-[11px] font-medium px-1.5 py-1.5 rounded-lg border bg-white dark:bg-zinc-900 disabled:opacity-50 transition-colors border-indigo-200 text-indigo-700 hover:bg-indigo-50',
            interviewOpen && 'ring-2 ring-primary-400'
          )}
        >
          <CalendarClock size={12} /> Interview
        </button>
      </div>

      {/* Reject & remove — hide the candidate from the system (reversible by an
          admin). Distinct from "Not interested" (Future Pool). candidates:edit only. */}
      {canRemove && (
        <button
          type="button"
          disabled={addMut.isPending || removeMut.isPending}
          onClick={() => togglePanel('remove')}
          title="Reject & remove this candidate from the system"
          className={clsx(
            'w-full inline-flex items-center justify-center gap-1 text-[11px] font-medium px-1.5 py-1.5 rounded-lg border bg-white dark:bg-zinc-900 disabled:opacity-50 transition-colors border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-900/60 dark:text-rose-300 dark:hover:bg-rose-950/30 mb-2',
            panel === 'remove' && 'ring-2 ring-rose-400'
          )}
        >
          <Trash2 size={12} /> Reject &amp; remove
        </button>
      )}

      <CertifyDialog
        open={certifyOpen}
        onClose={() => setCertifyOpen(false)}
        candidateId={candidateId}
        candidateName={candidateName}
        defaultProjectId={defaultProjectId}
        defaultJobId={defaultJobId}
      />
      <ScheduleInterviewDialog
        open={interviewOpen}
        onClose={() => setInterviewOpen(false)}
        candidateId={candidateId}
        candidateName={candidateName}
        defaultProjectId={defaultProjectId}
        defaultJobId={defaultJobId}
        onSuccess={() => { if (claimedByMe) setReleasePrompt(true) }}
      />

      {/* Interview scheduled on a chat I claimed → offer to release the CLAIM
          so the team sees it's wrapped up. Separate from the bot-takeover
          Release button — this only frees the shared-pool claim. */}
      {releasePrompt && claimedByMe && (
        <div className="mb-2 p-2 rounded-lg border border-violet-200 dark:border-violet-900/50 bg-violet-50/70 dark:bg-violet-950/20">
          <p className="text-[11px] text-violet-800 dark:text-violet-300 mb-1.5 flex items-start gap-1.5">
            <CalendarClock size={13} className="mt-0.5 shrink-0" />
            <span>Interview scheduled. Release your <strong>claim</strong> on this chat so the team sees it&apos;s wrapped up?</span>
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setReleasePrompt(false)}
              className="text-[11px] text-zinc-500 hover:text-zinc-700"
            >
              Keep it
            </button>
            <button
              type="button"
              disabled={releasePending}
              onClick={() => { onReleaseClaim?.(); setReleasePrompt(false) }}
              className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-60"
            >
              {releasePending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Release claim
            </button>
          </div>
        </div>
      )}

      {actionError && (
        <div className="mb-2 flex items-start gap-1.5 text-[11px] text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/50 rounded-lg px-2 py-1.5">
          <AlertCircle size={13} className="mt-0.5 shrink-0" /> <span>{actionError}</span>
        </div>
      )}

      {/* Follow-up / No answer — capture a short remark before logging. */}
      {(panel === 'followup' || panel === 'no_answer') && (
        <div className="mb-3 space-y-2 p-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
          <textarea
            value={panelNote}
            onChange={(e) => setPanelNote(e.target.value)}
            rows={2}
            autoFocus
            placeholder={panel === 'followup' ? 'Why follow up? (e.g. busy, call back this evening)' : 'Optional note (no answer)…'}
            className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400 resize-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={closePanels} className="text-[11px] text-zinc-500 hover:text-zinc-700">Cancel</button>
            <button
              type="button"
              disabled={addMut.isPending}
              onClick={panel === 'followup' ? submitFollowup : submitNoAnswer}
              className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {addMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save {panel === 'followup' ? 'follow-up' : 'no-answer'}
            </button>
          </div>
        </div>
      )}

      {/* Not interested — structured reason + optional remark. */}
      {panel === 'not_interested' && (
        <div className="mb-3 space-y-2 p-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
          <div className="flex flex-wrap gap-1">
            {NOT_INTERESTED_REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReason(r)}
                className={clsx(
                  'text-[10px] px-1.5 py-1 rounded-full border transition-colors',
                  reason === r ? 'bg-rose-600 text-white border-rose-600' : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50'
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <textarea
            value={panelNote}
            onChange={(e) => setPanelNote(e.target.value)}
            rows={2}
            placeholder="Optional detail (what the candidate said)…"
            className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400 resize-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={closePanels} className="text-[11px] text-zinc-500 hover:text-zinc-700">Cancel</button>
            <button
              type="button"
              disabled={addMut.isPending}
              onClick={submitNotInterested}
              className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
            >
              {addMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} Mark not interested
            </button>
          </div>
        </div>
      )}

      {/* Reject & remove — confirm + optional reason. Hides the candidate from
          every list (reversible by an admin). */}
      {panel === 'remove' && (
        <div className="mb-3 space-y-2 p-2 rounded-lg border border-rose-200 dark:border-rose-900/50 bg-rose-50/60 dark:bg-rose-950/20">
          <p className="text-[11px] text-rose-800 dark:text-rose-300 flex items-start gap-1.5">
            <Trash2 size={13} className="mt-0.5 shrink-0" />
            <span>Remove <strong>{candidateName || 'this candidate'}</strong> from the system? They&apos;ll disappear from all lists and their applications are rejected. An admin can restore them later.</span>
          </p>
          <input
            type="text"
            value={panelNote}
            onChange={(e) => setPanelNote(e.target.value)}
            placeholder="Reason (optional)…"
            className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-400"
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={closePanels} className="text-[11px] text-zinc-500 hover:text-zinc-700">Cancel</button>
            <button
              type="button"
              disabled={removeMut.isPending}
              onClick={() => removeMut.mutate()}
              className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60"
            >
              {removeMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Remove from system
            </button>
          </div>
        </div>
      )}

      {/* Done → Screening — assign the candidate to a project + job, then advance. */}
      {panel === 'assign' && (
        <div className="mb-3 space-y-2 p-2 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/20">
          <p className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300 flex items-center gap-1">
            <Briefcase size={12} /> Assign to a role, then move to Screening
          </p>
          <select
            value={projId}
            onChange={(e) => { setProjId(e.target.value); setJobId('') }}
            className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
          >
            <option value="">Select project…</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.title || p.name || 'Untitled project'}</option>)}
          </select>
          <select
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            disabled={!projId}
            className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400 disabled:opacity-50"
          >
            <option value="">{projId ? 'Select role…' : 'Pick a project first'}</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.title || 'Untitled role'}</option>)}
          </select>
          {/* Future project / manual role: creating one assigns + screens immediately. */}
          <InlineCreateRole
            defaultProjectId={projId}
            onCreated={(job) => addMut.mutate({ outcome: 'answered', set_candidate_status: 'screening', job_id: job.id, remark: panelNote.trim() || undefined })}
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={closePanels} className="text-[11px] text-zinc-500 hover:text-zinc-700">Cancel</button>
            <button
              type="button"
              disabled={addMut.isPending || !jobId}
              onClick={submitAssign}
              className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {addMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Assign &amp; screen
            </button>
          </div>
        </div>
      )}

      {open && (
        <form onSubmit={submit} className="mb-3 space-y-2 p-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/40">
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
          >
            {OUTCOMES.map((o) => <option key={o.value || 'none'} value={o.value}>{o.label}</option>)}
          </select>
          <textarea
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            rows={2}
            placeholder="Remark (what the candidate said, next step…)"
            className="w-full px-2 py-1.5 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-400 resize-none"
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-zinc-500 hover:text-zinc-700">Cancel</button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {addMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Phone size={12} />} Save
            </button>
          </div>
        </form>
      )}

      {isLoading ? (
        <p className="text-[11px] text-zinc-400">Loading…</p>
      ) : logs.length === 0 ? (
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">No activity yet.</p>
      ) : (
        <ul className="space-y-2">
          {logs.map((l) => {
            const head = logHead(l)
            const showAssignedTo = l.job_title && (l.action_type === 'assign' || (!l.action_type && l.job_title))
            return (
            <li key={l.id} className="text-xs border-l-2 border-zinc-200 dark:border-zinc-700 pl-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className={clsx('font-semibold', head.cls)}>{head.label}</span>
                {l.disposition && <span className={clsx('px-1.5 py-0.5 rounded-full text-[10px] font-semibold', dispositionClasses(l.disposition))}>{dispositionLabel(l.disposition)}</span>}
                {l.reason && <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-rose-100 text-rose-700">{l.reason}</span>}
                {l.duration_seconds ? <span className="text-[10px] text-zinc-400">{Math.round(l.duration_seconds / 60)}m</span> : null}
              </div>
              {showAssignedTo && (
                <p className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5 flex items-center gap-1">
                  <Briefcase size={11} /> {l.job_title}{l.project_title ? ` · ${l.project_title}` : ''}
                </p>
              )}
              {l.remark && <p className="text-zinc-600 dark:text-zinc-300 mt-0.5 break-words">{l.remark}</p>}
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                {l.agent_name || 'Agent'} · {l.called_at ? formatDistanceToNow(new Date(l.called_at), { addSuffix: true }) : ''}
              </p>
            </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
