import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Megaphone, X, Loader2, AlertTriangle, Pause, Play, CheckCircle2 } from 'lucide-react'
import clsx from 'clsx'
import { previewCampaign, createCampaign, getCampaign, pauseCampaign, resumeCampaign, getJobs } from '../../api'
import { notify } from '../ui/Toast'

// Bulk WhatsApp template blast to "every candidate minus excluded projects".
// Two phases: configure (pick template + exclusions + AMAYA target + cap, with a
// live dry-run recipient count) → progress (poll the runner, show the delivery
// breakdown, pause/resume). Almost all recipients are out-of-window, so every
// send is a Meta template — confirm the number's messaging tier before launch.
export function CampaignDialog({ open, onClose, projects = [] }) {
  const [name, setName] = useState('UAE walk-in campaign')
  const [templateName, setTemplateName] = useState('')
  const [language, setLanguage] = useState('en')
  const [excluded, setExcluded] = useState(() => new Set())
  const [targetProjectId, setTargetProjectId] = useState('')
  const [targetJobId, setTargetJobId] = useState('')         // Male / default
  const [targetJobIdFemale, setTargetJobIdFemale] = useState('')
  const [dailyCap, setDailyCap] = useState(1000)

  const [jobs, setJobs] = useState([])
  const [preview, setPreview] = useState(null)   // { count, sample }
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [campaignId, setCampaignId] = useState(null)
  const [campaign, setCampaign] = useState(null) // live status row

  const projectName = (p) => p.title || p.name || 'Untitled project'

  // Reset when (re)opened.
  useEffect(() => {
    if (open) {
      setPreview(null); setCampaignId(null); setCampaign(null); setSubmitting(false)
    }
  }, [open])

  // Live recipient count whenever the exclusion set changes (debounced).
  useEffect(() => {
    if (!open || campaignId) return
    let cancelled = false
    setPreviewing(true)
    const t = setTimeout(() => {
      previewCampaign({ excluded_project_ids: Array.from(excluded) })
        .then((res) => { if (!cancelled) setPreview(res) })
        .catch(() => { if (!cancelled) setPreview(null) })
        .finally(() => { if (!cancelled) setPreviewing(false) })
    }, 350)
    return () => { cancelled = true; clearTimeout(t) }
  }, [open, excluded, campaignId])

  // Jobs under the chosen target (AMAYA) project, for the "Confirm" target job.
  useEffect(() => {
    if (!targetProjectId) { setJobs([]); setTargetJobId(''); setTargetJobIdFemale(''); return }
    let cancelled = false
    getJobs({ project_id: targetProjectId, limit: 200 })
      .then((data) => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : (data?.jobs || data?.data || [])
        setJobs(list)
      })
      .catch(() => { if (!cancelled) setJobs([]) })
    return () => { cancelled = true }
  }, [targetProjectId])

  // Poll the runner while the campaign is in flight.
  useEffect(() => {
    if (!campaignId) return
    let cancelled = false
    const tick = () => getCampaign(campaignId)
      .then((c) => { if (!cancelled) setCampaign(c) })
      .catch(() => {})
    tick()
    const iv = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [campaignId])

  const toggleExcluded = (id) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const startCampaign = async () => {
    if (!templateName.trim()) { notify.error('Enter the approved Meta template name.'); return }
    setSubmitting(true)
    try {
      const res = await createCampaign({
        name: name.trim() || 'Bulk campaign',
        template_name: templateName.trim(),
        language,
        excluded_project_ids: Array.from(excluded),
        target_project_id: targetProjectId || null,
        target_job_id: targetJobId || null,
        target_job_id_female: targetJobIdFemale || null,
        daily_cap: Number(dailyCap) || undefined,
      })
      setCampaignId(res.campaign_id)
      notify.success(`Campaign started — ${res.total} recipients queued.`)
    } catch (err) {
      notify.error(err?.response?.data?.error || 'Could not start the campaign.')
    } finally {
      setSubmitting(false)
    }
  }

  const summary = campaign?.delivery_summary || {}
  const done = (campaign?.sent || 0) + (campaign?.failed || 0) + (campaign?.skipped || 0)
  const total = campaign?.total || 0
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-zinc-900 shadow-2xl ring-1 ring-zinc-200 dark:ring-zinc-800">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 px-5 py-3">
          <div className="flex items-center gap-2">
            <Megaphone size={18} className="text-primary-600" />
            <h2 className="text-base font-bold">Bulk WhatsApp campaign</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>

        {/* ── Progress phase ─────────────────────────────────────────────── */}
        {campaignId ? (
          <div className="px-5 py-4 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {campaign?.status === 'done'
                ? <><CheckCircle2 size={16} className="text-emerald-600" /> Complete</>
                : campaign?.status === 'paused'
                  ? <><Pause size={16} className="text-amber-600" /> Paused</>
                  : <><Loader2 size={16} className="animate-spin text-primary-600" /> Sending…</>}
            </div>

            <div>
              <div className="h-2.5 w-full rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                <div className="h-full bg-primary-600 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-xs text-zinc-500">{done.toLocaleString()} / {total.toLocaleString()} processed ({pct}%)</div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <Stat label="Sent" value={campaign?.sent || 0} tone="bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" />
              <Stat label="Failed" value={campaign?.failed || 0} tone="bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300" />
              <Stat label="No WhatsApp" value={summary.no_whatsapp || 0} tone="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300" />
              <Stat label="Rate-limited" value={summary.rate_limited || 0} tone="bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300" />
              <Stat label="Token expired" value={summary.token_expired || 0} tone="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300" />
              <Stat label="Other errors" value={summary.other || 0} tone="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300" />
            </div>

            {campaign?.daily_cap > 0 && campaign?.status === 'sending' && done < total && (
              <p className="text-[11px] text-zinc-500">
                Pacing at {campaign.daily_cap.toLocaleString()}/day to protect the number's quality rating —
                the rest resume automatically tomorrow. You can close this window; it keeps running on the server.
              </p>
            )}
            {campaign?.last_error && (
              <p className="text-[11px] text-rose-600">{campaign.last_error}</p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              {campaign?.status === 'sending' && (
                <button type="button" onClick={() => pauseCampaign(campaignId).then(() => getCampaign(campaignId).then(setCampaign))}
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 hover:bg-amber-200">
                  <Pause size={13} /> Pause
                </button>
              )}
              {campaign?.status === 'paused' && (
                <button type="button" onClick={() => resumeCampaign(campaignId).then(() => getCampaign(campaignId).then(setCampaign))}
                  className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold bg-primary-600 text-white hover:bg-primary-700">
                  <Play size={13} /> Resume
                </button>
              )}
              <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200">Close</button>
            </div>
          </div>
        ) : (
          /* ── Configure phase ──────────────────────────────────────────── */
          <div className="px-5 py-4 space-y-4">
            <Field label="Campaign name">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </Field>

            <Field label="Approved Meta template name" hint="Must match the template approved in WhatsApp Business Manager AND the chatbot's TEMPLATE_CAMPAIGN_WALKIN env var.">
              <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. dewan_walkin_uae" className={inputCls} />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Language">
                <select value={language} onChange={(e) => setLanguage(e.target.value)} className={inputCls}>
                  <option value="en">English</option>
                  <option value="si">Sinhala</option>
                  <option value="ta">Tamil</option>
                </select>
              </Field>
              <Field label="Daily send cap" hint="Meta-tier safety.">
                <input type="number" min={1} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} className={inputCls} />
              </Field>
            </div>

            <Field label="“Confirm my slot” creates an application under… (AMAYA)" hint="Pick the AMAYA project, then the Male and Female Security jobs. Confirmers route by their recorded gender; unknown gender → the Male/default job.">
              <select value={targetProjectId} onChange={(e) => setTargetProjectId(e.target.value)} className={clsx(inputCls, 'mb-2')}>
                <option value="">Select project…</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{projectName(p)}</option>)}
              </select>
              <div className="grid grid-cols-2 gap-2">
                <select value={targetJobId} onChange={(e) => setTargetJobId(e.target.value)} disabled={!targetProjectId} className={inputCls}>
                  <option value="">Male / default job…</option>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{j.title || j.name || 'Untitled job'}</option>)}
                </select>
                <select value={targetJobIdFemale} onChange={(e) => setTargetJobIdFemale(e.target.value)} disabled={!targetProjectId} className={inputCls}>
                  <option value="">Female job (optional)…</option>
                  {jobs.map((j) => <option key={j.id} value={j.id}>{j.title || j.name || 'Untitled job'}</option>)}
                </select>
              </div>
              {!targetJobId && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600">
                  <AlertTriangle size={12} /> Without a target job, “Confirm my slot” can't create applications.
                </p>
              )}
            </Field>

            <Field label="Exclude projects" hint="Everyone NOT in these projects receives the message.">
              <div className="max-h-32 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-800 p-2 space-y-1">
                {projects.length === 0 && <p className="text-xs text-zinc-400">No projects.</p>}
                {projects.map((p) => (
                  <label key={p.id} className="flex items-center gap-2 text-xs cursor-pointer">
                    <input type="checkbox" checked={excluded.has(String(p.id))} onChange={() => toggleExcluded(String(p.id))} />
                    {projectName(p)}
                  </label>
                ))}
              </div>
            </Field>

            <div className="rounded-lg bg-primary-50 dark:bg-primary-950/30 px-3 py-2 text-sm">
              {previewing
                ? <span className="inline-flex items-center gap-1 text-zinc-500"><Loader2 size={13} className="animate-spin" /> Counting recipients…</span>
                : preview
                  ? <span><strong className="text-primary-700 dark:text-primary-300">{preview.count.toLocaleString()}</strong> candidates will receive this message.</span>
                  : <span className="text-zinc-400">Recipient count unavailable.</span>}
            </div>

            <p className="flex items-start gap-1.5 text-[11px] text-amber-600">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              This is a business-initiated marketing send. Confirm the WhatsApp number's messaging tier first — a large blast can exhaust the daily limit or degrade the number's quality rating.
            </p>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-semibold bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200">Cancel</button>
              <button type="button" onClick={startCampaign} disabled={submitting || !templateName.trim() || !preview?.count}
                className="inline-flex items-center gap-1 rounded-lg px-4 py-1.5 text-sm font-semibold bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50">
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Megaphone size={14} />}
                Send to {preview?.count ? preview.count.toLocaleString() : '…'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

const inputCls = 'w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500'

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-zinc-600 dark:text-zinc-300 mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-zinc-400">{hint}</p>}
    </div>
  )
}

function Stat({ label, value, tone }) {
  return (
    <div className={clsx('flex items-center justify-between rounded-lg px-2.5 py-1.5 font-semibold', tone)}>
      <span>{label}</span>
      <span>{Number(value || 0).toLocaleString()}</span>
    </div>
  )
}
