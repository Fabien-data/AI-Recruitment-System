import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Sparkles, ChevronDown, ChevronRight, AlertCircle, Users, Percent } from 'lucide-react'
import { Badge } from './ui/Badge'
import { Skeleton } from './ui/Skeleton'
import { getJobShortlist } from '../api'

// ──────────────────────────────────────────────────────────────────────────
// SmartShortlist (UPGRADES.md #4a) — semantic, READ-ONLY auto-shortlist for a
// job. Collapsible: the ranked query fires lazily only once the section is
// opened (enabled gate), so it never costs anything on the candidates page's
// initial load. Suggestion-only — every row deep-links to the candidate
// profile; no assign/mutation actions live here.
// ──────────────────────────────────────────────────────────────────────────

// Match-% tier colour. ≥75 emerald, ≥50 amber, else zinc — mirrors the tone
// used by the lifecycle badges so the page reads consistently.
function matchTierClasses(pct) {
    if (pct >= 75) return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
    if (pct >= 50) return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
    return 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
}

export default function SmartShortlist({ jobId }) {
    const [open, setOpen] = useState(false)

    const { data, isLoading, error } = useQuery({
        queryKey: ['job-shortlist', jobId],
        queryFn: () => getJobShortlist(jobId, 20),
        enabled: open && !!jobId,
    })

    const apiError = data?.error
    const candidates = data?.candidates || []
    const totalConsidered = data?.total_considered ?? 0

    return (
        <div className="card overflow-hidden mb-6">
            {/* Header / toggle */}
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className="w-full p-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/60 flex items-center justify-between text-left hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <Sparkles size={18} className="text-violet-500" />
                    <h2 className="font-semibold text-zinc-900 dark:text-zinc-50">Smart Shortlist</h2>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        Semantic best matches — suggestion only
                    </span>
                </div>
                {open
                    ? <ChevronDown size={18} className="text-zinc-400 dark:text-zinc-500" />
                    : <ChevronRight size={18} className="text-zinc-400 dark:text-zinc-500" />}
            </button>

            {open && (
                <div>
                    {/* Loading skeleton */}
                    {isLoading && (
                        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                            {[...Array(4)].map((_, i) => (
                                <div key={i} className="flex items-center gap-3 p-4">
                                    <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
                                    <div className="flex-1 space-y-2">
                                        <Skeleton className="h-4 w-40" />
                                        <Skeleton className="h-3 w-56" />
                                    </div>
                                    <Skeleton className="h-7 w-14 rounded-full" />
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Query failed */}
                    {!isLoading && error && (
                        <div className="py-10 text-center text-zinc-500 dark:text-zinc-400">
                            <AlertCircle className="mx-auto h-10 w-10 text-red-400 mb-2" />
                            <p className="font-medium text-zinc-700 dark:text-zinc-300">Couldn't load the smart shortlist</p>
                            <p className="text-sm mt-1">{error?.response?.data?.error || error?.message || 'Please try again.'}</p>
                        </div>
                    )}

                    {/* Embeddings not ready */}
                    {!isLoading && !error && apiError === 'embedding_unavailable' && (
                        <div className="py-10 text-center text-zinc-500 dark:text-zinc-400">
                            <Sparkles className="mx-auto h-10 w-10 text-violet-300 dark:text-violet-500/60 mb-2" />
                            <p className="font-medium text-zinc-700 dark:text-zinc-300">Smart matching isn't ready yet</p>
                            <p className="text-sm mt-1">Run the embedding backfill to enable semantic shortlisting.</p>
                        </div>
                    )}

                    {/* Empty (nothing considered or no matches) */}
                    {!isLoading && !error && apiError !== 'embedding_unavailable' && (totalConsidered === 0 || candidates.length === 0) && (
                        <div className="py-10 text-center text-zinc-500 dark:text-zinc-400">
                            <Users className="mx-auto h-10 w-10 text-zinc-300 dark:text-zinc-600 mb-2" />
                            <p className="font-medium text-zinc-700 dark:text-zinc-300">No smart matches found</p>
                            <p className="text-sm mt-1">
                                {apiError === 'job_not_found'
                                    ? 'This job could not be found for matching.'
                                    : "No candidates matched this job's profile yet."}
                            </p>
                        </div>
                    )}

                    {/* Ranked rows (already sorted desc by score) */}
                    {!isLoading && !error && !apiError && candidates.length > 0 && (
                        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                            {candidates.map((c, idx) => (
                                <ShortlistRow key={c.id} candidate={c} rank={idx + 1} />
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}

function ShortlistRow({ candidate, rank }) {
    const { id, name, phone, status, photo_url, match_percent } = candidate
    const why = Array.isArray(candidate.why_matched) ? candidate.why_matched : []

    return (
        <li className="flex items-center gap-3 p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 transition-colors">
            {/* Rank */}
            <span className="w-6 text-sm font-semibold text-zinc-400 dark:text-zinc-500 text-center flex-shrink-0">
                {rank}
            </span>

            {/* Avatar */}
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center text-white font-bold flex-shrink-0 overflow-hidden">
                {photo_url
                    ? <img src={`${import.meta.env.VITE_API_URL || ''}${photo_url}`} alt={name} className="w-full h-full object-cover" />
                    : (name?.charAt(0)?.toUpperCase() || '?')}
            </div>

            {/* Name + status + why */}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <Link
                        to={`/candidates/${id}`}
                        className="font-semibold text-zinc-900 dark:text-zinc-50 truncate hover:text-primary-600 dark:hover:text-primary-400 hover:underline"
                    >
                        {name || 'Unnamed candidate'}
                    </Link>
                    {status && <Badge status={status} />}
                </div>
                {phone && (
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{phone}</p>
                )}
                {why.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                        {why.slice(0, 6).map((term, i) => (
                            <span
                                key={i}
                                className="text-xs bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300 px-2 py-0.5 rounded-full"
                            >
                                {term}
                            </span>
                        ))}
                        {why.length > 6 && (
                            <span className="text-xs text-zinc-400 dark:text-zinc-500">+{why.length - 6}</span>
                        )}
                    </div>
                )}
            </div>

            {/* Match % badge */}
            <div className="flex-shrink-0">
                <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full font-bold text-sm ${matchTierClasses(match_percent)}`}>
                    <Percent size={13} />
                    {match_percent}%
                </span>
            </div>
        </li>
    )
}
