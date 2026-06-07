/**
 * Bulk Application Import — client-side helpers
 * =============================================
 * Spreadsheet parsing (CSV via papaparse, XLSX via SheetJS), header normalization
 * with an alias map, CV file matching (ZIP unzip via fflate, or a selected
 * folder), request batching under the Cloud Run 32MB cap, and template / report
 * generation. The backend (services/bulk-import-service.js) re-validates and does
 * the authoritative coercion — these helpers exist to drive the wizard UX
 * (preview / column-mapping / dry-run / batched commit).
 */

import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { unzipSync } from 'fflate'

// Canonical columns in template order. Required: name, phone.
export const TEMPLATE_COLUMNS = [
  'name', 'phone', 'email', 'job_title', 'cv_filename', 'applied_date',
  'preferred_language', 'experience_years', 'highest_qualification', 'skills',
  'age', 'gender', 'nationality', 'current_location', 'destination_country',
  'labels', 'notes', 'source',
]

export const REQUIRED_COLUMNS = ['name', 'phone']

// Every canonical field the importer understands (TEMPLATE_COLUMNS + the
// informational application_status). Used to populate the column-mapping dropdowns.
export const CANONICAL_FIELDS = [...TEMPLATE_COLUMNS, 'application_status']

export const COLUMN_HELP = {
  name: 'Required. Full name.',
  phone: 'Required. Any format — normalized server-side. Duplicate key.',
  email: 'Secondary duplicate key.',
  job_title: 'Job within the chosen project. Blank → wizard default job.',
  cv_filename: 'CV filename inside the ZIP. Blank → tries <phone>.<ext>.',
  applied_date: 'YYYY-MM-DD.',
  preferred_language: 'en / si / ta (default en).',
  experience_years: 'Whole number.',
  highest_qualification: 'Free text.',
  skills: 'Separate with ; or ,',
  age: 'Whole number.',
  gender: 'Male / Female.',
  nationality: 'Free text.',
  current_location: 'City / area.',
  destination_country: 'Preferred destination.',
  labels: 'Separate with ; → becomes candidate labels/tags.',
  notes: 'Free text.',
  source: 'Origin tag (default import).',
  application_status: 'Informational — all imports are created Certified.',
}

// Header token → canonical field. Keys are normalized (lowercased, spaces/hyphens
// → underscore). Lets "Full Name", "Mobile", "Resume" map correctly.
const HEADER_ALIASES = {
  name: 'name', full_name: 'name', candidate_name: 'name', applicant: 'name', applicant_name: 'name',
  phone: 'phone', phone_number: 'phone', mobile: 'phone', mobile_number: 'phone', contact: 'phone',
  contact_number: 'phone', whatsapp: 'phone', whatsapp_number: 'phone', tel: 'phone', telephone: 'phone',
  email: 'email', e_mail: 'email', email_address: 'email',
  job_title: 'job_title', job: 'job_title', position: 'job_title', role: 'job_title',
  applied_for: 'job_title', vacancy: 'job_title', designation: 'job_title',
  cv_filename: 'cv_filename', cv: 'cv_filename', cv_file: 'cv_filename', cv_file_name: 'cv_filename',
  resume: 'cv_filename', resume_file: 'cv_filename', file: 'cv_filename', attachment: 'cv_filename',
  applied_date: 'applied_date', application_date: 'applied_date', applied_on: 'applied_date',
  date: 'applied_date', date_applied: 'applied_date',
  preferred_language: 'preferred_language', language: 'preferred_language', lang: 'preferred_language',
  experience_years: 'experience_years', experience: 'experience_years', years_experience: 'experience_years',
  exp_years: 'experience_years', years_of_experience: 'experience_years',
  highest_qualification: 'highest_qualification', qualification: 'highest_qualification',
  education: 'highest_qualification', highest_education: 'highest_qualification',
  skills: 'skills', skill: 'skills',
  age: 'age',
  gender: 'gender', sex: 'gender',
  nationality: 'nationality', country: 'nationality',
  current_location: 'current_location', location: 'current_location', city: 'current_location', address: 'current_location',
  destination_country: 'destination_country', destination: 'destination_country',
  target_country: 'destination_country', preferred_country: 'destination_country',
  labels: 'labels', label: 'labels', tags: 'labels', tag: 'labels',
  notes: 'notes', note: 'notes', remarks: 'notes', remark: 'notes', comments: 'notes', comment: 'notes',
  source: 'source',
  application_status: 'application_status', status: 'application_status', stage: 'application_status',
  pipeline_status: 'application_status',
}

