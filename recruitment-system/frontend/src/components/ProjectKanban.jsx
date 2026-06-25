import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { User, FileWarning } from 'lucide-react'
import toast from 'react-hot-toast'
import { getProjectCandidates, setCandidateStage } from '../api'
import { Skeleton } from './ui/Skeleton'
import {
  CANDIDATE_PIPELINE_STATUSES,
  CANDIDATE_STAGE_LABELS,
  STATUS_COLORS,
  normalizeStatus,
  getStageLabel,
} from '../constants/lifecycle'

// Droppable columns, in pipeline order, plus Future Pool so candidates can be
// parked / lifted by drag (it's a flexible backup pool, not a terminal state).
// merged / hired remain off-board (terminal) — the list view shows those.
const COLUMNS = [...CANDIDATE_PIPELINE_STATUSES, 'future_pool']

// Header accent per column — reuse the shared STATUS_COLORS so the board's
// vocabulary stays in lock-step with badges everywhere else.
function columnAccent(status) {
  return STATUS_COLORS[status] || 'bg-zinc-50 text-zinc-700 border-zinc-200 dark:bg-zinc-800/40 dark:text-zinc-300 dark:border-zinc-700/50'
}

const cidOf = (c) => c.id ?? c.candidate_id

// A candidate has a "CV signal" only if the payload actually carries one. We do
// NOT invent fields: if no CV-related key is present, we render no pill (the
// server still enforces the screening gate on drop).
function cvSignal(c) {
  if (c.has_cv != null) return Boolean(c.has_cv)
  if (c.cv_id != null) return Boolean(c.cv_id)
  if (c.cv_count != null) return Number(c.cv_count) > 0
  if (c.has_documents != null) return Boolean(c.has_documents)
  return null // unknown — render no pill
}

