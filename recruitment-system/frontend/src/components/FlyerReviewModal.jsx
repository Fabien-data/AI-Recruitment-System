import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createJob, createProject, getProjects } from '../api'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { CountrySelect } from './jobs/CountrySelect'
import { URGENCY_OPTIONS } from './jobs/UrgencyPill'
import toast from 'react-hot-toast'

/**
 * Per-file review modal for AI-extracted job flyers.
 *
 * The agent must fill ALL required fields (title, category, country, domain,
 * salary, location, project) before Save is enabled. Two save modes:
 *   - "Save as Pending Review"  → status='pending_review'  (manual promote later)
 *   - "Save & Activate"         → status='active'          (goes live + chatbot)
 *
 * The project picker has two tabs: pick an existing project from the system, or
 * create a brand new one with this job as its first member.
 */

const JOB_CATEGORIES = [
  'Security', 'Hospitality', 'Manufacturing', 'Construction', 'Healthcare',
  'Retail', 'Logistics', 'F&B Service', 'Housekeeping', 'Administration', 'Other',
]

export function FlyerReviewModal({ file, step, total, onSaved, onSkip, onCancelAll }) {
  const queryClient = useQueryClient()
  const extraction = file?.extraction || { jobs: [], project: {} }

  // The flyer may yield multiple jobs (e.g. "we need 2 chefs and 1 driver").
  // The review queue walks file-by-file, but within a single file we walk
  // job-by-job so each role gets its own form + project assignment.
  const [jobIndex, setJobIndex] = useState(0)
  const totalJobs = extraction.jobs?.length || 0
  const aiJob = extraction.jobs?.[jobIndex] || {}
  const aiProject = extraction.project || {}

  // Project picker: tab between existing-or-new.
  const [projectMode, setProjectMode] = useState('existing') // 'existing' | 'new'
  const [existingProjectId, setExistingProjectId] = useState('')
  const [newProject, setNewProject] = useState({
    title: aiProject.title || '',
    client_name: aiProject.name || '',
    industry_type: aiProject.industry_type || '',
    countries: Array.isArray(aiProject.countries) ? aiProject.countries : [],
    description: aiProject.description || '',
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', { limit: 200 }],
    queryFn: () => getProjects({ limit: 200 }),
  })
  const projectsList = projectsData?.data || projectsData || []

  // Form state, prefilled from AI extraction. Empty strings stay empty so the
  // required-field guard catches them.
  const [form, setForm] = useState({
    title: aiJob.title || '',
    category: aiJob.category || '',
    description: aiJob.description || '',
    salary_range: aiJob.salary_range && aiJob.salary_range !== 'Not specified' ? aiJob.salary_range : '',
    location: aiJob.location && aiJob.location !== 'Not specified' ? aiJob.location : '',
    country: aiJob.country || '',
    country_code: aiJob.country_code || '',
    domain: aiJob.domain || '',
    urgency_level: aiJob.urgency_level || 'normal',
    positions_available: Number(aiJob.positions_available) || 1,
    requirements: aiJob.requirements || {},
  })

  // Re-init when stepping to the next job within the same flyer.
  useEffect(() => {
    const j = extraction.jobs?.[jobIndex] || {}
    setForm({
      title: j.title || '',
      category: j.category || '',
      description: j.description || '',
      salary_range: j.salary_range && j.salary_range !== 'Not specified' ? j.salary_range : '',
      location: j.location && j.location !== 'Not specified' ? j.location : '',
      country: j.country || '',
      country_code: j.country_code || '',
      domain: j.domain || '',
      urgency_level: j.urgency_level || 'normal',
      positions_available: Number(j.positions_available) || 1,
      requirements: j.requirements || {},
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobIndex])

  const handleCountryChange = (country) => {
    if (!country) {
      setForm((p) => ({ ...p, country: '', country_code: '' }))
      return
    }
    setForm((p) => ({
      ...p,
      country: country.name,
      country_code: country.code,
      domain: p.domain || country.domain_default || '',
    }))
  }

  // Required-field guard
  const missing = useMemo(() => {
    const list = []
    if (!form.title) list.push('title')
    if (!form.category) list.push('category')
    if (!form.country) list.push('country')
    if (!form.domain) list.push('domain')
    if (!form.salary_range) list.push('salary range')
    if (!form.location) list.push('location')
    if (projectMode === 'existing' && !existingProjectId) list.push('project')
    if (projectMode === 'new' && (!newProject.title || !newProject.client_name || !newProject.industry_type)) {
      list.push('new project (title, client, industry)')
    }
    return list
  }, [form, projectMode, existingProjectId, newProject])

  const flyerUrl = useMemo(() => {
    if (!file?.sourceFile) return null
    return URL.createObjectURL(file.sourceFile)
  }, [file?.sourceFile])

  useEffect(() => {
    return () => { if (flyerUrl) URL.revokeObjectURL(flyerUrl) }
  }, [flyerUrl])

  const saveMutation = useMutation({
    mutationFn: async ({ status }) => {
      // 1) ensure we have a project_id, creating one if needed
      let projectId = existingProjectId
      if (projectMode === 'new') {
        const created = await createProject({
          title: newProject.title,
          client_name: newProject.client_name,
          industry_type: newProject.industry_type,
          countries: newProject.countries.length ? newProject.countries : (form.country ? [form.country] : []),
          description: newProject.description,
          status: 'active',
          priority: 'normal',
        })
        projectId = created.id || created.data?.id || created.project?.id
        if (!projectId) throw new Error('Project creation returned no id')
      }

      // 2) save the job
      return createJob({
        ...form,
        project_id: projectId,
        status,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success(`Saved ${form.title}`)

      // Advance: next job in this file, or finish the file.
      if (jobIndex + 1 < totalJobs) {
        setJobIndex(jobIndex + 1)
      } else {
        onSaved?.()
      }
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message || 'Save failed'),
  })

  const doSave = (status) => {
    if (missing.length > 0) {
      toast.error(`Missing required: ${missing.join(', ')}`)
      return
    }
    saveMutation.mutate({ status })
  }

  const headerLabel = totalJobs > 1
    ? `File ${step} of ${total} — Job ${jobIndex + 1} of ${totalJobs}`
    : `Reviewing flyer ${step} of ${total}`

  return (
    <Modal open onClose={onCancelAll} title={headerLabel} size="xl">
      <div className="grid grid-cols-1 lg:grid-cols-[260px,1fr] gap-6">
        {/* Flyer preview */}
        <div>
          <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 overflow-hidden bg-zinc-50 dark:bg-zinc-900">
            {flyerUrl ? (
              <img src={flyerUrl} alt={file?.fileName || 'Flyer'} className="w-full object-contain max-h-72" />
            ) : (
              <div className="aspect-square flex items-center justify-center text-zinc-400 text-xs p-4">
                No preview available
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-zinc-500 truncate" title={file?.fileName}>{file?.fileName}</p>
          {extraction.confidence_score != null && (
            <p className="mt-1 text-xs text-zinc-500">
              AI confidence: {Math.round(Number(extraction.confidence_score) * 100)}%
            </p>
          )}
        </div>

        {/* Form */}
        <div className="space-y-5">
          {/* Project picker */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-zinc-800 pb-2">
              Project
            </h3>
            <div className="flex gap-2">
              <TabButton active={projectMode === 'existing'} onClick={() => setProjectMode('existing')}>
                Pick existing
              </TabButton>
              <TabButton active={projectMode === 'new'} onClick={() => setProjectMode('new')}>
                Create new
              </TabButton>
            </div>
            {projectMode === 'existing' ? (
              <select
                value={existingProjectId}
                onChange={(e) => setExistingProjectId(e.target.value)}
                className="input w-full"
              >
                <option value="">Select a project</option>
                {projectsList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title || p.name}{p.client_name ? ` — ${p.client_name}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Project title *</label>
                  <Input value={newProject.title} onChange={(e) => setNewProject({ ...newProject, title: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Client name *</label>
                  <Input value={newProject.client_name} onChange={(e) => setNewProject({ ...newProject, client_name: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Industry *</label>
                  <Input value={newProject.industry_type} onChange={(e) => setNewProject({ ...newProject, industry_type: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Description</label>
                  <Input value={newProject.description} onChange={(e) => setNewProject({ ...newProject, description: e.target.value })} />
                </div>
              </div>
            )}
          </div>

          {/* Job basics */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-zinc-800 pb-2">
              Job details
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Title *</label>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Category *</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="input w-full"
                >
                  <option value="">Select category</option>
                  {JOB_CATEGORIES.map((c) => (
                    <option key={c} value={c.toLowerCase()}>{c}</option>
                  ))}
                  {form.category && !JOB_CATEGORIES.find((c) => c.toLowerCase() === form.category) && (
                    <option value={form.category}>{form.category}</option>
                  )}
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Salary range *</label>
                <Input value={form.salary_range} onChange={(e) => setForm({ ...form, salary_range: e.target.value })} placeholder="e.g. 2500-3000 AED" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Location *</label>
                <Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. Dubai Marina" />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Positions Available</label>
                <Input
                  type="number"
                  min={1}
                  value={form.positions_available}
                  onChange={(e) => setForm({ ...form, positions_available: parseInt(e.target.value) || 1 })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Urgency</label>
                <select
                  value={form.urgency_level}
                  onChange={(e) => setForm({ ...form, urgency_level: e.target.value })}
                  className="input w-full"
                >
                  {URGENCY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Region */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 border-b border-zinc-200 dark:border-zinc-800 pb-2">
              Region
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Country *</label>
                <CountrySelect value={form.country_code || form.country} onChange={handleCountryChange} />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">Domain *</label>
                <select value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} className="input w-full">
                  <option value="">Select region</option>
                  <option value="middle_east">Middle East</option>
                  <option value="europe">Europe</option>
                </select>
              </div>
            </div>
          </div>

          {missing.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
              Still missing: {missing.join(', ')}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap justify-between gap-2 border-t border-zinc-200 dark:border-zinc-800 pt-4">
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onSkip} disabled={saveMutation.isLoading}>
                Skip this {totalJobs > 1 ? 'job' : 'flyer'}
              </Button>
              <Button variant="secondary" onClick={onCancelAll} disabled={saveMutation.isLoading} className="text-rose-600">
                Cancel all
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => doSave('pending_review')}
                disabled={missing.length > 0 || saveMutation.isLoading}
              >
                Save as Pending
              </Button>
              <Button
                variant="primary"
                onClick={() => doSave('active')}
                disabled={missing.length > 0 || saveMutation.isLoading}
              >
                {saveMutation.isLoading ? 'Saving…' : 'Save & Activate'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
        active
          ? 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
          : 'bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-700 dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  )
}
