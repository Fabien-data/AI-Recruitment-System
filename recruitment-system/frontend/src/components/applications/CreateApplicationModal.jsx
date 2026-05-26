import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, User, Briefcase, Check, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { Modal } from '../ui/Modal'
import { Button } from '../ui/Button'
import { createApplication, getCandidates, getJobs } from '../../api'

function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export function CreateApplicationModal({ open, onClose, initialCandidateId = null, initialJobId = null }) {
  const queryClient = useQueryClient()
  const [candidateSearch, setCandidateSearch] = useState('')
  const [jobSearch, setJobSearch] = useState('')
  const [selectedCandidate, setSelectedCandidate] = useState(null)
  const [selectedJob, setSelectedJob] = useState(null)

  const debouncedCandidateSearch = useDebouncedValue(candidateSearch, 300)

  // Reset state each time the modal opens
  useEffect(() => {
    if (open) {
      setCandidateSearch('')
      setJobSearch('')
      setSelectedCandidate(null)
      setSelectedJob(null)
    }
  }, [open, initialCandidateId, initialJobId])

  const candidatesQuery = useQuery({
    queryKey: ['create-app-candidates', debouncedCandidateSearch],
    queryFn: () => getCandidates({ search: debouncedCandidateSearch || undefined, limit: 20 }),
    enabled: open,
  })

  const jobsQuery = useQuery({
    queryKey: ['create-app-jobs'],
    queryFn: () => getJobs({ status: 'active' }),
    enabled: open,
  })

  const candidates = useMemo(() => {
    const raw = candidatesQuery.data
    return Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
  }, [candidatesQuery.data])

  const jobs = useMemo(() => {
    const raw = jobsQuery.data
    const all = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []
    const q = jobSearch.trim().toLowerCase()
    return q ? all.filter((j) =>
      j.title?.toLowerCase().includes(q) ||
      j.category?.toLowerCase().includes(q) ||
      j.project_title?.toLowerCase().includes(q)
    ) : all
  }, [jobsQuery.data, jobSearch])

  const createMutation = useMutation({
    mutationFn: createApplication,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] })
      queryClient.invalidateQueries({ queryKey: ['general-pool'] })
      toast.success('Application created')
      onClose()
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to create application')
    },
  })

  const canSubmit = !!selectedCandidate?.id && !!selectedJob?.id && !createMutation.isPending

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!canSubmit) return
    createMutation.mutate({ candidate_id: selectedCandidate.id, job_id: selectedJob.id })
  }

  return (
    <Modal open={open} onClose={onClose} title="New Application" size="xl">
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Candidate picker */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="rounded-lg bg-blue-100 dark:bg-blue-900/40 p-1.5 text-blue-700 dark:text-blue-300">
              <User size={14} aria-hidden />
            </div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Candidate</h3>
            {selectedCandidate && (
              <span className="ml-auto text-xs font-semibold text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                <Check size={12} /> {selectedCandidate.name}
              </span>
            )}
          </div>
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" />
            <input
              type="text"
              value={candidateSearch}
              onChange={(e) => setCandidateSearch(e.target.value)}
              placeholder="Search by name, phone, or email..."
              className="input w-full pl-9"
            />
          </div>
          <div className="mt-2 max-h-60 overflow-y-auto custom-scrollbar rounded-2xl border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/60">
            {candidatesQuery.isLoading ? (
              <div className="flex items-center justify-center py-6 text-sm text-zinc-500">
                <Loader2 size={14} className="mr-2 animate-spin" /> Searching…
              </div>
            ) : candidates.length === 0 ? (
              <div className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                {debouncedCandidateSearch ? 'No candidates match' : 'Type to search candidates'}
              </div>
            ) : candidates.map((c) => {
              const isSel = selectedCandidate?.id === c.id
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCandidate(c)}
                  className={`w-full text-left px-3 py-2.5 flex items-center gap-3 transition-colors ${
                    isSel
                      ? 'bg-primary-50 dark:bg-primary-950/30'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                  }`}
                >
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-xs font-bold shrink-0 ring-2 ring-white dark:ring-zinc-900">
                    {c.name?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate">{c.name || 'Unnamed'}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {[c.phone, c.email].filter(Boolean).join(' · ') || 'No contact info'}
                    </p>
                  </div>
                  {isSel && <Check size={16} className="text-primary-600 shrink-0" />}
                </button>
              )
            })}
          </div>
        </section>

        {/* Job picker */}
        <section>
          <div className="flex items-center gap-2 mb-2">
            <div className="rounded-lg bg-indigo-100 dark:bg-indigo-900/40 p-1.5 text-indigo-700 dark:text-indigo-300">
              <Briefcase size={14} aria-hidden />
            </div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Job</h3>
            {selectedJob && (
              <span className="ml-auto text-xs font-semibold text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                <Check size={12} /> {selectedJob.title}
              </span>
            )}
          </div>
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
              <div className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">No active jobs match</div>
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
        </section>

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-zinc-200 dark:border-zinc-800">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!canSubmit} loading={createMutation.isPending}>
            Create Application
          </Button>
        </div>
      </form>
    </Modal>
  )
}
