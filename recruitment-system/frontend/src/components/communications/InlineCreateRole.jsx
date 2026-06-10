import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Loader2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { getProjects, createProject, createJob } from '../../api'

const asArray = (raw) =>
  Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : (raw?.projects || [])

/**
 * InlineCreateRole — create a real role (lightweight `future`-status job) on the
 * fly from the Messages assign/transfer pickers, so an agent can transfer/assign
 * to a "future project" or a manually-typed position without leaving the chat.
 *
 * Two modes:
 *  • Existing project — pick any project (future ones tagged) + type the role.
 *  • New future project — type a project name + role; creates a lightweight
 *    `is_future` project then the role under it.
 *
 * The created job is a real, assignable record (keyed by project_id/job_id) so
 * Kanban / shortlist / counts keep working. Calls back with the new job.
 */
export function InlineCreateRole({ defaultProjectId = '', onCreated }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('existing')   // 'existing' | 'new_project'
  const [projId, setProjId] = useState(defaultProjectId)
  const [newProjectName, setNewProjectName] = useState('')
  const [title, setTitle] = useState('')

  const { data: projectsRaw } = useQuery({
    queryKey: ['inline-role-projects'],
    queryFn: () => getProjects({ limit: 200 }),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })
  const projects = useMemo(() => asArray(projectsRaw), [projectsRaw])

  const reset = () => { setOpen(false); setTitle(''); setNewProjectName(''); setMode('existing') }

  const mut = useMutation({
    mutationFn: async () => {
      let projectId = projId
      if (mode === 'new_project') {
        if (!newProjectName.trim()) throw new Error('Enter a project name')
        const proj = await createProject({ title: newProjectName.trim(), is_future: true })
        projectId = proj?.id || proj?.data?.id
        if (!projectId) throw new Error('Could not create the future project')
      }
      if (!projectId) throw new Error('Pick a project')
      if (!title.trim()) throw new Error('Enter a role title')
      return createJob({ title: title.trim(), project_id: projectId, status: 'future', inline: true })
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['inline-role-projects'] })
      toast.success('Role created')
      onCreated?.(job)
      reset()
    },
    onError: (e) => toast.error(e?.response?.data?.error || e?.message || 'Failed to create role'),
  })

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700"
      >
        <Plus size={14} /> Create a new role / future project
      </button>
    )
  }

  return (
    <div className="mt-2 space-y-2 p-3 rounded-2xl border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/20">
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-0.5 text-[11px]">
          <button type="button" onClick={() => setMode('existing')} className={`px-2 py-1 rounded-md ${mode === 'existing' ? 'bg-indigo-600 text-white' : 'text-zinc-600 dark:text-zinc-300'}`}>Existing project</button>
          <button type="button" onClick={() => setMode('new_project')} className={`px-2 py-1 rounded-md ${mode === 'new_project' ? 'bg-indigo-600 text-white' : 'text-zinc-600 dark:text-zinc-300'}`}>New future project</button>
        </div>
        <button type="button" onClick={reset} className="text-zinc-400 hover:text-zinc-600"><X size={14} /></button>
      </div>

      {mode === 'existing' ? (
        <select value={projId} onChange={(e) => setProjId(e.target.value)} className="input w-full text-sm">
          <option value="">Select project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{(p.title || p.name || 'Untitled project')}{p.is_future ? ' (Future)' : ''}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={newProjectName}
          onChange={(e) => setNewProjectName(e.target.value)}
          placeholder="New future project name (e.g. Qatar 2027 intake)"
          className="input w-full text-sm"
        />
      )}

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Role / position (e.g. Security Officer)"
        className="input w-full text-sm"
      />

      <div className="flex justify-end gap-2">
        <button type="button" onClick={reset} className="text-[11px] text-zinc-500 hover:text-zinc-700">Cancel</button>
        <button
          type="button"
          disabled={mut.isPending || !title.trim() || (mode === 'existing' ? !projId : !newProjectName.trim())}
          onClick={() => mut.mutate()}
          className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {mut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create &amp; select
        </button>
      </div>
    </div>
  )
}