function CandidateCard({ candidate, onDragStart, onDragEnd, dragging }) {
  const id = cidOf(candidate)
  const hasCv = cvSignal(candidate)
  const apiBase = import.meta.env.VITE_API_URL || ''

  return (
    <Link
      to={`/candidates/${id}`}
      draggable
      onDragStart={(e) => onDragStart(e, candidate)}
      onDragEnd={onDragEnd}
      className={`group block rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 shadow-sm transition-all hover:shadow-md hover:border-primary-200 dark:hover:border-primary-900/40 cursor-grab active:cursor-grabbing ${dragging ? 'opacity-40' : ''}`}
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white text-sm font-bold flex-shrink-0 overflow-hidden">
          {candidate.photo_url
            ? <img src={`${apiBase}${candidate.photo_url}`} alt={candidate.name} className="w-full h-full object-cover" draggable={false} />
            : (candidate.name?.charAt(0)?.toUpperCase() || <User size={14} />)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight text-zinc-900 dark:text-zinc-50 break-words group-hover:text-primary-600">
            {candidate.name || 'Unnamed candidate'}
          </p>
          {candidate.job_title && (
            <p className="mt-0.5 text-xs leading-snug text-zinc-500 dark:text-zinc-400 break-words">
              {candidate.job_title}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {candidate.match_score != null && (
              <span className="inline-flex items-center rounded-md bg-primary-50 dark:bg-primary-950/40 px-1.5 py-0.5 text-[11px] font-semibold text-primary-700 dark:text-primary-300">
                {candidate.match_score}%
              </span>
            )}
            {hasCv === false && (
              <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/50">
                <FileWarning size={11} /> No CV
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  )
}

function KanbanColumn({ status, candidates, onDragOver, onDrop, isOver, children }) {
  return (
    <div
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDrop={(e) => onDrop(e, status)}
      className={`flex flex-col rounded-2xl border bg-zinc-50/60 dark:bg-zinc-900/40 transition-colors ${
        isOver
          ? 'border-primary-400 dark:border-primary-600 ring-2 ring-primary-200 dark:ring-primary-900/50'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className={`flex items-center justify-between gap-2 rounded-t-2xl border-b px-3 py-2.5 ${columnAccent(status)}`}>
        <span className="text-xs font-semibold uppercase tracking-wide">
          {CANDIDATE_STAGE_LABELS[status] || getStageLabel(status)}
        </span>
        <span className="rounded-full bg-white/60 dark:bg-black/20 px-2 py-0.5 text-xs font-bold tabular-nums">
          {candidates.length}
        </span>
      </div>
      <div className="flex-1 space-y-2 p-2 min-h-[120px]">
        {children}
        {candidates.length === 0 && (
          <p className="px-1 py-6 text-center text-xs text-zinc-400 dark:text-zinc-600">
            Drop a candidate here
          </p>
        )}
      </div>
    </div>
  )
}

export default function ProjectKanban({ projectId, jobFilter }) {
  const queryClient = useQueryClient()
  const [dragging, setDragging] = useState(null) // { id, from }
  const [overColumn, setOverColumn] = useState(null)

  // Pull a generous page so the board reflects the whole pipeline, not a slice.
  const params = jobFilter ? { job_id: jobFilter, limit: 200 } : { limit: 200 }
  const queryKey = ['project-kanban', projectId, jobFilter]

  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => getProjectCandidates(projectId, params),
    enabled: !!projectId,
  })

  const candidates = Array.isArray(data) ? data : (data?.candidates || data?.data || [])

  // Group into the columns by normalized status; anything outside the pipeline
  // 4 + future_pool (merged / hired / rejected / legacy) is excluded.
  const columns = COLUMNS.reduce((acc, status) => {
    acc[status] = []
    return acc
  }, {})
  for (const c of candidates) {
    const stage = normalizeStatus(c.application_status || c.status)
    if (columns[stage]) columns[stage].push(c)
  }

  const advance = useMutation({
    mutationFn: ({ id, stage }) => setCandidateStage(id, stage),
    onMutate: async ({ id, stage }) => {
      // Optimistic: move the card into the target column immediately.
      await queryClient.cancelQueries({ queryKey })
      const previous = queryClient.getQueryData(queryKey)

      const patchOne = (c) =>
        cidOf(c) === id ? { ...c, application_status: stage, status: stage } : c

      queryClient.setQueryData(queryKey, (old) => {
        if (!old) return old
        if (Array.isArray(old)) return old.map(patchOne)
        if (Array.isArray(old.candidates)) return { ...old, candidates: old.candidates.map(patchOne) }
        if (Array.isArray(old.data)) return { ...old, data: old.data.map(patchOne) }
        return old
      })

      return { previous }
    },
    onSuccess: (_res, { stage }) => {
      toast.success(`Moved to ${CANDIDATE_STAGE_LABELS[stage] || getStageLabel(stage)}`)
    },
    onError: (err, _vars, context) => {
      // Roll back to the server-truth snapshot captured in onMutate.
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous)
      }
      if (err?.response?.status === 422) {
        toast.error('Upload a CV before advancing this candidate')
      } else {
        toast.error(err?.response?.data?.error || 'Failed to move candidate')
      }
    },
    onSettled: () => {
      // Server is the source of truth — reconcile regardless of outcome.
      queryClient.invalidateQueries({ queryKey })
    },
  })

  const handleDragStart = (e, candidate) => {
    const id = cidOf(candidate)
    const from = normalizeStatus(candidate.application_status || candidate.status)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(id))
    setDragging({ id, from })
  }

  const handleDragEnd = () => {
    setDragging(null)
    setOverColumn(null)
  }

  const handleDragOver = (status) => (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (overColumn !== status) setOverColumn(status)
  }

  const handleDrop = (e, targetStatus) => {
    e.preventDefault()
    setOverColumn(null)
    const id = Number(e.dataTransfer.getData('text/plain')) || dragging?.id
    const from = dragging?.from
    setDragging(null)
    if (!id) return
    // No-op if dropped back into the same column.
    if (from === targetStatus) return
    advance.mutate({ id, stage: targetStatus })
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
        {COLUMNS.map((status) => (
          <div key={status} className="rounded-2xl border border-zinc-200 dark:border-zinc-800 p-2 space-y-2">
            <Skeleton className="h-7 w-full rounded-lg" />
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ))}
      </div>
    )
  }

  if (isError) {
    return <p className="text-center text-sm text-zinc-500 dark:text-zinc-400 py-6">Couldn’t load the pipeline. Try again.</p>
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
      className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3"
    >
      {COLUMNS.map((status) => (
        <KanbanColumn
          key={status}
          status={status}
          candidates={columns[status]}
          isOver={overColumn === status}
          onDragOver={handleDragOver(status)}
          onDrop={handleDrop}
        >
          {columns[status].map((c) => (
            <CandidateCard
              key={cidOf(c)}
              candidate={c}
              dragging={dragging?.id === cidOf(c)}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            />
          ))}
        </KanbanColumn>
      ))}
    </motion.div>
  )
}
