import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, UserPlus } from 'lucide-react'
import toast from 'react-hot-toast'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { createCandidateWithWelcome } from '../../api'

const LANGS = [
  { value: 'en', label: 'English' },
  { value: 'si', label: 'Sinhala' },
  { value: 'ta', label: 'Tamil' },
]

/**
 * AddCandidateDialog — add a candidate straight from the Messages panel. Creates
 * the candidate at New, auto-sends the welcome (which logs the outbound row so
 * they appear in the New tab) and hands them to the bot's intake flow. Surfaces
 * whether the welcome actually delivered (a brand-new number out of the 24h
 * window needs an approved template).
 */
export function AddCandidateDialog({ open, onClose, onCreated }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ name: '', phone: '', email: '', preferred_language: 'en', age: '', notes: '' })

  useEffect(() => {
    if (open) setForm({ name: '', phone: '', email: '', preferred_language: 'en', age: '', notes: '' })
  }, [open])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const mut = useMutation({
    mutationFn: () => createCandidateWithWelcome({
      name: form.name.trim(),
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
      preferred_language: form.preferred_language,
      age: form.age ? Number(form.age) : undefined,
      notes: form.notes.trim() || undefined,
    }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['active-chats'] })
      queryClient.invalidateQueries({ queryKey: ['active-chats-counts'] })
      queryClient.invalidateQueries({ queryKey: ['candidates'] })
      const w = res?.welcome || {}
      const waEntry = Array.isArray(w.success) ? w.success.find((s) => s.channel === 'whatsapp') : null
      if (waEntry?.queued) {
        toast('Candidate added — welcome queued; it will deliver automatically when they reply', { icon: '⏳' })
      } else if (waEntry) {
        toast.success('Candidate added — welcome sent')
      } else {
        const reason = Array.isArray(w.failed) && w.failed[0]?.reason
        const detail = reason === 'out_of_window'
          ? 'welcome not delivered (no recent chat — needs an approved template)'
          : reason === 'no_whatsapp'
            ? 'welcome not delivered (not a WhatsApp number)'
            : 'welcome could not be delivered'
        toast(`Candidate added — ${detail}`, { icon: '⚠️' })
      }
      onCreated?.(res?.candidate)
      onClose()
    },
    onError: (err) => {
      if (err?.response?.status === 403) {
        toast.error("You don't have permission to add candidates — ask an admin to grant Candidates → Create.")
        return
      }
      toast.error(err?.response?.data?.error || 'Failed to add candidate')
    },
  })

  const canSubmit = form.name.trim() && form.phone.trim() && !mut.isPending

  return (
    <Modal open={open} onClose={onClose} title="Add candidate" size="sm">
      <div className="space-y-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400 flex items-start gap-2">
          <UserPlus size={16} className="mt-0.5 shrink-0 text-primary-600" />
          Adds the candidate as <strong className="text-zinc-700 dark:text-zinc-200">New</strong>, sends a welcome on WhatsApp, and starts the chatbot intake.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Name *</label>
            <input type="text" value={form.name} onChange={set('name')} className="input w-full text-sm" placeholder="Full name" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Phone *</label>
            <input type="tel" value={form.phone} onChange={set('phone')} className="input w-full text-sm" placeholder="947XXXXXXXX" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Language</label>
            <select value={form.preferred_language} onChange={set('preferred_language')} className="input w-full text-sm">
              {LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Email</label>
            <input type="email" value={form.email} onChange={set('email')} className="input w-full text-sm" placeholder="optional" />
          </div>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Age</label>
            <input type="number" min="1" max="120" value={form.age} onChange={set('age')} className="input w-full text-sm" placeholder="optional" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1">Notes</label>
            <textarea value={form.notes} onChange={set('notes')} rows={2} className="input w-full text-sm resize-none" placeholder="optional" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t border-zinc-200 dark:border-zinc-800">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={!canSubmit}>
            {mut.isPending ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />} Add &amp; welcome
          </Button>
        </div>
      </div>
    </Modal>
  )
}
