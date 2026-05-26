import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Upload, X, Phone, CalendarDays, Globe, FileText } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  createLead, uploadLeadDocument,
  getMarketingCountries, getLeadSources,
} from '../api'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { Input } from '../components/ui/Input'
import { JobAutocomplete } from '../components/JobAutocomplete'

const DRAFT_KEY = 'marketing-hub-intake-draft'

function loadDraft() {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveDraft(state) {
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(state))
  } catch { /* quota exceeded — ignore */ }
}

function calcAge(dob) {
  if (!dob) return null
  const d = new Date(dob)
  if (Number.isNaN(d.getTime())) return null
  const diffMs = Date.now() - d.getTime()
  const ageDt = new Date(diffMs)
  const age = Math.abs(ageDt.getUTCFullYear() - 1970)
  return age > 0 && age < 120 ? age : null
}

export default function LeadIntake() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const draft = useMemo(() => loadDraft(), [])

  const [form, setForm] = useState(() => draft || {
    full_name: '',
    phone: '',
    nic: '',
    dob: '',
    country: '',
    preferred_job_id: null,
    preferred_job_title: '',
    preferred_job_text: '',
    remarks: '',
    source_id: '',
    campaign_ref: '',
  })
  const [cvFile, setCvFile] = useState(null)
  const [extraFiles, setExtraFiles] = useState([])
  const [duplicateInfo, setDuplicateInfo] = useState(null)

  const { data: countries = [] } = useQuery({
    queryKey: ['marketing-hub', 'countries'],
    queryFn: getMarketingCountries,
    staleTime: 5 * 60 * 1000,
  })
  const { data: sources = [] } = useQuery({
    queryKey: ['marketing-hub', 'sources'],
    queryFn: getLeadSources,
    staleTime: 5 * 60 * 1000,
  })

  const computedAge = calcAge(form.dob)

  const setField = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      saveDraft(next)
      return next
    })
  }

  const handleJobChange = ({ id, title, free_text }) => {
    setForm((prev) => {
      const next = {
        ...prev,
        preferred_job_id: id,
        preferred_job_title: title,
        preferred_job_text: free_text,
      }
      saveDraft(next)
      return next
    })
  }

  const submitMutation = useMutation({
    mutationFn: async ({ allowDuplicate }) => {
      const payload = {
        full_name: form.full_name.trim(),
        phone: form.phone.trim(),
        nic: form.nic.trim() || null,
        dob: form.dob || null,
        country: form.country || null,
        preferred_job_id: form.preferred_job_id || null,
        preferred_job_text: form.preferred_job_text || null,
        remarks: form.remarks.trim() || null,
        source_id: form.source_id || null,
        campaign_ref: form.campaign_ref.trim() || null,
        allow_duplicate: allowDuplicate,
      }
      const lead = await createLead(payload)

      // Upload attached files after the lead row exists.
      const uploads = []
      if (cvFile) uploads.push(uploadLeadDocument(lead.id, cvFile, 'cv'))
      for (const f of extraFiles) {
        uploads.push(uploadLeadDocument(lead.id, f, 'other'))
      }
      if (uploads.length) {
        await Promise.all(uploads)
      }
      return lead
    },
    onSuccess: (lead) => {
      toast.success('Lead saved')
      window.localStorage.removeItem(DRAFT_KEY)
      queryClient.invalidateQueries({ queryKey: ['marketing-hub', 'leads'] })
      navigate(`/marketing-hub/${lead.id}`)
    },
    onError: (err) => {
      const data = err?.response?.data
      if (data?.error === 'duplicate_lead' || data?.error === 'duplicate_candidate') {
        setDuplicateInfo(data)
        return
      }
      toast.error(data?.error || 'Failed to save lead')
    },
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!form.full_name.trim() || !form.phone.trim()) {
      toast.error('Full name and phone are required')
      return
    }
    setDuplicateInfo(null)
    submitMutation.mutate({ allowDuplicate: false })
  }

  const onPickCv = (e) => {
    const f = e.target.files?.[0]
    if (f) setCvFile(f)
    e.target.value = ''
  }
  const onPickExtra = (e) => {
    const files = Array.from(e.target.files || [])
    if (files.length) setExtraFiles((prev) => [...prev, ...files])
    e.target.value = ''
  }
  const removeExtra = (idx) => {
    setExtraFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <Link
        to="/marketing-hub"
        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 mb-4 transition-colors"
      >
        <ArrowLeft size={14} /> Back to leads
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl lg:text-3xl font-bold text-zinc-900 tracking-tight">New Lead</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Capture caller details while you stay on the call. Draft is autosaved.
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="p-6">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Contact</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Full name *"
              value={form.full_name}
              onChange={(e) => setField('full_name', e.target.value)}
              autoFocus
              required
            />
            <Input
              label="Phone *"
              value={form.phone}
              onChange={(e) => setField('phone', e.target.value)}
              placeholder="+94 77 123 4567"
              required
            />
            <Input
              label="NIC / Passport"
              value={form.nic}
              onChange={(e) => setField('nic', e.target.value)}
            />
            <div>
              <Input
                type="date"
                label="Date of birth"
                value={form.dob}
                onChange={(e) => setField('dob', e.target.value)}
              />
              {computedAge !== null && (
                <p className="mt-1 ml-1 text-xs text-zinc-500">Age: {computedAge} years</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">Country</label>
              <select
                value={form.country}
                onChange={(e) => setField('country', e.target.value)}
                className="w-full px-4 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all"
              >
                <option value="">Select country…</option>
                {countries.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Job preference</h2>
          <JobAutocomplete
            value={form.preferred_job_id ? { id: form.preferred_job_id, title: form.preferred_job_title } : null}
            freeText={form.preferred_job_text}
            onChange={handleJobChange}
          />
        </Card>

        <Card className="p-6">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Source & remarks</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">Source</label>
              <select
                value={form.source_id}
                onChange={(e) => setField('source_id', e.target.value)}
                className="w-full px-4 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all"
              >
                <option value="">Select source…</option>
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>
            <Input
              label="Campaign reference"
              value={form.campaign_ref}
              onChange={(e) => setField('campaign_ref', e.target.value)}
              placeholder="e.g. fb-spring-2026"
            />
            <div className="md:col-span-2">
              <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">Remarks</label>
              <textarea
                rows={3}
                value={form.remarks}
                onChange={(e) => setField('remarks', e.target.value)}
                className="w-full px-4 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all"
                placeholder="Anything you learned on the call…"
              />
            </div>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-sm font-bold text-zinc-900 uppercase tracking-wide mb-4">Documents</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">CV / Resume</label>
              {cvFile ? (
                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-2xl">
                  <span className="flex items-center gap-2 text-sm text-zinc-700 truncate">
                    <FileText size={14} /> {cvFile.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => setCvFile(null)}
                    className="p-1 text-zinc-400 hover:text-red-500 rounded-full hover:bg-zinc-100"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 px-3 py-3 border-2 border-dashed border-zinc-200 rounded-2xl text-sm text-zinc-500 hover:border-zinc-400 hover:bg-zinc-50 cursor-pointer transition-colors">
                  <Upload size={16} />
                  <span>Upload CV (PDF / DOC / Image)</span>
                  <input
                    type="file"
                    className="hidden"
                    accept=".pdf,.doc,.docx,image/*"
                    onChange={onPickCv}
                  />
                </label>
              )}
            </div>
            <div>
              <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">Other documents</label>
              <label className="flex items-center justify-center gap-2 px-3 py-3 border-2 border-dashed border-zinc-200 rounded-2xl text-sm text-zinc-500 hover:border-zinc-400 hover:bg-zinc-50 cursor-pointer transition-colors">
                <Upload size={16} />
                <span>NIC copy, passport, photos…</span>
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={onPickExtra}
                />
              </label>
              {extraFiles.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {extraFiles.map((f, idx) => (
                    <li key={`${f.name}-${idx}`} className="flex items-center justify-between gap-2 px-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-xl text-xs">
                      <span className="truncate">{f.name}</span>
                      <button type="button" onClick={() => removeExtra(idx)} className="text-zinc-400 hover:text-red-500">
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        {duplicateInfo && (
          <Card className="p-4 border-orange-200 bg-orange-50">
            <p className="text-sm font-semibold text-orange-900">
              Possible duplicate detected ({duplicateInfo.error === 'duplicate_lead' ? 'existing lead' : 'existing candidate'}).
            </p>
            <p className="text-xs text-orange-800 mt-1">
              {duplicateInfo.existing?.full_name || duplicateInfo.existing?.name} —
              {' '}{duplicateInfo.existing?.phone || '—'}
            </p>
            <div className="flex gap-2 mt-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDuplicateInfo(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={submitMutation.isPending}
                onClick={() => submitMutation.mutate({ allowDuplicate: true })}
              >
                Save anyway
              </Button>
            </div>
          </Card>
        )}

        <div className="flex justify-end gap-2 sticky bottom-0 bg-gradient-to-t from-white via-white/95 pt-4 pb-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              window.localStorage.removeItem(DRAFT_KEY)
              navigate('/marketing-hub')
            }}
          >
            Cancel
          </Button>
          <Button type="submit" loading={submitMutation.isPending}>
            Save lead
          </Button>
        </div>
      </form>
    </div>
  )
}
