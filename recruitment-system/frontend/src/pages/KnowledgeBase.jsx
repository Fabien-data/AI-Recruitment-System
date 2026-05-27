import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDropzone } from 'react-dropzone'
import {
  Plus, Search, RefreshCw, BookOpen, Trash2, Edit3, Loader2, Languages, RadioTower,
  FileText, UploadCloud, FileType, AlertCircle, CheckCircle2, Hash, Clock,
} from 'lucide-react'
import toast from 'react-hot-toast'
import Papa from 'papaparse'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { PageHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { ConfirmModal, Modal } from '../components/ui/Modal'
import { Input } from '../components/ui/Input'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Tabs } from '../components/ui/Tabs'
import { Table } from '../components/ui/Table'
import { EmptyState } from '../components/ui/EmptyState'
import { Pagination } from '../components/ui/Pagination'
import {
  createKnowledgeBaseEntry,
  deleteKnowledgeBaseEntry,
  deleteKnowledgeDocument,
  fullResyncChatbot,
  getKnowledgeBaseCategories,
  getKnowledgeBaseEntries,
  getKnowledgeDocuments,
  importKnowledgeBaseEntries,
  updateKnowledgeBaseEntry,
  uploadKnowledgeDocument,
} from '../api'

const emptyForm = {
  category: 'general',
  question_en: '',
  question_si: '',
  question_ta: '',
  answer_en: '',
  answer_si: '',
  answer_ta: '',
  keywords: '',
  priority: 0,
  is_active: true,
}

