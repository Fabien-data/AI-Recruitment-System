import { ChevronLeft, ChevronRight } from 'lucide-react'
import { twMerge } from 'tailwind-merge'
import { Button } from './Button'

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
  className,
  showRange = true,
  loading = false,
}) {
  const safePage = Math.max(1, page || 1)
  const safeTotalPages = Math.max(1, totalPages || 1)
  const start = total ? Math.min(total, (safePage - 1) * (pageSize || 0) + 1) : null
  const end = total && pageSize ? Math.min(total, safePage * pageSize) : null

  const canPrev = safePage > 1 && !loading
  const canNext = safePage < safeTotalPages && !loading

  return (
    <div
      className={twMerge(
        'flex flex-col gap-3 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between',
        className
      )}
    >
      {showRange && total != null && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {start && end
            ? <>Showing <span className="font-semibold text-zinc-800 dark:text-zinc-200">{start}</span>–<span className="font-semibold text-zinc-800 dark:text-zinc-200">{end}</span> of <span className="font-semibold text-zinc-800 dark:text-zinc-200">{total}</span></>
            : <>{total} total</>
          }
        </p>
      )}
      <div className="flex items-center gap-2 sm:ml-auto">
        <Button
          variant="secondary"
          size="sm"
          disabled={!canPrev}
          onClick={() => onChange?.(safePage - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft size={15} />
          Previous
        </Button>
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 px-2 select-none">
          Page <span className="font-semibold text-zinc-800 dark:text-zinc-200">{safePage}</span>
          {' / '}{safeTotalPages}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={!canNext}
          onClick={() => onChange?.(safePage + 1)}
          aria-label="Next page"
        >
          Next
          <ChevronRight size={15} />
        </Button>
      </div>
    </div>
  )
}
