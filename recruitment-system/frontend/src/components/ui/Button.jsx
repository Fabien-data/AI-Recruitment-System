import { twMerge } from 'tailwind-merge'
import { Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'

const variants = {
  primary:
    'bg-brand-gradient bg-[length:200%_100%] text-white border border-primary-700/20 shadow-md hover:bg-right hover:shadow-glow-blue active:shadow-md transition-all cursor-pointer rounded-2xl',
  accent:
    'bg-accent-gradient bg-[length:200%_100%] text-white border border-accent-700/20 shadow-md hover:bg-right hover:shadow-glow-red active:shadow-md transition-all cursor-pointer rounded-2xl',
  secondary:
    'bg-white border border-zinc-200 text-zinc-900 hover:bg-zinc-50 hover:shadow-md active:bg-zinc-100 shadow-sm transition-all cursor-pointer rounded-2xl ' +
    'dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-700 dark:active:bg-zinc-800',
  ghost:
    'bg-transparent text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100/60 active:bg-zinc-200 transition-all cursor-pointer rounded-2xl ' +
    'dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800/60 dark:active:bg-zinc-800',
  danger:
    'bg-accent-gradient text-white shadow-md hover:shadow-glow-red active:shadow-md transition-all cursor-pointer rounded-2xl',
  dark:
    'bg-zinc-900 text-white border border-zinc-800 hover:bg-zinc-800 hover:shadow-lg shadow-sm active:bg-zinc-950 transition-all cursor-pointer rounded-2xl ' +
    'dark:bg-white dark:text-zinc-900 dark:border-zinc-200 dark:hover:bg-zinc-100',
}

const sizes = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm font-semibold',
  lg: 'px-6 py-3 text-base font-semibold',
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  className,
  type = 'button',
  ...props
}) {
  return (
    <motion.button
      type={type}
      disabled={disabled || loading}
      whileTap={{ scale: 0.97 }}
      whileHover={{ y: -1 }}
      transition={{ type: 'spring', stiffness: 400, damping: 22 }}
      className={twMerge(
        'inline-flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:ring-offset-2 focus:ring-offset-white dark:focus:ring-offset-zinc-900 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:transform-none',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin text-current opacity-80" aria-hidden="true" />}
      {children}
    </motion.button>
  )
}
