import { twMerge } from 'tailwind-merge'

const toneClass = {
  blue: 'from-blue-100 to-blue-50 text-blue-500 dark:from-blue-950/60 dark:to-zinc-900 dark:text-blue-300',
  emerald: 'from-emerald-100 to-emerald-50 text-emerald-500 dark:from-emerald-950/60 dark:to-zinc-900 dark:text-emerald-300',
  amber: 'from-amber-100 to-amber-50 text-amber-500 dark:from-amber-950/60 dark:to-zinc-900 dark:text-amber-300',
  purple: 'from-purple-100 to-purple-50 text-purple-500 dark:from-purple-950/60 dark:to-zinc-900 dark:text-purple-300',
  rose: 'from-rose-100 to-rose-50 text-rose-500 dark:from-rose-950/60 dark:to-zinc-900 dark:text-rose-300',
  zinc: 'from-zinc-100 to-zinc-50 text-zinc-400 dark:from-zinc-800 dark:to-zinc-900 dark:text-zinc-500',
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'zinc',
  className,
  compact = false,
}) {
  return (
    <div
      className={twMerge(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-8 px-4' : 'py-16 px-6',
        className
      )}
    >
      {Icon && (
        <div
          className={twMerge(
            'mb-4 rounded-2xl bg-gradient-to-br p-4 shadow-sm',
            toneClass[tone]
          )}
        >
          <Icon size={compact ? 28 : 36} aria-hidden />
        </div>
      )}
      {title && (
        <p className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</p>
      )}
      {description && (
        <p className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}
