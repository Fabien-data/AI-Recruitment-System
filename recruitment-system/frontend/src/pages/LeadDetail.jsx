import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, Phone, FileText, ExternalLink, UserCheck, Trash2, Flame,
  Send, CalendarPlus, CheckCircle2, MessageSquare,
} from 'lucide-react'
import toast from 'react-hot-toast'
import {
  getLead, updateLead, convertLead,
  deleteLeadDocument, uploadLeadDocument,
  createLeadFollowUp, updateLeadFollowUp,
  getLeadTemplates, sendLeadTemplate,
} from '../api'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Badge } from '../components/ui/Badge'
import { ConfirmModal } from '../components/ui/Modal'
import { ClickToCall } from '../components/ClickToCall'
import { useRole } from '../stores/authStore'

const STAGES = ['new', 'contacted', 'qualified', 'converted', 'lost']

function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function FieldRow({ label, value }) {
  return (
    <div>
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-zinc-900 mt-0.5">{value || <span className="text-zinc-400">—</span>}</p>
    </div>
  )
}

export default function LeadDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { isAdmin } = useRole()
  const [confirmConvert, setConfirmConvert] = useState(false)

  const { data: lead, isLoading } = useQuery({
    queryKey: ['marketing-hub', 'lead', id],
    queryFn: () => getLead(id),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing-hub', 'lead', id] })
    queryClient.invalidateQueries({ queryKey: ['marketing-hub', 'leads'] })
  }

  const updateMutation = useMutation({
    mutationFn: (patch) => updateLead(id, patch),
    onSuccess: () => { toast.success('Updated'); invalidate() },
    onError: (err) => toast.error(err?.response?.data?.error || 'Update failed'),
  })

  const convertMutation = useMutation({
    mutationFn: () => convertLead(id, { create_application: true }),
    onSuccess: (result) => {
      toast.success('Converted to candidate')
      invalidate()
      navigate(`/candidates/${result.candidate_id}`)
    },
    onError: (err) => toast.error(err?.response?.data?.error || 'Convert failed'),
  })

  const deleteDocMutation = useMutation({
    mutationFn: (docId) => deleteLeadDocument(docId),
    onSuccess: () => { toast.success('Document removed'); invalidate() },
    onError: () => toast.error('Failed to remove document'),
  })

  const uploadCvMutation = useMutation({
    mutationFn: (file) => uploadLeadDocument(id, file, 'cv'),
    onSuccess: () => { toast.success('CV uploaded'); invalidate() },
    onError: () => toast.error('Upload failed'),
  })

  if (isLoading) {
    return <div className="p-8 text-sm text-zinc-500">Loading lead…</div>
  }
  if (!lead) {
    return <div className="p-8 text-sm text-zinc-500">Lead not found.</div>
  }

  const cvDoc = (lead.documents || []).find((d) => d.doc_type === 'cv')
  const otherDocs = (lead.documents || []).filter((d) => d.doc_type !== 'cv')

  const canConvert = lead.stage !== 'converted' && !lead.converted_candidate_id

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <Link to="/marketing-hub" className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 mb-4 transition-colors">
        <ArrowLeft size={14} /> Back to leads
      </Link>

      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold text-zinc-900 tracking-tight">{lead.full_name}</h1>
          <div className="flex items-center gap-3 mt-2 text-sm text-zinc-500">
            <span className="inline-flex items-center gap-1.5 font-mono">
              <Phone size={14} /> {lead.phone}
            </span>
            {lead.source_label && (
              <>
                <span className="text-zinc-300">•</span>
                <span>{lead.source_label}</span>
              </>
            )}
            <span className="text-zinc-300">•</span>
            <span>Created {formatDateTime(lead.created_at)}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ClickToCall phone={lead.phone}>Call</ClickToCall>
          {canConvert && (
            <Button variant="primary" onClick={() => setConfirmConvert(true)}>
              <UserCheck size={14} /> Convert to candidate
            </Button>
          )}
          {!canConvert && lead.converted_candidate_id && (
            <Link
              to={`/candidates/${lead.converted_candidate_id}`}
              className="inline-flex items-center gap-1.5 text-sm text-zinc-600 hover:text-zinc-900 underline"
            >
              View linked candidate <ExternalLink size={12} />
            </Link>
          )}
        </div>
      </div>

      {/* Stage selector */}
      <Card className="p-4 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Stage</span>
          <div className="flex flex-wrap gap-1.5">
            {STAGES.map((s) => {
              const active = lead.stage === s
              const currentIdx = STAGES.indexOf(lead.stage)
              const targetIdx = STAGES.indexOf(s)
              const isBackward = targetIdx < currentIdx
              const disabled = (isBackward && !isAdmin) || active
              return (
                <button
                  key={s}
                  type="button"
                  disabled={disabled}
                  onClick={() => updateMutation.mutate({ stage: s })}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold capitalize transition-colors ${
                    active
                      ? 'bg-zinc-900 text-white'
                      : disabled
                        ? 'bg-zinc-50 text-zinc-300 cursor-not-allowed'
                        : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
                  }`}
                  title={isBackward && !isAdmin ? 'Backward transitions are admin-only' : undefined}
                >
                  {s}
                </button>
              )
            })}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Profile */}
        <Card className="p-6 lg:col-span-2">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Profile</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FieldRow label="NIC / Passport" value={lead.nic} />
            <FieldRow label="Country" value={lead.country} />
            <FieldRow label="DOB" value={lead.dob ? new Date(lead.dob).toLocaleDateString() : null} />
            <FieldRow label="Assigned agent" value={lead.assigned_agent_name} />
            <FieldRow
              label="Preferred job"
              value={
                lead.preferred_job_title ? (
                  <span className="inline-flex items-center gap-2">
                    <Link to={`/jobs/${lead.preferred_job_id}`} className="text-zinc-900 hover:underline">
                      {lead.preferred_job_title}
                    </Link>
                    {lead.preferred_job_is_urgent && <Flame size={12} className="text-red-500" />}
                  </span>
                ) : (
                  lead.preferred_job_text
                )
              }
            />
            <FieldRow label="Campaign ref" value={lead.campaign_ref} />
            <div className="md:col-span-2">
              <FieldRow label="Remarks" value={lead.remarks} />
            </div>
          </div>
        </Card>

        {/* Documents */}
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide">Documents</h2>
            {!cvDoc && (
              <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-700 hover:text-zinc-900 cursor-pointer">
                + Upload CV
                <input
                  type="file"
                  className="hidden"
                  accept=".pdf,.doc,.docx,image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) uploadCvMutation.mutate(f)
                    e.target.value = ''
                  }}
                />
              </label>
            )}
          </div>
          {cvDoc && (
            <div className="mb-4">
              <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-1.5">Primary CV</p>
              <DocRow doc={cvDoc} onRemove={() => deleteDocMutation.mutate(cvDoc.id)} />
            </div>
          )}
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1.5">Other</p>
          {otherDocs.length === 0 ? (
            <p className="text-xs text-zinc-400">No documents</p>
          ) : (
            <ul className="space-y-2">
              {otherDocs.map((d) => (
                <li key={d.id}>
                  <DocRow doc={d} onRemove={() => deleteDocMutation.mutate(d.id)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Outreach: follow-ups + send-template */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        <FollowUpsCard leadId={id} followUps={lead.follow_ups || []} onChange={invalidate} />
        <SendTemplateCard leadId={id} />
      </div>

      <ConfirmModal
        open={confirmConvert}
        onClose={() => setConfirmConvert(false)}
        onConfirm={() => {
          setConfirmConvert(false)
          convertMutation.mutate()
        }}
        loading={convertMutation.isPending}
        title="Convert lead to candidate"
        message={
          lead.preferred_job_id
            ? `This will create a candidate record and an application for ${lead.preferred_job_title}.`
            : 'This will create a candidate record. No application will be created because no preferred job is linked.'
        }
      />
    </div>
  )
}

function FollowUpsCard({ leadId, followUps, onChange }) {
  const [dueAt, setDueAt] = useState('')
  const [note, setNote] = useState('')

  const createMutation = useMutation({
    mutationFn: () => createLeadFollowUp(leadId, { due_at: dueAt, note: note || null }),
    onSuccess: () => {
      toast.success('Follow-up scheduled')
      setDueAt('')
      setNote('')
      onChange()
    },
    onError: (err) => toast.error(err?.response?.data?.error || 'Failed to schedule'),
  })

  const completeMutation = useMutation({
    mutationFn: (id) => updateLeadFollowUp(id, { status: 'completed' }),
    onSuccess: () => { toast.success('Marked complete'); onChange() },
    onError: () => toast.error('Failed to update'),
  })

  const pending = followUps.filter((f) => f.status === 'pending')
  const done = followUps.filter((f) => f.status !== 'pending')

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!dueAt) {
      toast.error('Pick a date/time')
      return
    }
    createMutation.mutate()
  }

  return (
    <Card className="p-6">
      <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">
        <CalendarPlus size={14} className="inline mr-1.5 -mt-0.5" />
        Follow-ups
      </h2>

      <form onSubmit={handleSubmit} className="space-y-3 mb-4">
        <input
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 text-sm"
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)…"
          className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 text-sm"
        />
        <Button type="submit" size="sm" loading={createMutation.isPending}>
          Schedule
        </Button>
      </form>

      {pending.length === 0 && done.length === 0 ? (
        <p className="text-xs text-zinc-400">No follow-ups yet.</p>
      ) : (
        <>
          {pending.length > 0 && (
            <ul className="space-y-2 mb-3">
              {pending.map((f) => (
                <li key={f.id} className="flex items-start justify-between gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl">
                  <div className="min-w-0">
                    <p className="text-xs font-mono text-amber-900">{new Date(f.due_at).toLocaleString()}</p>
                    {f.note && <p className="text-xs text-amber-800 mt-0.5">{f.note}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => completeMutation.mutate(f.id)}
                    className="p-1.5 text-amber-700 hover:text-emerald-600 rounded-full hover:bg-white"
                    title="Mark complete"
                  >
                    <CheckCircle2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {done.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-700">
                {done.length} completed
              </summary>
              <ul className="space-y-1 mt-2">
                {done.map((f) => (
                  <li key={f.id} className="px-3 py-1.5 bg-zinc-50 border border-zinc-100 rounded-lg text-zinc-500">
                    <span className="font-mono">{new Date(f.due_at).toLocaleString()}</span>
                    {f.note && <span> — {f.note}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Card>
  )
}

function SendTemplateCard({ leadId }) {
  const [templateKey, setTemplateKey] = useState('')
  const [channel, setChannel] = useState('whatsapp')

  const { data: templates = [] } = useQuery({
    queryKey: ['marketing-hub', 'templates'],
    queryFn: getLeadTemplates,
    staleTime: 5 * 60 * 1000,
  })

  const sendMutation = useMutation({
    mutationFn: () => sendLeadTemplate(leadId, templateKey, channel),
    onSuccess: () => toast.success(`Sent via ${channel}`),
    onError: (err) => toast.error(err?.response?.data?.error || 'Send failed'),
  })

  const selected = templates.find((t) => t.key === templateKey)

  return (
    <Card className="p-6">
      <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">
        <MessageSquare size={14} className="inline mr-1.5 -mt-0.5" />
        Send message
      </h2>

      <div className="space-y-3">
        <select
          value={templateKey}
          onChange={(e) => setTemplateKey(e.target.value)}
          className="w-full px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 text-sm"
        >
          <option value="">Select template…</option>
          {templates.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>

        {selected && (
          <div className="px-3 py-2 bg-zinc-50 border border-zinc-100 rounded-xl">
            <p className="text-xs text-zinc-500 mb-1 font-semibold uppercase tracking-wide">Preview</p>
            <p className="text-xs text-zinc-700 whitespace-pre-line">{selected.preview}</p>
          </div>
        )}

        <div className="inline-flex rounded-xl bg-zinc-100 p-1">
          {['whatsapp', 'sms'].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChannel(c)}
              className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors capitalize ${
                channel === c ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-900'
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        <Button
          size="sm"
          disabled={!templateKey}
          loading={sendMutation.isPending}
          onClick={() => sendMutation.mutate()}
        >
          <Send size={14} /> Send
        </Button>
      </div>
    </Card>
  )
}

function DocRow({ doc, onRemove }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-2xl">
      <a
        href={doc.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 text-sm text-zinc-700 hover:text-zinc-900 truncate"
      >
        <FileText size={14} className="flex-shrink-0" />
        <span className="truncate">{doc.name}</span>
        <ExternalLink size={11} className="flex-shrink-0 opacity-60" />
      </a>
      <button
        type="button"
        onClick={onRemove}
        className="p-1 text-zinc-400 hover:text-red-500 rounded-full hover:bg-zinc-100"
        aria-label="Remove document"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}
