import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, MapPin, AlertCircle, StickyNote } from 'lucide-react'
import toast from 'react-hot-toast'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { updateApplication } from '../../api'
import { APPLICATION_STATUSES, STATUS_LABELS, getStatusLabel, normalizeStatus } from '../../constants/lifecycle'

const STATUS_OPTIONS = APPLICATION_STATUSES.map((value) => ({
  value,
  label: STATUS_LABELS[value] || getStatusLabel(value),
}))

function toLocalDateTimeInputValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function EditApplicationModal({ open, onClose, application }) {
  const queryClient = useQueryClient()

  const [status, setStatus] = useState('screening')
  const [interviewDt, setInterviewDt] = useState('')
  const [interviewLoc, setInterviewLoc] = useState('')
  const [interviewNotes, setInterviewNotes] = useState('')
  const [rejectionReason, setRejectionReason] = useState('')

  useEffect(() => {
    if (!open || !application) return
    setStatus(normalizeStatus(application.status) || 'screening')
    setInterviewDt(toLocalDateTimeInputValue(application.interview_datetime))
    setInterviewLoc(application.interview_location || '')
    setInterviewNotes(application.interview_notes || '')
    setRejectionReason(application.rejection_reason || '')
  }, [open, application])

  const updateMutation = useMutation({
    mutationFn: (payload) => updateApplication(application.id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['interviews'] })
      toast.success('Application updated')
      onClose()
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to update application')
    },
  })

  const isInterviewLike = ['certified', 'interview_scheduled'].includes(status)
  const isRejected = status === 'rejected'

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!application) return
    if (status === 'certified' && !interviewDt) {
      toast.error('Interview date/time is required when certifying')
      return
    }
    const payload = { status }
    // Send the literal wall-clock the recruiter typed (YYYY-MM-DDTHH:mm), NOT a
    // UTC instant. toISOString() shifted it by the browser↔Sri Lanka offset, so the
    // candidate's WhatsApp invite showed the wrong time. `interviewDt` is already a
    // naive datetime-local string — forward it verbatim to match the schedule panels.
    if (interviewDt)   payload.interview_datetime = interviewDt
    if (interviewLoc)  payload.interview_location = interviewLoc
    if (interviewNotes) payload.interview_notes = interviewNotes
    if (rejectionReason) payload.rejection_reason = rejectionReason
    updateMutation.mutate(payload)
  }

  if (!application) return null

  return (
    <Modal open={open} onClose={onClose} title="Edit Application" size="lg">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="rounded-2xl bg-zinc-50 dark:bg-zinc-900/60 ring-1 ring-inset ring-zinc-200 dark:ring-zinc-800 p-3 text-sm">
          <p className="text-zinc-900 dark:text-zinc-50 font-semibold">{application.candidate_name || 'Candidate'}</p>
          <p className="text-zinc-500 dark:text-zinc-400">
            {application.job_title || 'Job'}
            {application.project_title && <> · {application.project_title}</>}
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
            Status
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="input w-full"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {isInterviewLike && (
          <div className="rounded-2xl section-grad-purple ring-1 ring-inset ring-purple-200/60 dark:ring-purple-900/60 p-4 space-y-4">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-purple-100 dark:bg-purple-900/40 p-1.5 text-purple-700 dark:text-purple-300">
                <CalendarClock size={14} aria-hidden />
              </div>
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Interview details</h4>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
                  Date &amp; time
                </label>
                <input
                  type="datetime-local"
                  value={interviewDt}
                  onChange={(e) => setInterviewDt(e.target.value)}
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
                  Location
                </label>
                <div className="relative">
                  <MapPin size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
                  <input
                    type="text"
                    value={interviewLoc}
                    onChange={(e) => setInterviewLoc(e.target.value)}
                    placeholder="Office address, Zoom link, etc."
                    className="input w-full pl-8"
                  />
                </div>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
                Notes
              </label>
              <div className="relative">
                <StickyNote size={14} className="absolute left-3 top-3 text-zinc-400 pointer-events-none" />
                <textarea
                  value={interviewNotes}
                  onChange={(e) => setInterviewNotes(e.target.value)}
                  rows={3}
                  placeholder="Any instructions for the candidate..."
                  className="input w-full pl-8 resize-none"
                />
              </div>
            </div>
          </div>
        )}

        {isRejected && (
          <div className="rounded-2xl section-grad-rose ring-1 ring-inset ring-rose-200/60 dark:ring-rose-900/60 p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="rounded-lg bg-rose-100 dark:bg-rose-900/40 p-1.5 text-rose-700 dark:text-rose-300">
                <AlertCircle size={14} aria-hidden />
              </div>
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Rejection reason</h4>
            </div>
            <textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              rows={3}
              placeholder="Optional context shared in the rejection notification..."
              className="input w-full resize-none"
            />
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={updateMutation.isPending}>
            Save Changes
          </Button>
        </div>
      </form>
    </Modal>
  )
}