function normalizeHeaderToken(h) {
  return String(h == null ? '' : h)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Map detected headers → canonical fields. Returns assignments the UI renders as
 * editable dropdowns (so the user can correct a mis-guess) plus the auto-detected
 * lookup.
 */
export function normalizeHeaders(rawHeaders) {
  const assignments = rawHeaders.map((original) => {
    const token = normalizeHeaderToken(original)
    const canonical = HEADER_ALIASES[token] || null
    return { original, canonical }
  })
  // original header → canonical (only mapped ones)
  const map = {}
  assignments.forEach((a) => { if (a.canonical) map[a.original] = a.canonical })
  const unmapped = assignments.filter((a) => !a.canonical).map((a) => a.original)
  const missingRequired = REQUIRED_COLUMNS.filter(
    (c) => !assignments.some((a) => a.canonical === c)
  )
  return { assignments, map, unmapped, missingRequired }
}

function basename(p) {
  return String(p || '').split(/[\\/]/).pop()
}

/**
 * Parse a .csv (papaparse) or .xlsx/.xls (SheetJS) File into
 * { headers: string[], rows: Array<object keyed by original header> }.
 */
export async function parseSpreadsheet(file) {
  const name = (file.name || '').toLowerCase()
  const isCsv = name.endsWith('.csv') || file.type === 'text/csv'

  if (isCsv) {
    const text = await file.text()
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' })
    const headers = parsed.meta?.fields || []
    const rows = (parsed.data || []).filter((r) => Object.values(r).some((v) => String(v ?? '').trim() !== ''))
    return { headers, rows }
  }

  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  // raw:false → cells come back as their DISPLAYED text, so text-formatted phone
  // numbers keep leading zeros and date cells become readable date strings
  // (rather than Excel serial numbers).
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false, raw: false })
  if (!matrix.length) return { headers: [], rows: [] }
  const headers = matrix[0].map((h) => String(h ?? '').trim())
  const rows = []
  for (let i = 1; i < matrix.length; i++) {
    const arr = matrix[i]
    if (!arr || !arr.some((v) => String(v ?? '').trim() !== '')) continue
    const obj = {}
    headers.forEach((h, c) => { obj[h] = arr[c] ?? '' })
    rows.push(obj)
  }
  return { headers, rows }
}

/**
 * Build canonical rows from raw objects + a {originalHeader: canonicalField} map.
 * Each row gets a stable `_index` (its position in the file) used to key CV files
 * and verdicts end-to-end.
 */
export function mapRowsToCanonical(rawRows, headerMap) {
  return rawRows.map((raw, i) => {
    const row = { _index: i }
    Object.entries(headerMap).forEach(([original, canonical]) => {
      if (!canonical) return
      const v = raw[original]
      row[canonical] = v == null ? '' : String(v).trim()
    })
    return row
  })
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '')
}

/**
 * Read a .zip File into an array of File objects (one per entry, directories
 * skipped). Used so the rest of the pipeline treats ZIP entries and folder
 * selections uniformly as File[].
 */
export async function unzipToFiles(zipFile) {
  const buf = new Uint8Array(await zipFile.arrayBuffer())
  const entries = unzipSync(buf)
  const files = []
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith('/') || !bytes || bytes.length === 0) continue
    const base = basename(path)
    if (!base || base.startsWith('.')) continue // skip dotfiles / __MACOSX noise
    files.push(new File([bytes], base))
  }
  return files
}

/**
 * Match CV File[] to canonical rows. Primary: row.cv_filename (case-insensitive
 * basename). Fallback: a file named by the row's phone digits. Mutates rows with
 * `cvFile` + `cv_present`, and returns the unmatched sets for reporting.
 */
export function matchFilesToRows(rows, files) {
  const byName = new Map()      // lower basename → File
  const byDigits = new Map()    // digits of name-without-ext → File
  const duplicateNames = []
  const claimed = new Set()

  for (const f of files) {
    const base = basename(f.name).toLowerCase()
    if (byName.has(base)) duplicateNames.push(f.name)
    else byName.set(base, f)
    const stem = base.replace(/\.[a-z0-9]+$/i, '')
    const d = digitsOnly(stem)
    if (d && !byDigits.has(d)) byDigits.set(d, f)
  }

  let matched = 0
  const unmatchedRows = []
  for (const row of rows) {
    let file = null
    const wanted = basename(row.cv_filename || '').toLowerCase()
    if (wanted) file = byName.get(wanted) || null
    if (!file) {
      const d = digitsOnly(row.phone)
      if (d) {
        file = byDigits.get(d) || null
        if (!file && d.length >= 9) {
          // try last 9 digits (drop country code variants)
          const tail = d.slice(-9)
          for (const [k, v] of byDigits) {
            if (k.endsWith(tail)) { file = v; break }
          }
        }
      }
    }
    row.cvFile = file
    row.cv_present = !!file
    if (file) { matched++; claimed.add(file) }
    else if (wanted) unmatchedRows.push(row)
  }

  const unmatchedFiles = files.filter((f) => !claimed.has(f))
  return { matched, unmatchedRows, unmatchedFiles, duplicateNames }
}

