import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Check, BadgeCheck, CalendarClock, Languages } from 'lucide-react'
import toast from 'react-hot-toast'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import {
  getProjects, getProjectJobs,
  certifyCandidate, ensureApplication, createInterview,
} from '../../api'

/**
 * Shared stage-action popups used from BOTH the Messages call-log panel and the
 * CV Manager review modal — so an agent can Certify (auto-send the certified
 * message) and Schedule an interview (auto-send the invite) without leaving the
 * conversation. The server is the source of truth: certify cascades the stage +
 * sends via the chatbot; interview resolves an application then POSTs /interviews
 * (which sets the stage and sends the invite). On success we invalidate the
 * shared query keys so the lists/badges reconcile live.
 */

const asArray = (raw) =>
  Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : (raw?.jobs || raw?.projects || [])

// Project → job picker reused by both dialogs.
function ProjectJobSelect({ projId, setProjId, jobId, setJobId, required, jobLabel = 'Role' }) {
  // refetchOnMount:'always' so every dialog open re-checks (cheap) instead of
  // showing a stale/empty cached result; retry covers a transient blip so the
  // dropdown doesn't silently sit empty for the 5-min staleTime window.
  const { data: projectsRaw, isLoading: projectsLoading, isError: projectsError, refetch: refetchProjects } = useQuery({
    queryKey: ['stage-dlg-projects'],
    queryFn: () => getProjects({ limit: 500 }),
    staleTime: 60 * 1000,
    refetchOnMount: 'always',
    retry: 2,
  })
  const projects = useMemo(() => asArray(projectsRaw), [projectsRaw])

  const { data: jobsRaw, isLoading: jobsLoading } = useQuery({
    queryKey: ['stage-dlg-jobs', projId],
    queryFn: () => getProjectJobs(projId),
    enabled: !!projId,
    retry: 2,
  })
  const jobs = useMemo(() => asArray(jobsRaw), [jobsRaw])

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">
          Project{required ? ' *' : ' (optional)'}
        </label>
        <select
          value={projId}
          onChange={(e) => { setProjId(e.target.value); setJobId('') }}
          disabled={projectsLoading}
          className="input w-full text-sm disabled:opacity-50"
        >
          <option value="">
            {projectsLoading ? 'Loading projects…' : projectsError ? 'Could not load projects' : 'Select project…'}
          </option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.title || p.name || 'Untitled project'}</option>)}
        </select>
        {projectsError && (
          <button type="button" onClick={() => refetchProjects()} className="mt-1 text-[11px] text-primary-600 hover:underline">
            Retry loading projects
          </button>
        )}
        {!projectsLoading && !projectsError && projects.length === 0 && (
          <p className="mt-1 text-[11px] text-zinc-400">No projects found.</p>
        )}
      </div>
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">
          {jobLabel}{required ? ' *' : ' (optional)'}
        </label>
        <select
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          disabled={!projId || jobsLoading}
          className="input w-full text-sm disabled:opacity-50"
        >
          <option value="">{!projId ? 'Pick a project first' : jobsLoading ? 'Loading roles…' : 'Select role…'}</option>
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.title || 'Untitled role'}</option>)}
        </select>
      </div>
    </div>
  )
}

// Invalidate every list/badge the stage change can affect so the UI reconciles.
function invalidateStageQueries(queryClient, candidateId) {
  ;['active-chats', 'active-chats-counts', 'applications', 'application-status-totals',
    'interviews', 'engagement'].forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }))
  queryClient.invalidateQueries({ queryKey: ['candidate', candidateId] })
  queryClient.invalidateQueries({ queryKey: ['candidate-detail', candidateId] })
  queryClient.invalidateQueries({ queryKey: ['call-logs', candidateId] })
}

/**
 * Certify + notify. Sets the candidate to `certified` and (unless turned off)
 * sends the WhatsApp certified message. The role is optional — if omitted the
 * server resolves it from the candidate's latest active application.
 */
