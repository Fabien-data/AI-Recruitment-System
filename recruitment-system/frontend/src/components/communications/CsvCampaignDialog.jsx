import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Upload, X, Loader2, AlertTriangle, FileText, Send, CheckCircle2, RotateCcw, Download } from 'lucide-react'
import clsx from 'clsx'
import Papa from 'papaparse'
import {
  listCampaignTemplates, previewCampaignNumbers, createCsvCampaign,
  getCampaign, getCampaignDelivery, getCampaignFailures, retryCampaignFailed,
} from '../../api'
import { notify } from '../ui/Toast'

// CSV-driven WhatsApp blast: drop CSV(s) of numbers → pick the phone column → pick
// an approved (static) Meta template → send to every number with true delivery
// receipts. Parses CSV with papaparse only (no heavy xlsx) so the dialog stays
// light and can't fail to load.
const PHONE_HEADER_RE = /phone|mobile|number|contact|whats?app|\btel\b|\btp\b|msisdn/i
const PHONE_VALUE_RE = /^\+?\d[\d\s\-()]{6,}$/

// Catch any render error inside the dialog and SHOW it instead of silently
// swallowing it (so a bug is visible, never a dead button).
class DialogErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  render() {
    if (this.state.err) {
      return (
        <div className="px-5 py-6 text-sm">
          <div className="font-semibold text-rose-600 mb-1">This dialog hit an error.</div>
          <div className="text-xs text-rose-500 break-words">{String(this.state.err?.message || this.state.err)}</div>
          <button type="button" onClick={this.props.onClose} className="mt-3 rounded-lg px-3 py-1.5 text-xs font-semibold bg-zinc-100 dark:bg-zinc-800">Close</button>
        </div>
      )
    }
    return this.props.children
  }
}

export function CsvCampaignDialog({ open, onClose }) {
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-zinc-900 shadow-2xl ring-1 ring-zinc-200 dark:ring-zinc-800">
        <DialogErrorBoundary onClose={onClose}>
          <DialogBody onClose={onClose} />
        </DialogErrorBoundary>
      </div>
    </div>,
    document.body
  )
}

// Parse one CSV File → { headers, rows }. Tolerates a header row OR a bare list
// of numbers with no header (synthesizes column names).
function parseCsv(file) {
  return new Promise((resolve) => {
    Papa.parse(file, {
      header: false,
      skipEmptyLines: 'greedy',
      complete: (res) => {
        const matrix = (res.data || []).filter((r) => Array.isArray(r) && r.length)
        if (!matrix.length) return resolve({ headers: [], rows: [] })
        const first = matrix[0].map((c) => String(c ?? '').trim())
        const firstHasPhone = first.some((c) => PHONE_VALUE_RE.test(c))
        const firstHasHeaderWord = first.some((c) => PHONE_HEADER_RE.test(c))
        const hasHeader = firstHasHeaderWord || !firstHasPhone
        const headers = (hasHeader ? first : first.map((_, i) => `column ${i + 1}`))
          .map((h, i) => h || `column ${i + 1}`)
        const dataRows = hasHeader ? matrix.slice(1) : matrix
        const rows = dataRows.map((arr) => {
          const o = {}
          headers.forEach((h, i) => { o[h] = arr[i] })
          return o
        })
        resolve({ headers, rows })
      },
      error: () => resolve({ headers: [], rows: [] }),
    })
  })
}

