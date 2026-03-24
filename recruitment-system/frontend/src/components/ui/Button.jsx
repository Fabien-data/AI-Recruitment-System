import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'

const variants = {
  primary: 'bg-zinc-900 border border-zinc-800 text-white hover:bg-zinc-800 hover:shadow-lg shadow-sm active:bg-zinc-950 transition-all cursor-pointer rounded-2xl',
  secondary: 'bg-white/80 backdrop-blur-md border border-zinc-200/60 text-zinc-900 hover:bg-white hover:shadow-sm active:bg-zinc-100 shadow-sm transition-all cursor-pointer rounded-2xl',
  ghost: 'bg-transparent text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100/50 active:bg-zinc-200 transition-all cursor-pointer rounded-2xl',
  danger: 'bg-red-500 text-white hover:bg-red-600 hover:shadow-lg shadow-sm active:bg-red-700 transition-all cursor-pointer rounded-2xl',
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
      whileTap={{ scale: 0.98 }}
      className={twMerge(
        'inline-flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin text-current opacity-70" aria-hidden="true" />}
      {children}
    </motion.button>
  )
}
