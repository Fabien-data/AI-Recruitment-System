import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, ArrowRight, Briefcase, Check, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { getJobs, transferApplication } from '../../api'

export function TransferApplicationModal({ open, onClose, application }) {
  const queryClient = useQueryClient()
  const [jobSearch, setJobSearch] = useState('')
  const [selectedJob, setSelectedJob] = useState(null)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (open) {
      setJobSearch('')
      setSelectedJob(null)
      setReason('')
    }
  }, [open, application?.id])

  const jobsQuery = useQuery({
    queryKey: ['transfer-app-jobs'],
    queryFn: () => getJobs({ status: 'active' }),
    enabled: open,
  })

  const jobs = useMemo(() => {
    const raw = jobsQuery.data
    const all = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
    // Filter out the candidate's current job to avoid self-transfers
    const filtered = application?.job_id ? all.filter((j) => j.id !== application.job_id) : all
    const q = jobSearch.trim().toLowerCase()
    return q ? filtered.filter((j) =>
      j.title?.toLowerCase().includes(q) ||
      j.category?.toLowerCase().includes(q) ||
      j.project_title?.toLowerCase().includes(q)
    ) : filtered
  }, [jobsQuery.data, jobSearch, application?.job_id])

  const transferMutation = useMutation({
    mutationFn: () => transferApplication(application.id, {
      target_job_id: selectedJob.id,
      transfer_reason: reason || undefined,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      toast.success('Application transferred')
      onClose()
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to transfer application')
    },
  })

  if (!application) return null

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!selectedJob?.id) return
    transferMutation.mutate()
  }

  return (
    <Modal open={open} onClose={onClose} title="Transfer Application" size="lg">
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="rounded-2xl section-grad-blue ring-1 ring-inset ring-blue-200/60 dark:ring-blue-900/60 p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-blue-100 dark:bg-blue-900/40 p-2 text-blue-700 dark:text-blue-300">
              <Briefcase size={16} aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Current</p>
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate">{application.job_title || 'Job'}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                Candidate: {application.candidate_name || '—'}
              </p>
            </div>
            <ArrowRight size={20} className="text-blue-600 dark:text-blue-300 shrink-0" />
            <div className="min-w-0 flex-1 text-right">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Target</p>
              <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate">
                {selectedJob?.title || <span className="text-zinc-400 dark:text-zinc-500">Pick below</span>}
              </p>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
            Find target job
          </label>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              value={jobSearch}
              onChange={(e) => setJobSearch(e.target.value)}
              placeholder="Filter active jobs..."
              className="input w-full pl-9"
            />
          </div>
          <div className="mt-2 max-h-60 overflow-y-auto custom-scrollbar rounded-2xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {jobsQuery.isLoading ? (
              <div className="flex items-center justify-center py-6 text-sm text-zinc-500">
                <Loader2 size={14} className="mr-2 animate-spin" /> Loading jobs…
              </div>
            ) : jobs.length === 0 ? (
              <div className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">No alternative active jobs</div>
            ) : jobs.map((j) => {
              const isSel = selectedJob?.id === j.id
              const remaining = Math.max(0, (j.positions_available || 0) - (j.positions_filled || 0))
              return (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => setSelectedJob(j)}
                  className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${
                    isSel
                      ? 'bg-indigo-50 dark:bg-indigo-950/30'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold shrink-0 ring-2 ring-white dark:ring-zinc-900">
                    {j.title?.charAt(0)?.toUpperCase() || 'J'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate">{j.title}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {j.category || '—'}
                      {j.project_title && <> · {j.project_title}</>}
                      <> · <span className="text-zinc-700 dark:text-zinc-300 font-medium">{remaining}</span> open</>
                    </p>
                  </div>
                  {isSel && <Check size={16} className="text-indigo-600 shrink-0" />}
                </button>
              )
            })}
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1.5">
            Reason (optional)
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Shared in the transfer notification..."
            className="input w-full resize-none"
          />
        </div>

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!selectedJob?.id} loading={transferMutation.isPending}>
            Transfer
          </Button>
        </div>
      </form>
    </Modal>
  )
}
