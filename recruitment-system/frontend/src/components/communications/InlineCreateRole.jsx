import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Loader2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { getProjects, createJob } from '../../api'

const asArray = (raw) =>
  Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : (raw?.projects || [])

/**
 * InlineCreateRole — add a new role (lightweight `future`-status job) under an
 * EXISTING project on the fly from the Messages assign picker, so an agent can
 * assign to a manually-typed position without leaving the chat.
 *
 * NOTE: this no longer creates "new future projects". Parking a candidate for a
 * future/overage situation is handled by the Future Pool action (CallRemarksPanel),
 * which stores the desired project/role/country as searchable tags on the
 * candidate WITHOUT creating phantom project rows. The old "New future project"
 * mode created an `is_future` project per click, cluttering the Projects list.
 *
 * The created job is a real, assignable record (keyed by project_id/job_id) so
 * Kanban / shortlist / counts keep working. Calls back with the new job.
 */
export function InlineCreateRole({ defaultProjectId = '', onCreated }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [projId, setProjId] = useState(defaultProjectId)
  const [title, setTitle] = useState('')

  const { data: projectsRaw } = useQuery({
    queryKey: ['inline-role-projects'],
    queryFn: () => getProjects({ limit: 200 }),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })
  const projects = useMemo(() => asArray(projectsRaw), [projectsRaw])

  const reset = () => { setOpen(false); setTitle('') }

  const mut = useMutation({
    mutationFn: async () => {
      if (!projId) throw new Error('Pick a project')
      if (!title.trim()) throw new Error('Enter a role title')
      return createJob({ title: title.trim(), project_id: projId, status: 'future', inline: true })
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
        <Plus size={14} /> Create a new role under a project
      </button>
    )
  }

  return (
    <div className="mt-2 space-y-2 p-3 rounded-2xl border border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/50 dark:bg-indigo-950/20">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-medium text-indigo-700 dark:text-indigo-300">Add a role to an existing project</p>
        <button type="button" onClick={reset} className="text-zinc-400 hover:text-zinc-600"><X size={14} /></button>
      </div>

      <select value={projId} onChange={(e) => setProjId(e.target.value)} className="input w-full text-sm">
        <option value="">Select project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{(p.title || p.name || 'Untitled project')}{p.is_future ? ' (Future)' : ''}</option>
        ))}
      </select>

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
          disabled={mut.isPending || !title.trim() || !projId}
          onClick={() => mut.mutate()}
          className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {mut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create &amp; select
        </button>
      </div>
    </div>
  )
}
