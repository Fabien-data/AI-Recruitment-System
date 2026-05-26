import { useId } from 'react'
import { twMerge } from 'tailwind-merge'
import { motion } from 'framer-motion'

const toneClass = {
  blue: {
    active: 'text-blue-600 dark:text-blue-300',
    bar: 'bg-gradient-to-r from-blue-500 to-blue-600',
    hover: 'hover:text-blue-600 dark:hover:text-blue-300',
  },
  emerald: {
    active: 'text-emerald-600 dark:text-emerald-300',
    bar: 'bg-gradient-to-r from-emerald-500 to-emerald-600',
    hover: 'hover:text-emerald-600 dark:hover:text-emerald-300',
  },
  amber: {
    active: 'text-amber-600 dark:text-amber-300',
    bar: 'bg-gradient-to-r from-amber-500 to-amber-600',
    hover: 'hover:text-amber-600 dark:hover:text-amber-300',
  },
  purple: {
    active: 'text-purple-600 dark:text-purple-300',
    bar: 'bg-gradient-to-r from-purple-500 to-purple-600',
    hover: 'hover:text-purple-600 dark:hover:text-purple-300',
  },
  indigo: {
    active: 'text-indigo-600 dark:text-indigo-300',
    bar: 'bg-gradient-to-r from-indigo-500 to-indigo-600',
    hover: 'hover:text-indigo-600 dark:hover:text-indigo-300',
  },
  rose: {
    active: 'text-rose-600 dark:text-rose-300',
    bar: 'bg-gradient-to-r from-rose-500 to-rose-600',
    hover: 'hover:text-rose-600 dark:hover:text-rose-300',
  },
  zinc: {
    active: 'text-zinc-900 dark:text-zinc-50',
    bar: 'bg-gradient-to-r from-zinc-700 to-zinc-900 dark:from-zinc-300 dark:to-zinc-100',
    hover: 'hover:text-zinc-900 dark:hover:text-zinc-100',
  },
}

export function Tabs({ value, onChange, items, className, size = 'md' }) {
  const layoutId = useId()
  const padding = size === 'sm' ? 'px-3 py-2' : 'px-4 py-2.5'
  const fontSize = size === 'sm' ? 'text-xs' : 'text-sm'

  return (
    <div
      role="tablist"
      className={twMerge(
        'flex items-end gap-1 border-b border-zinc-200 dark:border-zinc-800 overflow-x-auto custom-scrollbar',
        className
      )}
    >
      {items.map((item) => {
        const Icon = item.icon
        const tone = toneClass[item.tone || 'zinc']
        const isActive = value === item.value
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange?.(item.value)}
            className={twMerge(
              'relative inline-flex items-center gap-2 font-semibold tracking-tight transition-colors whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-primary-500/30 rounded-t-lg',
              padding,
              fontSize,
              isActive ? tone.active : twMerge('text-zinc-500 dark:text-zinc-400', tone.hover)
            )}
          >
            {Icon && <Icon size={size === 'sm' ? 13 : 15} aria-hidden />}
            {item.label}
            {item.count != null && (
              <span
                className={twMerge(
                  'ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold',
                  isActive
                    ? 'bg-zinc-900/10 dark:bg-white/10'
                    : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                )}
              >
                {item.count}
              </span>
            )}
            {isActive && (
              <motion.span
                layoutId={layoutId}
                className={twMerge('absolute -bottom-px left-0 right-0 h-0.5 rounded-t', tone.bar)}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
