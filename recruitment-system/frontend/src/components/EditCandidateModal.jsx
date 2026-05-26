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

const STATUS_OPTIONS = [
  { value: 'new',        label: 'New' },
  { value: 'screening',  label: 'Screening' },
  { value: 'interview',  label: 'Interview' },
  { value: 'hired',      label: 'Hired' },
  { value: 'rejected',   label: 'Rejected' },
]

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'si', label: 'Sinhala' },
  { value: 'ta', label: 'Tamil' },
]

const EMPTY_FORM = {
  name: '',
  phone: '',
  email: '',
  age: '',
  source: 'manual',
  status: 'new',
  preferred_language: 'en',
  notes: '',
}

export function EditCandidateModal({ candidate, open, onClose }) {
  const [form, setForm] = useState(EMPTY_FORM)
  const queryClient = useQueryClient()

  // Reset the form whenever a new candidate is opened
  useEffect(() => {
    if (open && candidate) {
      setForm({
        name: candidate.name || '',
        phone: candidate.phone || '',
        email: candidate.email || '',
        age: candidate.age ?? '',
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