function DialogBody({ onClose }) {
  const [rows, setRows] = useState([])
  const [headers, setHeaders] = useState([])
  const [fileNames, setFileNames] = useState([])
  const [phoneCol, setPhoneCol] = useState('')

  const [templates, setTemplates] = useState([])
  const [tplError, setTplError] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [language, setLanguage] = useState('en')
  const [name, setName] = useState('CSV blast')
  const [dailyCap, setDailyCap] = useState(1000)

  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [campaignId, setCampaignId] = useState(null)
  const [campaign, setCampaign] = useState(null)
  const [delivery, setDelivery] = useState(null)
  const [retrying, setRetrying] = useState(false)
  const fileRef = useRef(null)

  // Load the approved template list once.
  useEffect(() => {
    listCampaignTemplates()
      .then((res) => { setTemplates((res && res.templates) || []); setTplError(false) })
      .catch(() => setTplError(true))
  }, [])

  const phones = useMemo(() => {
    if (!phoneCol) return []
    return rows.map((r) => r && r[phoneCol]).filter((v) => v != null && String(v).trim() !== '')
  }, [rows, phoneCol])

  // Live classify whenever the phone column / data changes (debounced).
  useEffect(() => {
    if (campaignId || phones.length === 0) { setPreview(null); return }
    let cancelled = false
    setPreviewing(true)
    const t = setTimeout(() => {
      previewCampaignNumbers(phones)
        .then((res) => { if (!cancelled) setPreview(res) })
        .catch(() => { if (!cancelled) setPreview(null) })
        .finally(() => { if (!cancelled) setPreviewing(false) })
    }, 300)
    return () => { cancelled = true; clearTimeout(t) }
  }, [phones, campaignId])

  // Poll status + delivery receipts while the blast runs.
  useEffect(() => {
    if (!campaignId) return
    let cancelled = false
    const tick = () => {
      getCampaign(campaignId).then((c) => { if (!cancelled) setCampaign(c) }).catch(() => {})
      getCampaignDelivery(campaignId).then((d) => { if (!cancelled) setDelivery(d) }).catch(() => {})
    }
    tick()
    const iv = setInterval(tick, 4000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [campaignId])

  const onFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    const parsed = await Promise.all(files.map((f) => parseCsv(f)))
    const hdr = new Set(headers)
    const allRows = []
    parsed.forEach((p) => { p.headers.forEach((h) => h && hdr.add(h)); allRows.push(...p.rows) })
    const nextHeaders = Array.from(hdr)
    setHeaders(nextHeaders)
    setRows((prev) => [...prev, ...allRows])
    setFileNames((prev) => [...prev, ...files.map((f) => f.name)])
    if (!phoneCol) {
      const guess = nextHeaders.find((h) => PHONE_HEADER_RE.test(h)) || (nextHeaders.length === 1 ? nextHeaders[0] : '')
      if (guess) setPhoneCol(guess)
    }
  }

  const startBlast = async () => {
    if (!templateName.trim()) { notify.error('Pick a template.'); return }
    if (!preview || !preview.valid) { notify.error('No valid numbers to send to.'); return }
    setSubmitting(true)
    try {
      const res = await createCsvCampaign({
        name: name.trim() || 'CSV blast',
        template_name: templateName.trim(),
        language,
        daily_cap: Number(dailyCap) || undefined,
        phones,
      })
      setCampaignId(res.campaign_id)
      notify.success(`Blast started — ${res.total} numbers queued (${res.invalid_count} invalid skipped).`)
    } catch (err) {
      notify.error(err?.response?.data?.error || 'Could not start the blast.')
    } finally {
      setSubmitting(false)
    }
  }

  const doRetry = async () => {
    setRetrying(true)
    try {
      const r = await retryCampaignFailed(campaignId)
      notify.success(r.requeued > 0 ? `Re-queued ${r.requeued} for retry.` : 'Nothing retryable left.')
    } catch { notify.error('Retry failed.') } finally { setRetrying(false) }
  }

  const downloadFailures = async () => {
    try {
      const { rows: fr } = await getCampaignFailures(campaignId)
      const header = 'phone,status,reason,delivered\n'
      const body = (fr || []).map((r) =>
        `${r.phone || ''},${r.status || ''},${r.reason || ''},${r.delivered_at ? 'yes' : 'no'}`).join('\n')
      const blob = new Blob([header + body], { type: 'text/csv' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `csv-blast-failures-${String(campaignId).slice(0, 8)}.csv`
      a.click(); URL.revokeObjectURL(a.href)
    } catch { notify.error('Could not export failures.') }
  }

  const total = (delivery && delivery.total) ?? (campaign && campaign.total) ?? 0
  const done = ((delivery && delivery.sent) || 0) + ((delivery && delivery.failed) || 0) + ((delivery && delivery.skipped) || 0)
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-100 dark:border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-2">
          <Upload size={18} className="text-indigo-600" />
          <h2 className="text-base font-bold">CSV WhatsApp blast</h2>
        </div>
        <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={16} /></button>
      </div>

      {campaignId ? (
        <div className="px-5 py-4 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {campaign?.status === 'done'
              ? <><CheckCircle2 size={16} className="text-emerald-600" /> Complete</>
              : campaign?.status === 'paused'
                ? <><AlertTriangle size={16} className="text-amber-600" /> Paused</>
                : <><Loader2 size={16} className="animate-spin text-indigo-600" /> Sending…</>}
          </div>
          <div>
            <div className="h-2.5 w-full rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div className="h-full bg-indigo-600 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 text-xs text-zinc-500">{done.toLocaleString()} / {total.toLocaleString()} processed ({pct}%)</div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Stat label="Sent (accepted)" value={delivery?.sent || 0} tone="bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300" />
            <Stat label="Delivered" value={delivery?.delivered || 0} tone="bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300" />
            <Stat label="Read" value={delivery?.read || 0} tone="bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300" />
            <Stat label="Failed" value={delivery?.failed || 0} tone="bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300" />
            <Stat label="Pending" value={delivery?.pending || 0} tone="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300" />
            <Stat label="Skipped" value={delivery?.skipped || 0} tone="bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300" />
          </div>
          <p className="text-[11px] text-zinc-500">"Delivered/Read" come from Meta's receipts as they arrive. Numbers not on WhatsApp / invalid show under Failed.</p>
          {campaign?.last_error && <p className="text-[11px] text-rose-600">{campaign.last_error}</p>}
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button type="button" onClick={downloadFailures} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200"><Download size={13} /> Failures CSV</button>
            <button type="button" onClick={doRetry} disabled={retrying} className="inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold bg-amber-100 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 hover:bg-amber-200 disabled:opacity-50">{retrying ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Retry failed</button>
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700">Close</button>
          </div>
        </div>
      ) : (
        <div className="px-5 py-4 space-y-4">
          <Field label="Upload CSV files of phone numbers" hint="Add one or more .csv files; they're merged + de-duplicated. A header row is optional.">
            <div
              onClick={() => fileRef.current?.click()}
              onDrop={(e) => { e.preventDefault(); onFiles(e.dataTransfer.files) }}
              onDragOver={(e) => e.preventDefault()}
              className="cursor-pointer rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-700 px-3 py-6 text-center text-sm text-zinc-500 hover:border-indigo-400"
            >
              <Upload size={20} className="mx-auto mb-1 text-zinc-400" />
              Drop CSV files here, or click to choose
              <input ref={fileRef} type="file" accept=".csv,.txt" multiple className="hidden"
                onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} />
            </div>
            {fileNames.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
                {fileNames.map((n, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5"><FileText size={11} /> {n}</span>
                ))}
                <span className="text-zinc-400">· {rows.length.toLocaleString()} rows</span>
              </div>
            )}
          </Field>

          {headers.length > 0 && (
            <Field label="Which column holds the phone number?">
              <select value={phoneCol} onChange={(e) => setPhoneCol(e.target.value)} className={inputCls}>
                <option value="">Select column…</option>
                {headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </Field>
          )}

          {phoneCol && (
            <div className="rounded-lg bg-indigo-50 dark:bg-indigo-950/30 px-3 py-2 text-sm">
              {previewing
                ? <span className="inline-flex items-center gap-1 text-zinc-500"><Loader2 size={13} className="animate-spin" /> Checking numbers…</span>
                : preview
                  ? <span><strong className="text-indigo-700 dark:text-indigo-300">{Number(preview.valid || 0).toLocaleString()}</strong> valid · {preview.invalid} invalid · {preview.duplicates} duplicate</span>
                  : <span className="text-zinc-400">No numbers detected in that column.</span>}
            </div>
          )}

          <Field label="Template" hint="Only approved, no-variable templates can be blasted to a bare number list.">
            {templates.length > 0 ? (
              <select value={templateName} onChange={(e) => setTemplateName(e.target.value)} className={inputCls}>
                <option value="">Select template…</option>
                {templates.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.category})</option>)}
              </select>
            ) : (
              <>
                <input value={templateName} onChange={(e) => setTemplateName(e.target.value)} placeholder="approved_template_name" className={inputCls} />
                <p className="mt-1 text-[11px] text-amber-600">{tplError ? 'Could not load templates — type the approved name.' : 'Loading templates… or type the approved name.'}</p>
              </>
            )}
          </Field>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="Blast name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
            </div>
            <Field label="Daily cap"><input type="number" min={1} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} className={inputCls} /></Field>
          </div>

          <p className="flex items-start gap-1.5 text-[11px] text-amber-600">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            Sending to numbers that never opted in is business-initiated messaging — watch your Meta tier + number quality rating.
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-semibold bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200">Cancel</button>
            <button type="button" onClick={startBlast} disabled={submitting || !templateName.trim() || !preview?.valid}
              className="inline-flex items-center gap-1 rounded-lg px-4 py-1.5 text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send to {preview?.valid ? Number(preview.valid).toLocaleString() : '…'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

const inputCls = 'w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'

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
