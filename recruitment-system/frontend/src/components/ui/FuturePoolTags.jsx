import { Bookmark, Briefcase, Globe } from 'lucide-react'
import { FUTURE_POOL_CATEGORY_LABELS, normalizeStatus } from '../../constants/lifecycle'

/**
 * FuturePoolTags — shows WHY a candidate sits in the Future Pool (the category
 * captured by the calling console's "Future Pool" action) plus, for a desired
 * future project, the project name / job title / country so an admin can find
 * and assign them when that project opens. Renders nothing unless the candidate
 * is actually pooled with a category — safe to drop anywhere a candidate row or
 * detail header is shown.
 */
export function FuturePoolTags({ candidate, className = '' }) {
  if (!candidate) return null
  const category = candidate.future_pool_category
  if (normalizeStatus(candidate.status) !== 'future_pool' || !category) return null

  const label = FUTURE_POOL_CATEGORY_LABELS[category] || category
  const proj = candidate.future_pool_project_name
  const role = candidate.future_pool_job_title
  const country = candidate.future_pool_country

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
        <Bookmark size={10} /> {label}
      </span>
      {role && (
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <Briefcase size={10} /> {role}
        </span>
      )}
      {country && (
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          <Globe size={10} /> {country}
        </span>
      )}
      {proj && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {proj}
        </span>
      )}
    </div>
  )
}

export default FuturePoolTags
