import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Check, Power, Trash2, Megaphone, QrCode, MessageSquare, Plus } from 'lucide-react'
import toast from 'react-hot-toast'
import { getAdLinks, generateAdLink, toggleAdLink, deleteAdLink } from '../api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

function CopyField({ label, value, mono = true }) {
  const [copied, setCopied] = useState(false)
  if (!value) return null
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(`${label} copied`)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy — select and copy manually')
    }
  }
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1 ml-0.5">
        {label}
      </p>
      <div className="flex items-stretch gap-2">
        <div
          className={`flex-1 min-w-0 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/60 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 break-all ${mono ? 'font-mono text-xs' : ''}`}
        >
          {value}
        </div>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 inline-flex items-center justify-center rounded-xl border border-zinc-200 dark:border-zinc-700 px-3 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700 transition-colors"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={16} className="text-emerald-500" /> : <Copy size={16} />}
        </button>
      </div>
    </div>
  )
}

function AdLinkCard({ link }) {
  const queryClient = useQueryClient()
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['ad-links'] })
    queryClient.invalidateQueries({ queryKey: ['job'] })
  }
  const toggle = useMutation({
    mutationFn: () => toggleAdLink(link.ad_ref),
    onSuccess: (res) => {
      toast.success(res?.message || 'Updated')
      invalidate()
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to toggle'),
  })
  const remove = useMutation({
    mutationFn: () => deleteAdLink(link.ad_ref),
    onSuccess: () => {
      toast.success('Ad link deleted')
      invalidate()
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to delete'),
  })

  const active = Boolean(link.is_active)
  const startMessage = link.start_message || `START:${link.ad_ref}`
  const waLink = link.whatsapp_link || (link.meta_ad_url || '')

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
            {link.campaign_name || link.ad_ref}
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono break-all">{link.ad_ref}</p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            active
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
          }`}
        >
          {active ? 'Live' : 'Paused'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 py-1.5">
          <p className="font-bold text-zinc-900 dark:text-zinc-100">{link.clicks ?? 0}</p>
          <p className="text-[10px] uppercase tracking-wide text-zinc-500">Clicks</p>
        </div>
        <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 py-1.5">
          <p className="font-bold text-zinc-900 dark:text-zinc-100">{link.conversions ?? 0}</p>
          <p className="text-[10px] uppercase tracking-wide text-zinc-500">Conversions</p>
        </div>
        <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 py-1.5">
          <p className="font-bold text-zinc-900 dark:text-zinc-100">{link.conversion_rate || '0%'}</p>
          <p className="text-[10px] uppercase tracking-wide text-zinc-500">Rate</p>
        </div>
      </div>

      <CopyField label="Meta ad destination URL" value={link.meta_ad_url} />
      <CopyField label="WhatsApp / QR link" value={waLink} />
      <CopyField label="Pre-filled message (do not edit)" value={startMessage} />

      <div className="flex items-center justify-between gap-2 pt-1">
        {link.qr_code_url ? (
          <a
            href={link.qr_code_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
          >
            <QrCode size={15} /> Open QR code
          </a>
        ) : <span />}
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => toggle.mutate()} loading={toggle.isLoading}>
            <Power size={14} /> {active ? 'Pause' : 'Activate'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => remove.mutate()}
            loading={remove.isLoading}
            className="text-rose-600 hover:text-rose-700 dark:text-rose-400"
          >
            <Trash2 size={14} /> Delete
          </Button>
        </div>
      </div>
    </div>
  )
}

export function AdLinkModal({ isOpen, job, onClose }) {
  const queryClient = useQueryClient()
  const [campaignName, setCampaignName] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['ad-links', job?.id],
    queryFn: () => getAdLinks({ job_id: job.id }),
    enabled: Boolean(isOpen && job?.id),
  })

  const links = Array.isArray(data?.data) ? data.data : []

  const generate = useMutation({
    mutationFn: () =>
      generateAdLink({
        job_id: job.id,
        project_id: job.project_id,
        campaign_name: campaignName.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Ad link generated — the bot now knows this job')
      setCampaignName('')
      queryClient.invalidateQueries({ queryKey: ['ad-links'] })
      queryClient.invalidateQueries({ queryKey: ['job'] })
    },
    onError: (e) => {
      if (e.response?.status === 409) {
        toast.error(`That code is already used by "${e.response.data?.existing_campaign || 'another campaign'}"`)
      } else {
        toast.error(e.response?.data?.error || 'Failed to generate ad link')
      }
    },
  })

  if (!job) return null

  const missingProject = !job.project_id

  return (
    <Modal open={isOpen} onClose={onClose} title="Meta ad links" size="lg">
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-2xl bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900/50 p-4">
          <Megaphone className="mt-0.5 h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0" />
          <div className="text-sm text-blue-900 dark:text-blue-200">
            <p className="font-semibold">{job.title}</p>
            <p className="mt-1 text-blue-800/80 dark:text-blue-300/80">
              Generate a link, paste the <span className="font-semibold">Meta ad destination URL</span> into your
              Click-to-WhatsApp ad, and write any headline you like. The bot identifies this exact job from the
              hidden pre-filled message — never from the headline.
            </p>
          </div>
        </div>

        {missingProject ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            This job has no linked project, so an ad link can’t be generated. Attach it to a project first.
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                label="Campaign name (optional)"
                placeholder={`${job.title} — e.g. FB March 2026`}
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
              />
            </div>
            <Button onClick={() => generate.mutate()} loading={generate.isLoading}>
              <Plus size={16} /> Generate link
            </Button>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            <MessageSquare size={15} /> Existing links
          </div>
          {isLoading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>
          ) : links.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No ad links yet. Generate one above to start a campaign for this job.
            </p>
          ) : (
            links.map((link) => <AdLinkCard key={link.ad_ref} link={link} />)
          )}
        </div>
      </div>
    </Modal>
  )
}
