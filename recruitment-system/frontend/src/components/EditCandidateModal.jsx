import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Modal } from './ui/Modal'
import { Input } from './ui/Input'
import { Button } from './ui/Button'
import { updateCandidate } from '../api'
import toast from 'react-hot-toast'

const SOURCE_OPTIONS = [
  { value: 'web',        label: 'Web' },
  { value: 'whatsapp',   label: 'WhatsApp' },
  { value: 'messenger',  label: 'Messenger' },
  { value: 'email',      label: 'Email' },
  { value: 'phone',      label: 'Phone' },
  { value: 'walkin',     label: 'Walk-in' },
  { value: 'manual',     label: 'Manual' },
]

// The four canonical candidate stages. candidate.status auto-syncs from the
// furthest application server-side; this dropdown is a manual override.
const STATUS_OPTIONS = [
  { value: 'new',                 label: 'New' },
  { value: 'screening',           label: 'Screening' },
  { value: 'certified',           label: 'Certified' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
]

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'si', label: 'Sinhala' },
  { value: 'ta', label: 'Tamil' },
]

const ENGLISH_OPTIONS = [
  { value: '', label: '—' },
  { value: 'none', label: 'None' },
  { value: 'basic', label: 'Basic' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'fluent', label: 'Fluent' },
  { value: 'native', label: 'Native' },
]

const EMPTY_FORM = {
  name: '',
  phone: '',
  email: '',
  age: '',
  height_cm: '',
  experience_years: '',
  country: '',
  english_proficiency: '',
  licenses: '',
  previous_employer: '',
  highest_qualification: '',
  skills: '',
  tags: '',
  source: 'manual',
  status: 'new',
  preferred_language: 'en',
  notes: '',
}

// Tags/skills may arrive as a JS array (Postgres text[]), a JSON string, or a
// comma-separated string. Normalise to a comma-separated string for editing.
function toCommaList(value) {
  if (!value) return ''
  if (Array.isArray(value)) return value.filter(Boolean).join(', ')
  if (typeof value === 'string') {
    const s = value.trim()
    if (s.startsWith('[')) {
      try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter(Boolean).join(', ') : s } catch { return s }
    }
    return s
  }
  return ''
}

function splitCommaList(value) {
  return String(value || '').split(',').map((t) => t.trim()).filter(Boolean)
}

