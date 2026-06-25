import { useMemo, useRef, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { useDropzone } from 'react-dropzone'
import toast from 'react-hot-toast'
import {
  Upload, FileSpreadsheet, FolderArchive, CheckCircle2, AlertTriangle,
  Users, Download, ArrowRight, ArrowLeft, Loader2, FileWarning, CalendarCheck,
} from 'lucide-react'
import { getProjects, getProjectJobs, validateBulkImport, commitBulkImportBatch } from '../api'
import { PageHeader } from '../components/ui/PageHeader'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import {
  parseSpreadsheet, normalizeHeaders, mapRowsToCanonical, CANONICAL_FIELDS,
  unzipToFiles, matchFilesToRows, buildBatches, stripRowForPayload,
  buildTemplateWorkbook, buildTemplateCsv, rowsToCsvBlob, downloadBlob,
} from '../utils/bulkImport'

const STEPS = ['Project', 'Spreadsheet', 'CVs', 'Review', 'Import', 'Done']

function asArray(d) {
  return Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : []
}

function Stepper({ step }) {
  return (
    <div className="flex items-center gap-2 mb-6 flex-wrap">
      {STEPS.map((label, i) => {
        const state = i < step ? 'done' : i === step ? 'active' : 'todo'
        return (
          <div key={label} className="flex items-center gap-2">
            <div className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${
              state === 'active' ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                : state === 'done' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'}`}>
              <span className="grid h-5 w-5 place-items-center rounded-full bg-black/10 dark:bg-white/10">{i + 1}</span>
              {label}
            </div>
            {i < STEPS.length - 1 && <span className="text-zinc-300">›</span>}
          </div>
        )
      })}
    </div>
  )
}

function StatTile({ label, value, tone = 'zinc' }) {
  const tones = {
    zinc: 'bg-zinc-50 text-zinc-700 border-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-200 dark:border-zinc-700',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800/50',
    amber: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800/50',
    red: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800/50',
  }
  return (
    <div className={`rounded-2xl border px-4 py-3 ${tones[tone]}`}>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs font-medium opacity-80">{label}</div>
    </div>
  )
}

export default function BulkImport() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  // Step 1 — project + default job
  const [projectId, setProjectId] = useState('')
  const [defaultJobId, setDefaultJobId] = useState('')

  // Step 2 — spreadsheet
  const [fileName, setFileName] = useState('')
  const [headerMap, setHeaderMap] = useState({})        // originalHeader → canonical|null
  const [rawHeaders, setRawHeaders] = useState([])
  const [rawRows, setRawRows] = useState([])
  const [parseError, setParseError] = useState('')

  // Step 3 — CVs
  const [cvFileCount, setCvFileCount] = useState(0)
  const [matchReport, setMatchReport] = useState(null)
  const [unzipping, setUnzipping] = useState(false)

  // Step 4 — dry run
  const [dryRun, setDryRun] = useState(null)
  const [validating, setValidating] = useState(false)

  // Step 5 — commit
  const [commit, setCommit] = useState({ running: false, done: 0, total: 0, batchIndex: 0, totalBatches: 0, error: '', resumeFrom: 0 })

  // Step 6 — results
  const [results, setResults] = useState(null)

  const projectsQuery = useQuery({ queryKey: ['projects', 'bulk-import'], queryFn: () => getProjects({}) })
  const jobsQuery = useQuery({
    queryKey: ['project-jobs', projectId],
    queryFn: () => getProjectJobs(projectId),
    enabled: !!projectId,
  })
  const projects = asArray(projectsQuery.data)
  const jobs = asArray(jobsQuery.data)

  // canonical rows derived from the raw rows + the confirmed header map
  const canonicalRows = useMemo(
    () => (rawRows.length ? mapRowsToCanonical(rawRows, headerMap) : []),
    [rawRows, headerMap]
  )
  const mappedCanonicals = useMemo(() => new Set(Object.values(headerMap).filter(Boolean)), [headerMap])
  const hasName = mappedCanonicals.has('name')
  const hasPhone = mappedCanonicals.has('phone')

  // ── Step 2 handlers ─────────────────────────────────────────────────────────
  const onSheetDrop = useCallback(async (files) => {
    const file = files?.[0]
    if (!file) return
    setParseError('')
    try {
      const { headers, rows } = await parseSpreadsheet(file)
      if (!headers.length) { setParseError('No columns found in the file.'); return }
      const norm = normalizeHeaders(headers)
      setFileName(file.name)
      setRawHeaders(headers)
      setRawRows(rows)
      setHeaderMap(norm.map)
      // reset downstream state when a new sheet is loaded
      setMatchReport(null); setDryRun(null); setResults(null); setCvFileCount(0)
    } catch (e) {
      setParseError(e.message || 'Failed to parse spreadsheet')
    }
  }, [])

  const sheetDrop = useDropzone({
    onDrop: onSheetDrop,
    multiple: false,
    noClick: true,
    noKeyboard: true,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
    },
  })

  const setColumnMapping = (original, canonical) =>
    setHeaderMap((prev) => ({ ...prev, [original]: canonical || null }))

  // ── Step 3 handlers ─────────────────────────────────────────────────────────
  const ingestCvFiles = useCallback(async (files) => {
    if (!files.length) return
    setUnzipping(true)
    try {
      let cvFiles = []
      if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
        cvFiles = await unzipToFiles(files[0])
      } else {
        cvFiles = files
      }
      const report = matchFilesToRows(canonicalRows, cvFiles)
      setCvFileCount(cvFiles.length)
      setMatchReport(report)
      if (report.duplicateNames.length) {
        toast(`${report.duplicateNames.length} duplicate filename(s) ignored`, { icon: '⚠️' })
      }
    } catch (e) {
      toast.error(e.message || 'Failed to read CV files')
    } finally {
      setUnzipping(false)
    }
  }, [canonicalRows])

  const cvDrop = useDropzone({
    onDrop: ingestCvFiles,
    multiple: true,
    noClick: true,
    noKeyboard: true,
  })

  const folderInputRef = useRef(null)

  // ── Step 4: dry run ─────────────────────────────────────────────────────────
  const runDryRun = async () => {
    setValidating(true)
    setDryRun(null)
    try {
      const payloadRows = canonicalRows.map((r) => ({ ...stripRowForPayload(r), cv_present: !!r.cv_present }))
      const report = await validateBulkImport({
        project_id: projectId,
        default_job_id: defaultJobId || null,
        rows: payloadRows,
      })
      setDryRun(report)
      setStep(3)
    } catch (e) {
      toast.error(e?.response?.data?.error || e.message || 'Validation failed')
    } finally {
      setValidating(false)
    }
  }

  // verdict-by-row index for the commit filter + final report
  const verdictByIndex = useMemo(() => {
    const m = {}
    if (dryRun?.rows) for (const v of dryRun.rows) m[v.row_index] = v
    return m
  }, [dryRun])

  // ── Step 5: batched commit ──────────────────────────────────────────────────
  const runCommit = async (resumeFrom = 0) => {
    const okRows = canonicalRows.filter((r) => verdictByIndex[r._index]?.verdict === 'ok')
    const batches = buildBatches(okRows)
    const batchId = (results?.batchId) || (crypto.randomUUID ? crypto.randomUUID() : `batch-${Date.now()}`)
    const collected = resumeFrom > 0 && results?.commitResults ? [...results.commitResults] : []
    let done = resumeFrom > 0 ? collected.length : 0

    setStep(4)
    setCommit({ running: true, done, total: okRows.length, batchIndex: resumeFrom, totalBatches: batches.length, error: '', resumeFrom })

    for (let bi = resumeFrom; bi < batches.length; bi++) {
      const batch = batches[bi]
      const fd = new FormData()
      fd.append('payload', JSON.stringify({
        project_id: projectId,
        default_job_id: defaultJobId || null,
        batch_id: batchId,
        batch_index: bi,
        rows: batch.map(stripRowForPayload),
      }))
      for (const row of batch) {
        if (row.cvFile) fd.append(`cv_${row._index}`, row.cvFile, row.cvFile.name)
      }
      try {
        const res = await commitBulkImportBatch(fd)
        collected.push(...(res.results || []))
        done += batch.length
        setCommit((c) => ({ ...c, done, batchIndex: bi + 1 }))
      } catch (e) {
        setCommit((c) => ({ ...c, running: false, error: `Batch ${bi + 1} failed: ${e?.response?.data?.error || e.message}`, resumeFrom: bi }))
        setResults({ batchId, commitResults: collected }) // preserve for resume
        return
      }
    }

    finalizeResults(batchId, collected, okRows.length)
  }

  const finalizeResults = (batchId, commitResults, attempted) => {
    // Merge commit outcomes (ok rows) with dry-run verdicts for the skipped/error rows.
    const byIndex = new Map(commitResults.map((r) => [r.row_index, r]))
    const skippedOrErrored = []
    for (const v of (dryRun?.rows || [])) {
      if (v.verdict === 'ok') continue
      const status = v.verdict === 'db_duplicate' || v.verdict === 'in_file_duplicate'
        ? 'skipped_duplicate' : 'error'
      skippedOrErrored.push({ row_index: v.row_index, status, reason: v.reason || v.verdict, matched_field: v.matched_field || null, cv_attached: false })
    }

    const all = [...commitResults, ...skippedOrErrored]
    const summary = all.reduce((acc, r) => {
      if (r.status === 'created') acc.created++
      else if (r.status === 'skipped_duplicate') acc.skipped++
      else acc.error++
      if (r.cv_attached) acc.cv_attached++
      return acc
    }, { created: 0, skipped: 0, error: 0, cv_attached: 0 })

    setResults({ batchId, commitResults, all, summary, attempted })
    setCommit((c) => ({ ...c, running: false }))
    setStep(5)
  }

  const downloadReport = () => {
    const rowByIndex = new Map(canonicalRows.map((r) => [r._index, r]))
    const lines = (results?.all || [])
      .filter((r) => r.status !== 'created')
      .map((r) => {
        const src = rowByIndex.get(r.row_index) || {}
        return {
          row: r.row_index + 2, // +1 header, +1 to 1-base
          name: src.name || '',
          phone: src.phone || '',
          email: src.email || '',
          outcome: r.status,
          reason: r.reason || '',
        }
      })
    if (!lines.length) { toast('No skipped or errored rows 🎉'); return }
    downloadBlob(rowsToCsvBlob(lines, ['row', 'name', 'phone', 'email', 'outcome', 'reason']), 'bulk-import-skipped.csv')
  }

  // Candidates who were imported but the welcome template did NOT reach (no
  // WhatsApp). Only meaningful when sends ran (whatsapp_unreachable is a boolean,
  // not null). Export so the team can call them to collect a WhatsApp number.
  const noWhatsappRows = (results?.commitResults || []).filter((r) => r.status === 'created' && r.whatsapp_unreachable === true)
  const sendsRan = (results?.commitResults || []).some((r) => r.whatsapp_unreachable !== null && r.whatsapp_unreachable !== undefined)
  const downloadNoWhatsapp = () => {
    const rowByIndex = new Map(canonicalRows.map((r) => [r._index, r]))
    const lines = noWhatsappRows.map((r) => {
      const src = rowByIndex.get(r.row_index) || {}
      return {
        row: r.row_index + 2,
        name: r.name || src.name || '',
        phone: r.phone || src.phone || '',
        email: r.email || src.email || '',
        reason: r.welcome_reason || 'no_whatsapp',
      }
    })
    if (!lines.length) { toast('No no-WhatsApp candidates 🎉'); return }
    downloadBlob(rowsToCsvBlob(lines, ['row', 'name', 'phone', 'email', 'reason']), 'bulk-import-no-whatsapp.csv')
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto">
      <PageHeader
        icon={Upload}
        title="Bulk import applications"
        subtitle="Import existing agency applications from Excel/CSV — project by project"
        actions={<Button variant="secondary" onClick={() => navigate('/applications')}>Back to Applications</Button>}
      />

      <Stepper step={step} />

      {/* STEP 1 — Project */}
      {step === 0 && (
        <Card className="space-y-5">
          <div>
            <h3 className="font-bold text-zinc-900 dark:text-zinc-50">1. Choose the project</h3>
            <p className="text-sm text-zinc-500 mt-1">Applications import into one project at a time. Each row's <code>job_title</code> resolves a job inside this project; rows with no job use the default below.</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Project *</span>
              <select
                value={projectId}
                onChange={(e) => { setProjectId(e.target.value); setDefaultJobId('') }}
                className="mt-1 w-full rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
              >
                <option value="">Select a project…</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.title}{p.client_name ? ` — ${p.client_name}` : ''}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Default job (optional)</span>
              <select
                value={defaultJobId}
                onChange={(e) => setDefaultJobId(e.target.value)}
                disabled={!projectId}
                className="mt-1 w-full rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm disabled:opacity-50"
              >
                <option value="">Use each row's job_title</option>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
              </select>
            </label>
          </div>
          <div className="flex justify-end">
            <Button disabled={!projectId} onClick={() => setStep(1)}>Next <ArrowRight size={15} /></Button>
          </div>
        </Card>
      )}

      {/* STEP 2 — Spreadsheet */}
      {step === 1 && (
        <Card className="space-y-5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h3 className="font-bold text-zinc-900 dark:text-zinc-50">2. Upload the spreadsheet</h3>
              <p className="text-sm text-zinc-500 mt-1">CSV or Excel (.xlsx). One row per application.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => downloadBlob(buildTemplateWorkbook(), 'bulk-import-template.xlsx')}>
                <Download size={14} /> Template .xlsx
              </Button>
              <Button variant="ghost" size="sm" onClick={() => downloadBlob(buildTemplateCsv(), 'bulk-import-template.csv')}>
                <Download size={14} /> .csv
              </Button>
            </div>
          </div>

          <div {...sheetDrop.getRootProps()} className={`rounded-3xl border-2 border-dashed p-8 text-center transition ${sheetDrop.isDragActive ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-950/30' : 'border-zinc-300 dark:border-zinc-700'}`}>
            <input {...sheetDrop.getInputProps()} />
            <FileSpreadsheet className="mx-auto text-primary-500" size={32} />
            <p className="mt-2 font-semibold text-zinc-800 dark:text-zinc-100">{fileName || 'Drop your .xlsx / .csv here'}</p>
            <p className="text-sm text-zinc-500">{rawRows.length ? `${rawRows.length} rows parsed` : 'or'}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={sheetDrop.open}>Choose file</Button>
          </div>

          {parseError && <p className="text-sm font-medium text-red-600 flex items-center gap-1"><AlertTriangle size={14} /> {parseError}</p>}

          {rawHeaders.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Confirm column mapping</h4>
              <div className="grid sm:grid-cols-2 gap-2">
                {rawHeaders.map((h) => (
                  <div key={h} className="flex items-center gap-2 text-sm">
                    <span className="truncate flex-1 text-zinc-600 dark:text-zinc-300" title={h}>{h}</span>
                    <ArrowRight size={13} className="text-zinc-400 shrink-0" />
                    <select
                      value={headerMap[h] || ''}
                      onChange={(e) => setColumnMapping(h, e.target.value)}
                      className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs w-44"
                    >
                      <option value="">— ignore —</option>
                      {CANONICAL_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                ))}
              </div>
              {(!hasName || !hasPhone) && (
                <p className="text-sm font-medium text-amber-700 flex items-center gap-1">
                  <AlertTriangle size={14} /> Map both <b>name</b> and <b>phone</b> to continue.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}><ArrowLeft size={15} /> Back</Button>
            <Button disabled={!rawRows.length || !hasName || !hasPhone} onClick={() => setStep(2)}>Next <ArrowRight size={15} /></Button>
          </div>
        </Card>
      )}

      {/* STEP 3 — CVs */}
      {step === 2 && (
        <Card className="space-y-5">
          <div>
            <h3 className="font-bold text-zinc-900 dark:text-zinc-50">3. Attach CVs <span className="text-sm font-normal text-zinc-500">(optional)</span></h3>
            <p className="text-sm text-zinc-500 mt-1">Upload one ZIP of CVs, or pick a folder. Files match each row by <code>cv_filename</code>, falling back to <code>&lt;phone&gt;.ext</code>. Rows with no CV still import (flagged for Awaiting-CV).</p>
          </div>

          <div {...cvDrop.getRootProps()} className={`rounded-3xl border-2 border-dashed p-8 text-center transition ${cvDrop.isDragActive ? 'border-primary-500 bg-primary-50/60 dark:bg-primary-950/30' : 'border-zinc-300 dark:border-zinc-700'}`}>
            <input {...cvDrop.getInputProps()} />
            <FolderArchive className="mx-auto text-primary-500" size={32} />
            <p className="mt-2 font-semibold text-zinc-800 dark:text-zinc-100">{unzipping ? 'Reading files…' : 'Drop a .zip of CVs here'}</p>
            <div className="mt-3 flex items-center justify-center gap-2">
              <Button variant="secondary" size="sm" onClick={cvDrop.open} disabled={unzipping}>Choose ZIP / files</Button>
              <Button variant="ghost" size="sm" onClick={() => folderInputRef.current?.click()} disabled={unzipping}>Pick a folder</Button>
              <input
                ref={folderInputRef} type="file" webkitdirectory="" directory="" multiple hidden
                onChange={(e) => ingestCvFiles(Array.from(e.target.files || []))}
              />
            </div>
          </div>

          {matchReport && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatTile label="CV files loaded" value={cvFileCount} />
              <StatTile label="Rows matched" value={matchReport.matched} tone="green" />
              <StatTile label="Rows w/o CV" value={canonicalRows.length - matchReport.matched} tone="amber" />
              <StatTile label="Unused files" value={matchReport.unmatchedFiles.length} tone={matchReport.unmatchedFiles.length ? 'amber' : 'zinc'} />
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}><ArrowLeft size={15} /> Back</Button>
            <Button onClick={runDryRun} loading={validating}>Validate <ArrowRight size={15} /></Button>
          </div>
        </Card>
      )}

      {/* STEP 4 — Review (dry run) */}
      {step === 3 && dryRun && (
        <Card className="space-y-5">
          <div>
            <h3 className="font-bold text-zinc-900 dark:text-zinc-50">4. Review before import</h3>
            <p className="text-sm text-zinc-500 mt-1">Nothing has been written yet. Duplicates are skipped; everything else is created as a <b>Certified</b> application.</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatTile label="Total rows" value={dryRun.total} />
            <StatTile label="Will create" value={dryRun.will_create} tone="green" />
            <StatTile label="In-file dups" value={dryRun.in_file_dups} tone="amber" />
            <StatTile label="System dups" value={dryRun.db_dups} tone="amber" />
            <StatTile label="No CV" value={dryRun.missing_cv} tone={dryRun.missing_cv ? 'amber' : 'zinc'} />
            <StatTile label="Unresolved job" value={dryRun.unresolved_job} tone={dryRun.unresolved_job ? 'red' : 'zinc'} />
          </div>

          {(dryRun.db_dups > 0 || dryRun.in_file_dups > 0) && (
            <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 px-4 py-3 text-sm text-amber-800 dark:text-amber-300 flex items-start gap-2">
              <FileWarning size={16} className="mt-0.5 shrink-0" />
              <span><b>{dryRun.db_dups + dryRun.in_file_dups} duplicate(s)</b> will be skipped ({dryRun.db_dups} already in the system, {dryRun.in_file_dups} repeated in the file). The system records are kept untouched.</span>
            </div>
          )}
          {dryRun.errors > 0 && (
            <div className="rounded-2xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              {dryRun.errors} row(s) have a missing name or invalid phone and will be reported, not imported.
            </div>
          )}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(2)}><ArrowLeft size={15} /> Back</Button>
            <Button disabled={dryRun.will_create === 0} onClick={() => runCommit(0)}>
              Import {dryRun.will_create} application{dryRun.will_create === 1 ? '' : 's'} <ArrowRight size={15} />
            </Button>
          </div>
        </Card>
      )}

      {/* STEP 5 — Commit progress */}
      {step === 4 && (
        <Card className="space-y-5">
          <h3 className="font-bold text-zinc-900 dark:text-zinc-50">5. Importing…</h3>
          <div className="space-y-2">
            <div className="flex justify-between text-sm text-zinc-600 dark:text-zinc-300">
              <span>{commit.done} / {commit.total} rows</span>
              <span>batch {Math.min(commit.batchIndex, commit.totalBatches)} / {commit.totalBatches}</span>
            </div>
            <div className="h-3 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div className="h-full bg-brand-gradient transition-all" style={{ width: `${commit.total ? Math.round((commit.done / commit.total) * 100) : 0}%` }} />
            </div>
          </div>
          {commit.running && <p className="text-sm text-zinc-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Uploading and creating records…</p>}
          {commit.error && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-red-600 flex items-center gap-1"><AlertTriangle size={14} /> {commit.error}</p>
              <Button onClick={() => runCommit(commit.resumeFrom)}>Retry from batch {commit.resumeFrom + 1}</Button>
            </div>
          )}
        </Card>
      )}

      {/* STEP 6 — Results */}
      {step === 5 && results && (
        <Card className="space-y-5">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="text-emerald-500" size={22} />
            <h3 className="font-bold text-zinc-900 dark:text-zinc-50">Import complete</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatTile label="Created (Certified)" value={results.summary.created} tone="green" />
            <StatTile label="CVs attached" value={results.summary.cv_attached} />
            <StatTile label="Skipped duplicates" value={results.summary.skipped} tone="amber" />
            <StatTile label="Errors" value={results.summary.error} tone={results.summary.error ? 'red' : 'zinc'} />
          </div>

          <div className="rounded-2xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/50 px-4 py-3 text-sm text-blue-800 dark:text-blue-300 flex items-start gap-2">
            <CalendarCheck size={16} className="mt-0.5 shrink-0" />
            <span>All imported applications are <b>Certified</b>. Open them in Applications, select a group, and bulk-schedule interviews (up to 100 per schedule).</span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={downloadReport}><Download size={14} /> Download skipped/errors CSV</Button>
            {sendsRan && (
              <Button variant="secondary" onClick={downloadNoWhatsapp}>
                <FileWarning size={14} /> No-WhatsApp list ({noWhatsappRows.length})
              </Button>
            )}
            <Link to={`/applications?project_id=${projectId}&status=certified`}>
              <Button><Users size={14} /> Go schedule interviews</Button>
            </Link>
            <Button variant="ghost" onClick={() => window.location.reload()}>Import another batch</Button>
          </div>
        </Card>
      )}
    </div>
  )
}