function splitKeywords(value) {
  return String(value || '')
    .split(/[|,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function safeParseJsonArray(text) {
  const parsed = JSON.parse(String(text || '').trim())
  if (!Array.isArray(parsed)) {
    throw new Error('Import data must be a JSON array')
  }
  return parsed
}

function safeParseCsvArray(text) {
  const result = Papa.parse(String(text || '').trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => String(header || '').trim(),
  })

  if (result.errors?.length) {
    throw new Error(result.errors[0].message || 'Invalid CSV input')
  }

  if (!Array.isArray(result.data)) {
    throw new Error('Import data must be a CSV table')
  }

  return result.data.filter((row) => Object.values(row).some((value) => String(value || '').trim().length > 0))
}

function normalizeImportedEntry(entry) {
  return {
    category: entry.category || 'general',
    question_en: entry.question_en || entry.question || '',
    question_si: entry.question_si || '',
    question_ta: entry.question_ta || '',
    answer_en: entry.answer_en || entry.answer || '',
    answer_si: entry.answer_si || '',
    answer_ta: entry.answer_ta || '',
    keywords: Array.isArray(entry.keywords) ? entry.keywords : splitKeywords(entry.keywords),
    priority: Number(entry.priority) || 0,
  }
}

function EntryEditorModal({ open, onClose, mode, entry, onSubmit, loading }) {
  const [form, setForm] = useState(emptyForm)

  useEffect(() => {
    if (!open) return

    setForm(
      entry
        ? {
            category: entry.category || 'general',
            question_en: entry.question_en || '',
            question_si: entry.question_si || '',
            question_ta: entry.question_ta || '',
            answer_en: entry.answer_en || '',
            answer_si: entry.answer_si || '',
            answer_ta: entry.answer_ta || '',
            keywords: Array.isArray(entry.keywords) ? entry.keywords.join(', ') : (entry.keywords || ''),
            priority: entry.priority ?? 0,
            is_active: entry.is_active ?? true,
          }
        : emptyForm
    )
  }, [open, entry])

  const submit = (e) => {
    e.preventDefault()
    onSubmit({
      ...form,
      keywords: splitKeywords(form.keywords),
      priority: Number(form.priority) || 0,
      is_active: !!form.is_active,
    })
  }

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit Knowledge Entry' : 'Create Knowledge Entry'} size="xl">
      <form onSubmit={submit} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} required />
          <Input label="Priority" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Input label="Question (English)" value={form.question_en} onChange={(e) => setForm({ ...form, question_en: e.target.value })} required />
          <Input label="Question (Sinhala)" value={form.question_si} onChange={(e) => setForm({ ...form, question_si: e.target.value })} />
          <Input label="Question (Tamil)" value={form.question_ta} onChange={(e) => setForm({ ...form, question_ta: e.target.value })} />
          <Input label="Keywords" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="salary, visa, accommodation" />
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">Answer (English)</label>
            <textarea
              className="w-full min-h-28 px-4 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all"
              value={form.answer_en}
              onChange={(e) => setForm({ ...form, answer_en: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">Answer (Sinhala)</label>
            <textarea
              className="w-full min-h-24 px-4 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all"
              value={form.answer_si}
              onChange={(e) => setForm({ ...form, answer_si: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">Answer (Tamil)</label>
            <textarea
              className="w-full min-h-24 px-4 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all"
              value={form.answer_ta}
              onChange={(e) => setForm({ ...form, answer_ta: e.target.value })}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-700">
          <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
          Entry is active
        </label>

        <div className="flex justify-end gap-3">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            {mode === 'edit' ? 'Save Changes' : 'Create Entry'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function ImportModal({ open, onClose, onImport, loading }) {
  const [inputMode, setInputMode] = useState('json')
  const [jsonText, setJsonText] = useState('')
  const [fileName, setFileName] = useState('')
  const [previewCount, setPreviewCount] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) {
      return
    }

    setInputMode('json')
    setJsonText(`[
  {
    "category": "salary",
    "question_en": "What is the salary?",
    "answer_en": "Salary depends on the role and candidate profile.",
    "keywords": ["salary", "pay", "wage"],
    "priority": 10
  }
]`)
    setFileName('')
    setPreviewCount(1)
    setError('')
  }, [open])

  const updatePreview = (value) => {
    setJsonText(value)
    setError('')

    try {
      const entries = inputMode === 'csv' ? safeParseCsvArray(value) : safeParseJsonArray(value)
      setPreviewCount(entries.length)
    } catch (_error) {
      setPreviewCount(0)
    }
  }

  const setMode = (mode) => {
    setInputMode(mode)
    setError('')

    if (mode === 'csv') {
      setJsonText(`category,question_en,answer_en,keywords,priority\nsalary,What is the salary?,Salary depends on the role.,salary|pay,10`)
      setPreviewCount(1)
      return
    }

    setJsonText(`[
  {
    "category": "salary",
    "question_en": "What is the salary?",
    "answer_en": "Salary depends on the role and candidate profile.",
    "keywords": ["salary", "pay", "wage"],
    "priority": 10
  }
]`)
    setPreviewCount(1)
  }

  const handleFile = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    const text = await file.text()
    setFileName(file.name)
    const detectedMode = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json'
    setInputMode(detectedMode)
    updatePreview(text)
  }

  const handleSubmit = (event) => {
    event.preventDefault()

    try {
      const entries = inputMode === 'csv' ? safeParseCsvArray(jsonText) : safeParseJsonArray(jsonText)
      onImport(entries)
    } catch (parseError) {
      setError(parseError.message || 'Invalid JSON input')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Bulk Import Knowledge Entries" size="xl">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 space-y-2">
          <p className="font-semibold text-zinc-900">Accepted format</p>
          <p>Paste or upload JSON or CSV. The imported rows are normalized into the same KB entry shape.</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={() => setMode('json')} className={`rounded-full px-3 py-1 text-xs font-semibold ${inputMode === 'json' ? 'bg-zinc-900 text-white' : 'bg-white dark:bg-zinc-900 text-zinc-700 border border-zinc-200'}`}>
              JSON
            </button>
            <button type="button" onClick={() => setMode('csv')} className={`rounded-full px-3 py-1 text-xs font-semibold ${inputMode === 'csv' ? 'bg-zinc-900 text-white' : 'bg-white dark:bg-zinc-900 text-zinc-700 border border-zinc-200'}`}>
              CSV
            </button>
          </div>
          <pre className="overflow-x-auto rounded-xl bg-zinc-950 p-3 text-xs text-zinc-100">
{`[
  {
    "category": "salary",
    "question_en": "What is the salary?",
    "answer_en": "Salary depends on the role.",
    "keywords": ["salary", "pay"],
    "priority": 10
  }
]`}
          </pre>
          {inputMode === 'csv' && (
            <pre className="overflow-x-auto rounded-xl bg-zinc-950 p-3 text-xs text-zinc-100">
{`category,question_en,answer_en,keywords,priority
salary,What is the salary?,Salary depends on the role.,salary|pay,10`}
            </pre>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="text-sm text-zinc-600">
            <p className="font-medium text-zinc-900">{previewCount} entries detected</p>
            {fileName && <p className="mt-1">Loaded from {fileName}</p>}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-zinc-200 bg-white dark:bg-zinc-900 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50">
            Load {inputMode.toUpperCase()} file
            <input type="file" accept={inputMode === 'csv' ? '.csv,text/csv' : 'application/json,.json'} className="hidden" onChange={handleFile} />
          </label>
        </div>

        <div>
          <label className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">
            Entries {inputMode.toUpperCase()}
          </label>
          <textarea
            value={jsonText}
            onChange={(e) => updatePreview(e.target.value)}
            className="w-full min-h-80 px-4 py-3 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all font-mono text-sm"
            spellCheck={false}
          />
          {error && <p className="mt-2 text-sm font-medium text-red-500">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-zinc-500">The imported entries are created using the same validation rules as manual entry.</p>
          <div className="flex gap-3">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={loading} disabled={previewCount === 0}>
              Import {previewCount || ''}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

export default function KnowledgeBase() {
  const queryClient = useQueryClient()
  const [view, setView] = useState('faq')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorMode, setEditorMode] = useState('create')
  const [activeEntry, setActiveEntry] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [importOpen, setImportOpen] = useState(false)

  const entriesQuery = useQuery({
    queryKey: ['knowledge-base', { page, search, category }],
    queryFn: () => getKnowledgeBaseEntries({ page, limit: 20, search: search || undefined, category: category || undefined }),
  })

  const categoriesQuery = useQuery({
    queryKey: ['knowledge-base-categories'],
    queryFn: getKnowledgeBaseCategories,
  })

  const createMutation = useMutation({
    mutationFn: createKnowledgeBaseEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-base'] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-base-categories'] })
      toast.success('Knowledge entry created')
      setEditorOpen(false)
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to create entry'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateKnowledgeBaseEntry(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-base'] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-base-categories'] })
      toast.success('Knowledge entry updated')
      setEditorOpen(false)
      setActiveEntry(null)
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to update entry'),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteKnowledgeBaseEntry,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-base'] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-base-categories'] })
      toast.success('Knowledge entry deleted')
      setDeleteTarget(null)
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to delete entry'),
  })

  const importMutation = useMutation({
    mutationFn: (entries) => importKnowledgeBaseEntries(entries),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-base'] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-base-categories'] })
      toast.success(`Imported ${result?.imported || 0} entries`)
      setImportOpen(false)
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to import entries'),
  })

  const resyncMutation = useMutation({
    mutationFn: fullResyncChatbot,
    onSuccess: (result) => {
      const j = result?.jobs ?? 0
      const p = result?.projects ?? 0
      const f = result?.faqs ?? 0
      toast.success(`Resync queued — jobs ${j} · projects ${p} · FAQs ${f}`)
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to enqueue resync'),
  })

  const entries = entriesQuery.data?.entries || []
  const pagination = entriesQuery.data?.pagination
  const categories = categoriesQuery.data || []

  const stats = useMemo(() => {
    const activeCount = entries.filter((entry) => entry.is_active !== false).length
    return { total: pagination?.total || 0, activeCount }
  }, [entries, pagination?.total])

  const openCreate = () => {
    setActiveEntry(null)
    setEditorMode('create')
    setEditorOpen(true)
  }

  const openEdit = (entry) => {
    setActiveEntry(entry)
    setEditorMode('edit')
    setEditorOpen(true)
  }

  const submitEntry = (data) => {
    if (editorMode === 'edit' && activeEntry?.id) {
      updateMutation.mutate({ id: activeEntry.id, data })
      return
    }

    createMutation.mutate(data)
  }

  const submitImport = (entries) => {
    if (!Array.isArray(entries) || entries.length === 0) {
      toast.error('Import file must contain at least one entry')
      return
    }

    const cleanedEntries = entries.map((entry) => normalizeImportedEntry(entry))

    const invalid = cleanedEntries.find((entry) => !entry.question_en || !entry.answer_en)
    if (invalid) {
      toast.error('Every imported entry needs question_en and answer_en')
      return
    }

    importMutation.mutate(cleanedEntries)
  }

  return (
    <div className="p-6 lg:p-8 animate-fade-in space-y-6">
      <PageHeader
        icon={BookOpen}
        tone="blue"
        title="Recruiter Knowledge Base"
        subtitle="Maintain synced answers that the chatbot can reuse instantly across new jobs and recruiter FAQs."
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => view === 'faq' ? entriesQuery.refetch() : queryClient.invalidateQueries({ queryKey: ['knowledge-documents'] })}
              loading={view === 'faq' && entriesQuery.isFetching}
            >
              {!(view === 'faq' && entriesQuery.isFetching) && <RefreshCw size={16} />}
              Refresh
            </Button>
            <Button
              variant="secondary"
              onClick={() => resyncMutation.mutate()}
              loading={resyncMutation.isPending}
              title="Re-enqueue every active job, project, and FAQ to the chatbot"
            >
              <RadioTower size={16} />
              Resync Chatbot
            </Button>
            {view === 'faq' && (
              <>
                <Button variant="secondary" onClick={() => setImportOpen(true)}>
                  <BookOpen size={16} />
                  Bulk Import
                </Button>
                <Button onClick={openCreate}>
                  <Plus size={16} />
                  New Entry
                </Button>
              </>
            )}
          </>
        }
      />

      <Tabs
        value={view}
        onChange={(v) => { setView(v); setPage(1) }}
        items={[
          { value: 'faq',  label: 'FAQ Entries', icon: BookOpen,  tone: 'blue' },
          { value: 'docs', label: 'Documents',   icon: FileText, tone: 'purple' },
        ]}
      />

      {view === 'docs' ? <DocumentsView /> : <>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card accent="blue" className="p-5">
          <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Total entries</p>
          <p className="mt-2 text-3xl font-bold text-zinc-900 dark:text-zinc-50">{stats.total}</p>
        </Card>
        <Card accent="blue" className="p-5">
          <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Active entries</p>
          <p className="mt-2 text-3xl font-bold text-zinc-900 dark:text-zinc-50">{stats.activeCount}</p>
        </Card>
        <Card accent="red" className="p-5">
          <p className="text-sm font-semibold text-zinc-500 dark:text-zinc-400">Categories</p>
          <p className="mt-2 text-3xl font-bold text-zinc-900 dark:text-zinc-50">{categories.length}</p>
        </Card>
      </div>

      <Card className="p-5 space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
            <input
              value={search}
              onChange={(e) => {
                setPage(1)
                setSearch(e.target.value)
              }}
              placeholder="Search questions, answers, or keywords"
              className="input w-full pl-11"
            />
          </div>
          <select
            value={category}
            onChange={(e) => {
              setPage(1)
              setCategory(e.target.value)
            }}
            className="input w-full"
          >
            <option value="">All categories</option>
            {categories.map((item) => (
              <option key={item.category} value={item.category}>
                {item.category} ({item.count})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2">
          {categories.slice(0, 8).map((item) => (
            <button
              key={item.category}
              type="button"
              onClick={() => setCategory(item.category)}
              className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              {item.category}
            </button>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        {entriesQuery.isLoading ? (
          <TableSkeleton rows={6} cols={6} />
        ) : entries.length === 0 ? (
          <div className="py-16 text-center">
            <Languages className="mx-auto mb-3 text-zinc-300" size={40} />
            <p className="text-lg font-semibold text-zinc-900">No knowledge entries found</p>
            <p className="text-sm text-zinc-500 mt-1">Create the first FAQ or clear your filters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50/80">
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700">Category</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700">Question</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700">Answer</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700">Keywords</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold text-zinc-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b border-zinc-100 hover:bg-zinc-50/70 transition-colors">
                    <td className="py-4 px-4 align-top">
                      <Badge status={entry.category}>{entry.category}</Badge>
                    </td>
                    <td className="py-4 px-4 align-top text-zinc-900 font-medium max-w-[260px]">
                      <div className="line-clamp-2">{entry.question_en}</div>
                      <p className="mt-1 text-xs text-zinc-500">Priority {entry.priority ?? 0} · Usage {entry.usage_count ?? 0}</p>
                    </td>
                    <td className="py-4 px-4 align-top text-zinc-600 max-w-[420px]">
                      <div className="line-clamp-3">{entry.answer_en}</div>
                    </td>
                    <td className="py-4 px-4 align-top text-zinc-500 text-sm max-w-[220px]">
                      {Array.isArray(entry.keywords) ? entry.keywords.join(', ') : String(entry.keywords || '')}
                    </td>
                    <td className="py-4 px-4 align-top">
                      <Badge status={entry.is_active === false ? 'paused' : 'active'}>{entry.is_active === false ? 'Inactive' : 'Active'}</Badge>
                    </td>
                    <td className="py-4 px-4 align-top">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" size="sm" onClick={() => openEdit(entry)}>
                          <Edit3 size={14} />
                          Edit
                        </Button>
                        <Button variant="danger" size="sm" onClick={() => setDeleteTarget(entry)}>
                          <Trash2 size={14} />
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pagination && pagination.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-4 border-t border-zinc-100">
            <p className="text-sm text-zinc-500">
              Page {pagination.page} of {pagination.pages}
            </p>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" disabled={page >= pagination.pages} onClick={() => setPage((current) => Math.min(pagination.pages, current + 1))}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      </>}

      <EntryEditorModal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        mode={editorMode}
        entry={activeEntry}
        onSubmit={submitEntry}
        loading={createMutation.isPending || updateMutation.isPending}
      />

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        title="Delete knowledge entry"
        message={`Delete the entry for "${deleteTarget?.question_en || 'this question'}"? This cannot be undone.`}
        loading={deleteMutation.isPending}
      />

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={submitImport}
        loading={importMutation.isPending}
      />
    </div>
  )
}

// ── Documents view ──────────────────────────────────────────────────────────

const DOC_STATUS_META = {
  pending:    { label: 'Pending',    tone: 'amber',   icon: Clock },
  processing: { label: 'Processing', tone: 'blue',    icon: Loader2 },
  parsed:     { label: 'Parsed',     tone: 'emerald', icon: CheckCircle2 },
  failed:     { label: 'Failed',     tone: 'rose',    icon: AlertCircle },
}

const DOC_STATUS_PILL = {
  amber:   'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 ring-amber-200 dark:ring-amber-900/60',
  blue:    'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 ring-blue-200 dark:ring-blue-900/60',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-900/60',
  rose:    'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 ring-rose-200 dark:ring-rose-900/60',
}

function DocStatusPill({ status }) {
  const meta = DOC_STATUS_META[status] || { label: status || 'unknown', tone: 'blue', icon: Hash }
  const Icon = meta.icon
  return (
    <span className={`inline-flex items-center gap-1 rounded-full ring-1 ring-inset px-2 py-0.5 text-[11px] font-semibold ${DOC_STATUS_PILL[meta.tone]}`}>
      <Icon size={10} className={status === 'processing' ? 'animate-spin' : ''} />
      {meta.label}
    </span>
  )
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function DocsUploadZone({ onUpload, isUploading }) {
  const onDrop = useCallback(async (acceptedFiles) => {
    for (const file of acceptedFiles) {
      // Upload one at a time so errors surface per file
      try {
        await onUpload(file)
      } catch {
        // Toast is shown by the mutation; just continue with next file
      }
    }
  }, [onUpload])

  const { getRootProps, getInputProps, isDragActive, open: openPicker } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'text/plain': ['.txt'],
    },
    multiple: true,
    noClick: true,
    noKeyboard: true,
    disabled: isUploading,
  })

  return (
    <div
      {...getRootProps()}
      className={`relative rounded-3xl border-2 border-dashed transition-all p-6 md:p-8 ${
        isDragActive
          ? 'border-primary-500 bg-primary-50/70 dark:bg-primary-950/30'
          : 'border-zinc-300 dark:border-zinc-700 bg-gradient-to-br from-blue-50/40 via-white to-white dark:from-blue-950/20 dark:via-zinc-900 dark:to-zinc-900 hover:border-primary-400'
      }`}
    >
      <input {...getInputProps()} />
      <div className="flex flex-col items-center text-center gap-3">
        <div className="rounded-2xl bg-gradient-to-br from-primary-500 to-indigo-600 p-3 text-white shadow-lg">
          <UploadCloud size={28} />
        </div>
        <div>
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-50">
            {isDragActive ? 'Drop files to upload' : 'Drop PDF, DOCX, or TXT here'}
          </h3>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
            We extract the text, split it into searchable chunks, and feed each chunk to the chatbot. Max 10MB per file.
          </p>
        </div>
        <Button variant="primary" onClick={openPicker} loading={isUploading} disabled={isUploading}>
          <UploadCloud size={15} />
          Choose files
        </Button>
      </div>
    </div>
  )
}

function DocumentsView() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const docsQuery = useQuery({
    queryKey: ['knowledge-documents', { page }],
    queryFn: () => getKnowledgeDocuments({ page, limit: 20 }),
  })

  const uploadMutation = useMutation({
    mutationFn: (file) => uploadKnowledgeDocument(file),
    onSuccess: (doc) => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-documents'] })
      toast.success(`Parsed "${doc.title}" into ${doc.chunk_count} chunks`)
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to upload document')
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteKnowledgeDocument(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge-documents'] })
      toast.success('Document deleted')
      setDeleteTarget(null)
    },
    onError: (error) => toast.error(error.response?.data?.error || 'Failed to delete document'),
  })

  const docs = docsQuery.data?.data || []
  const pagination = docsQuery.data?.pagination || null

  const stats = useMemo(() => {
    const total = pagination?.total ?? docs.length
    const parsed = docs.filter((d) => d.status === 'parsed').length
    const processing = docs.filter((d) => d.status === 'pending' || d.status === 'processing').length
    const failed = docs.filter((d) => d.status === 'failed').length
    return { total, parsed, processing, failed }
  }, [docs, pagination?.total])

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <DocStat tone="blue"    icon={FileText}    label="Total Documents" value={stats.total} />
        <DocStat tone="emerald" icon={CheckCircle2} label="Parsed"          value={stats.parsed} />
        <DocStat tone="amber"   icon={Clock}        label="Processing"      value={stats.processing} />
        <DocStat tone="rose"    icon={AlertCircle}  label="Failed"          value={stats.failed} />
      </div>

      <DocsUploadZone onUpload={(file) => uploadMutation.mutateAsync(file)} isUploading={uploadMutation.isPending} />

      <Card className="overflow-hidden p-0">
        {docsQuery.isLoading ? (
          <div className="p-5"><TableSkeleton rows={6} cols={6} /></div>
        ) : docs.length === 0 ? (
          <EmptyState
            icon={FileText}
            tone="purple"
            title="No documents uploaded yet"
            description="Drop a PDF, DOCX, or TXT above to feed it to the chatbot."
          />
        ) : (
          <Table>
            <Table.Head>
              <Table.Tr hover={false}>
                <Table.Th icon={FileText}>Title</Table.Th>
                <Table.Th icon={FileType}>Type</Table.Th>
                <Table.Th align="right">Size</Table.Th>
                <Table.Th align="right" icon={Hash}>Chunks</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th icon={Clock}>Uploaded</Table.Th>
                <Table.Th align="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Head>
            <Table.Body>
              {docs.map((doc) => {
                const meta = DOC_STATUS_META[doc.status] || { tone: 'blue' }
                const extMatch = (doc.original_filename || '').match(/\.([^.]+)$/)
                const ext = (extMatch?.[1] || '').toUpperCase()
                return (
                  <Table.Tr key={doc.id} accent={meta.tone}>
                    <Table.Td className="font-semibold text-zinc-900 dark:text-zinc-50 min-w-[220px]">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-indigo-600 flex items-center justify-center text-white shadow-sm shrink-0">
                          <FileText size={15} />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate">{doc.title}</p>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate font-normal">{doc.original_filename}</p>
                          {doc.parse_error && (
                            <p className="mt-0.5 text-xs text-rose-600 dark:text-rose-300 truncate font-normal" title={doc.parse_error}>
                              {doc.parse_error}
                            </p>
                          )}
                        </div>
                      </div>
                    </Table.Td>
                    <Table.Td>
                      {ext ? (
                        <span className="inline-flex items-center rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">
                          {ext}
                        </span>
                      ) : '—'}
                    </Table.Td>
                    <Table.Td align="right" className="text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                      {formatBytes(doc.file_size_bytes)}
                    </Table.Td>
                    <Table.Td align="right" className="font-semibold text-zinc-700 dark:text-zinc-200">
                      {doc.chunk_count || 0}
                    </Table.Td>
                    <Table.Td><DocStatusPill status={doc.status} /></Table.Td>
                    <Table.Td className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
                      {doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString() : '—'}
                    </Table.Td>
                    <Table.Td align="right">
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(doc)}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-rose-600 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                        title="Delete document"
                      >
                        <Trash2 size={14} />
                      </button>
                    </Table.Td>
                  </Table.Tr>
                )
              })}
            </Table.Body>
          </Table>
        )}
        {pagination && pagination.totalPages > 1 && (
          <Pagination
            page={pagination.page}
            totalPages={pagination.totalPages}
            total={pagination.total}
            pageSize={pagination.limit || 20}
            onChange={setPage}
          />
        )}
      </Card>

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        title="Delete document?"
        message={`Permanently remove "${deleteTarget?.title || 'this document'}" and all its chunks? The chatbot will stop returning them.`}
        loading={deleteMutation.isPending}
        danger
      />
    </div>
  )
}

const DOC_STAT_TONES = {
  blue:    { wrap: 'section-grad-blue ring-blue-200/60 dark:ring-blue-900/60',       label: 'text-blue-700 dark:text-blue-300',       value: 'text-blue-900 dark:text-blue-100',       icon: 'bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200' },
  emerald: { wrap: 'section-grad-emerald ring-emerald-200/60 dark:ring-emerald-900/60', label: 'text-emerald-700 dark:text-emerald-300', value: 'text-emerald-900 dark:text-emerald-100', icon: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200' },
  amber:   { wrap: 'section-grad-amber ring-amber-200/60 dark:ring-amber-900/60',     label: 'text-amber-700 dark:text-amber-300',     value: 'text-amber-900 dark:text-amber-100',     icon: 'bg-amber-100 text-amber-700 dark:bg-amber-900/60 dark:text-amber-200' },
  rose:    { wrap: 'section-grad-rose ring-rose-200/60 dark:ring-rose-900/60',       label: 'text-rose-700 dark:text-rose-300',       value: 'text-rose-900 dark:text-rose-100',       icon: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-200' },
}

function DocStat({ tone = 'blue', icon: Icon, label, value }) {
  const t = DOC_STAT_TONES[tone] || DOC_STAT_TONES.blue
  return (
    <div className={`relative overflow-hidden rounded-2xl ring-1 ring-inset bg-white dark:bg-zinc-900 p-4 ${t.wrap}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className={`text-[10px] font-semibold uppercase tracking-wider ${t.label}`}>{label}</p>
          <p className={`mt-1 text-2xl font-bold tracking-tight ${t.value}`}>{value}</p>
        </div>
        {Icon && (
          <div className={`rounded-xl p-2.5 shadow-sm ${t.icon}`}>
            <Icon size={18} aria-hidden />
          </div>
        )}
      </div>
    </div>
  )
}