export function CertifyDialog({ open, onClose, candidateId, candidateName, defaultProjectId = '', defaultJobId = '', onSuccess }) {
  const queryClient = useQueryClient()
  const [notes, setNotes] = useState('')
  const [translate, setTranslate] = useState(false)
  const [sendMessage, setSendMessage] = useState(true)
  const [projId, setProjId] = useState('')
  const [jobId, setJobId] = useState('')

  useEffect(() => {
    if (open) {
      setNotes(''); setTranslate(false); setSendMessage(true)
      setProjId(defaultProjectId || ''); setJobId(defaultJobId || '')
    }
  }, [open, defaultProjectId, defaultJobId])

  const mut = useMutation({
    mutationFn: () => certifyCandidate(candidateId, {
      certification_notes: notes.trim() || undefined,
      translate_notes: translate,
      job_id: jobId || undefined,
      send_message: sendMessage,
    }),
    onSuccess: (res) => {
      invalidateStageQueries(queryClient, candidateId)
      const sent = res?.notification?.success?.some((s) => s.channel === 'whatsapp')
      if (sendMessage) {
        toast.success(sent ? 'Certified — message sent' : 'Certified — message could not be delivered')
      } else {
        toast.success('Certified')
      }
      onSuccess?.(res)
      onClose()
    },
    onError: (err) => toast.error(err?.response?.data?.error || 'Failed to certify'),
  })

  return (
    <Modal open={open} onClose={onClose} title={`Certify${candidateName ? ` — ${candidateName}` : ''}`} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 flex items-start gap-2">
          <BadgeCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" />
          Moves the candidate to <strong className="text-zinc-700 dark:text-zinc-200">Certified</strong> and notifies them on WhatsApp.
        </p>

        <ProjectJobSelect projId={projId} setProjId={setProjId} jobId={jobId} setJobId={setJobId} required={false} jobLabel="Confirm role" />

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">
            Note to candidate (optional)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="e.g. Congratulations — you've cleared screening. Next we'll schedule your interview."
            className="input w-full text-sm resize-none"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input type="checkbox" checked={sendMessage} onChange={(e) => setSendMessage(e.target.checked)} />
            Send WhatsApp message
          </label>
          <label className={`inline-flex items-center gap-2 text-sm ${sendMessage ? 'text-zinc-700 dark:text-zinc-300' : 'text-zinc-400'}`}>
            <input type="checkbox" checked={translate} disabled={!sendMessage} onChange={(e) => setTranslate(e.target.checked)} />
            <Languages size={14} /> Translate the note to their language (extra cost)
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={mut.isPending}>
            {mut.isPending ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} Certify{sendMessage ? ' & notify' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * Schedule interview + auto-send the invite. Resolves an application for the
 * chosen role (idempotent) then POSTs /api/interviews, which sets the stage and
 * sends the localized invite via the chatbot.
 */
export function ScheduleInterviewDialog({ open, onClose, candidateId, candidateName, defaultProjectId = '', defaultJobId = '', onSuccess }) {
  const queryClient = useQueryClient()
  const [projId, setProjId] = useState('')
  const [jobId, setJobId] = useState('')
  const [datetime, setDatetime] = useState('')
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [translate, setTranslate] = useState(false)

  useEffect(() => {
    if (open) {
      setProjId(defaultProjectId || ''); setJobId(defaultJobId || '')
      setDatetime(''); setLocation(''); setNotes(''); setTranslate(false)
    }
  }, [open, defaultProjectId, defaultJobId])

  const mut = useMutation({
    mutationFn: async () => {
      // Resolve (or create) the application this interview attaches to.
      const { application_id } = await ensureApplication(candidateId, { job_id: jobId })
      if (!application_id) throw new Error('Could not resolve an application for this role')
      return createInterview({
        application_id,
        scheduled_datetime: datetime,
        location: location.trim() || undefined,
        description: notes.trim() || undefined,
        translate_notes: translate,
        notify_channels: ['whatsapp'],
      })
    },
    onSuccess: (res) => {
      invalidateStageQueries(queryClient, candidateId)
      const sent = res?.notification?.success?.some?.((s) => s.channel === 'whatsapp')
      toast.success(sent === false ? 'Interview scheduled — invite could not be delivered' : 'Interview scheduled — invite sent')
      onSuccess?.(res)
      onClose()
    },
    onError: (err) => toast.error(err?.response?.data?.error || err?.message || 'Failed to schedule interview'),
  })

  const canSubmit = jobId && datetime && !mut.isPending

  return (
    <Modal open={open} onClose={onClose} title={`Schedule interview${candidateName ? ` — ${candidateName}` : ''}`} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 flex items-start gap-2">
          <CalendarClock size={16} className="mt-0.5 shrink-0 text-indigo-600" />
          Moves the candidate to <strong className="text-zinc-700 dark:text-zinc-200">Interview Scheduled</strong> and sends the invite on WhatsApp.
        </p>

        <ProjectJobSelect projId={projId} setProjId={setProjId} jobId={jobId} setJobId={setJobId} required jobLabel="Role" />

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Date &amp; time *</label>
          <input type="datetime-local" value={datetime} onChange={(e) => setDatetime(e.target.value)} className="input w-full text-sm" />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Location</label>
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Office address / video link / TBD" className="input w-full text-sm" />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Notes to candidate (optional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="e.g. Bring your original documents." className="input w-full text-sm resize-none" />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
          <Languages size={14} /> Translate the notes to their language (extra cost)
        </label>

        <div className="flex justify-end gap-2 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={!canSubmit}>
            {mut.isPending ? <Loader2 size={15} className="animate-spin" /> : <CalendarClock size={15} />} Schedule &amp; send
          </Button>
        </div>
      </div>
    </Modal>
  )
}