function parseMeta(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

export function EditCandidateModal({ candidate, open, onClose }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const queryClient = useQueryClient()

  // Reset the form whenever a new candidate is opened
  useEffect(() => {
    if (open && candidate) {
      const meta = parseMeta(candidate.metadata)
      setForm({
        name: candidate.name || '',
        phone: candidate.phone || '',
        email: candidate.email || '',
        age: candidate.age ?? meta.age ?? '',
        height_cm: candidate.height_cm ?? meta.height_cm ?? '',
        experience_years: candidate.experience_years ?? meta.experience_years ?? '',
        country: meta.country ?? meta.destination_country ?? candidate.preferred_country ?? '',
        english_proficiency: meta.english_proficiency ?? meta.english_level ?? '',
        licenses: meta.licenses ?? '',
        previous_employer: meta.previous_employer ?? '',
        highest_qualification: candidate.highest_qualification ?? meta.highest_qualification ?? '',
        skills: toCommaList(candidate.skills),
        tags: toCommaList(candidate.tags),
        source: candidate.source || 'manual',
        status: candidate.status || 'new',
        preferred_language: candidate.preferred_language || 'en',
        notes: candidate.notes || '',
      })
    }
  }, [open, candidate?.id])

  const updateMutation = useMutation({
    mutationFn: (payload) => updateCandidate(candidate.id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      queryClient.invalidateQueries({ queryKey: ['candidate', candidate.id] })
      toast.success('Candidate updated')
      onClose?.()
    },
    onError: (err) => toast.error(err.response?.data?.error || 'Update failed'),
  })

  function handleSubmit(e) {
    e.preventDefault()
    if (!form.name?.trim() || !form.phone?.trim()) {
      toast.error('Name and phone are required')
      return
    }
    const payload = {
      name: form.name.trim(),
      phone: form.phone.trim(),
      email: form.email?.trim() || null,
      source: form.source,
      status: form.status,
      preferred_language: form.preferred_language,
      notes: form.notes?.trim() || null,
      age: form.age === '' ? null : Number.parseInt(form.age, 10),
      // height_cm / country / licenses / previous_employer / english_proficiency
      // are routed into metadata server-side (like age); experience_years,
      // highest_qualification, skills are columns; tags is a text[] array.
      height_cm: form.height_cm === '' ? null : Number.parseInt(form.height_cm, 10),
      experience_years: form.experience_years === '' ? null : Number.parseInt(form.experience_years, 10),
      country: form.country?.trim() || null,
      english_proficiency: form.english_proficiency || null,
      licenses: form.licenses?.trim() || null,
      previous_employer: form.previous_employer?.trim() || null,
      highest_qualification: form.highest_qualification?.trim() || null,
      skills: form.skills?.trim() || null,
      tags: splitCommaList(form.tags),
    }
    updateMutation.mutate(payload)
  }

  return (
    <Modal open={open} onClose={onClose} title={`Edit ${candidate?.name || 'Candidate'}`} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Input
            label="Name"
            required
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Full name"
          />
          <Input
            label="Phone"
            required
            value={form.phone}
            onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            placeholder="+94 77 123 4567"
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
            placeholder="email@example.com"
          />
          <Input
            label="Age"
            type="number"
            min="1"
            max="120"
            value={form.age}
            onChange={(e) => setForm((f) => ({ ...f, age: e.target.value }))}
            placeholder="—"
          />
          <Input
            label="Height (cm)"
            type="number"
            min="1"
            max="300"
            value={form.height_cm}
            onChange={(e) => setForm((f) => ({ ...f, height_cm: e.target.value }))}
            placeholder="—"
          />
          <Input
            label="Experience (years)"
            type="number"
            min="0"
            max="60"
            value={form.experience_years}
            onChange={(e) => setForm((f) => ({ ...f, experience_years: e.target.value }))}
            placeholder="—"
          />
          <Input
            label="Country"
            value={form.country}
            onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
            placeholder="e.g. Qatar, UAE"
          />
          <div>
            <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight">English level</label>
            <select
              className="input"
              value={form.english_proficiency}
              onChange={(e) => setForm((f) => ({ ...f, english_proficiency: e.target.value }))}
            >
              {ENGLISH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <Input
            label="Licenses"
            value={form.licenses}
            onChange={(e) => setForm((f) => ({ ...f, licenses: e.target.value }))}
            placeholder="e.g. Heavy vehicle, Forklift"
          />
          <Input
            label="Previous employer"
            value={form.previous_employer}
            onChange={(e) => setForm((f) => ({ ...f, previous_employer: e.target.value }))}
            placeholder="e.g. ABC Construction"
          />
          <Input
            label="Highest qualification"
            value={form.highest_qualification}
            onChange={(e) => setForm((f) => ({ ...f, highest_qualification: e.target.value }))}
            placeholder="e.g. O/L, Diploma"
          />
          <div>
            <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight">Source</label>
            <select
              className="input"
              value={form.source}
              onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))}
            >
              {SOURCE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight">Status</label>
            <select
              className="input"
              value={form.status}
              onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight">Preferred Language</label>
            <select
              className="input"
              value={form.preferred_language}
              onChange={(e) => setForm((f) => ({ ...f, preferred_language: e.target.value }))}
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight">Skills</label>
          <Input
            value={form.skills}
            onChange={(e) => setForm((f) => ({ ...f, skills: e.target.value }))}
            placeholder="Comma-separated, e.g. welding, driving, customer service"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight">Tags / Labels</label>
          <Input
            value={form.tags}
            onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
            placeholder="Comma-separated, e.g. Priority, Arabic speaker, Follow-up"
          />
          <p className="mt-1 ml-1 text-xs text-zinc-500 dark:text-zinc-400">Manual labels — also shown on the conversation panel.</p>
        </div>
        <div>
          <label className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight">Notes</label>
          <textarea
            rows={3}
            className="input resize-none"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Anything important about this candidate…"
          />
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={updateMutation.isPending}>
            Save Changes
          </Button>
        </div>
      </form>
    </Modal>
  )
}