const MB = 1024 * 1024
const DEFAULT_MAX_ROWS = 25
const DEFAULT_MAX_BYTES = 20 * MB // headroom under the Cloud Run 32MB request cap

/**
 * Slice rows into commit batches honoring min(maxRows, maxBytes). A row's byte
 * cost is its CV file size. Rows stay in file order so a failed run can resume by
 * batch index.
 */
export function buildBatches(rows, { maxRows = DEFAULT_MAX_ROWS, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const batches = []
  let current = []
  let bytes = 0
  for (const row of rows) {
    const cost = row.cvFile ? (row.cvFile.size || 0) : 0
    const wouldExceed = current.length >= maxRows || (current.length > 0 && bytes + cost > maxBytes)
    if (wouldExceed) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(row)
    bytes += cost
  }
  if (current.length) batches.push(current)
  return batches
}

// Strip the File handle before JSON-serializing a row for the commit payload.
export function stripRowForPayload(row) {
  const { cvFile, ...rest } = row
  return rest
}

const EXAMPLE_ROWS = [
  {
    name: 'John Silva', phone: '0771234567', email: 'john@gmail.com', job_title: 'Security Guard',
    cv_filename: 'john_silva_cv.pdf', applied_date: '2026-03-14', preferred_language: 'en',
    experience_years: '5', highest_qualification: 'Diploma in Security', skills: 'Surveillance; First Aid; English',
    age: '28', gender: 'Male', nationality: 'Sri Lankan', current_location: 'Colombo',
    destination_country: 'UAE', labels: 'urgent; excellent_english', notes: 'Referred by agent Dewan', source: 'agency_import',
  },
  {
    name: 'Nadeesha Perera', phone: '0719876543', email: '', job_title: 'Cleaner',
    cv_filename: 'nadeesha_cv.pdf', applied_date: '2026-03-15', preferred_language: 'si',
    experience_years: '2', highest_qualification: 'O/L', skills: 'Cleaning; Cooking',
    age: '24', gender: 'Female', nationality: 'Sri Lankan', current_location: 'Gampaha',
    destination_country: 'Qatar', labels: '', notes: 'Available immediately', source: 'agency_import',
  },
]

const INSTRUCTIONS = [
  ['Column', 'Required', 'Notes'],
  ...TEMPLATE_COLUMNS.map((c) => [c, REQUIRED_COLUMNS.includes(c) ? 'YES' : 'optional', COLUMN_HELP[c] || '']),
  ['', '', ''],
  ['CV files', '', 'Put all CVs in one ZIP/folder per project. Name each file to match cv_filename, or by phone (e.g. 94771234567.pdf).'],
  ['Duplicates', '', 'Rows whose phone/email already exist (or repeat in the file) are skipped and reported.'],
  ['Status', '', 'Every imported application is created as Certified — schedule interviews afterwards.'],
]

/** Build the .xlsx template (Applications + Instructions sheets) as a Blob. */
export function buildTemplateWorkbook() {
  const wb = XLSX.utils.book_new()
  const appsAoa = [TEMPLATE_COLUMNS, ...EXAMPLE_ROWS.map((r) => TEMPLATE_COLUMNS.map((c) => r[c] ?? ''))]
  const wsApps = XLSX.utils.aoa_to_sheet(appsAoa)
  XLSX.utils.book_append_sheet(wb, wsApps, 'Applications')
  const wsHelp = XLSX.utils.aoa_to_sheet(INSTRUCTIONS)
  XLSX.utils.book_append_sheet(wb, wsHelp, 'Instructions')
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

/** Plain-CSV template variant. */
export function buildTemplateCsv() {
  const csv = Papa.unparse({ fields: TEMPLATE_COLUMNS, data: EXAMPLE_ROWS.map((r) => TEMPLATE_COLUMNS.map((c) => r[c] ?? '')) })
  return new Blob([csv], { type: 'text/csv;charset=utf-8' })
}

/** Serialize an array of plain objects to a CSV Blob (skipped/errors report). */
export function rowsToCsvBlob(rows, columns) {
  const csv = Papa.unparse(columns ? { fields: columns, data: rows.map((r) => columns.map((c) => r[c] ?? '')) } : rows)
  return new Blob([csv], { type: 'text/csv;charset=utf-8' })
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
