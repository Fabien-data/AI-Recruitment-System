import { twMerge } from 'tailwind-merge'
import { motion } from 'framer-motion'

// Top accent bar. Inset past the card's rounded corners (rounded-3xl ≈ 24px)
// with fully-rounded ends so the 3px line never overhangs or "misaligns" at the
// corners — the previous full-bleed `inset-x-0 + rounded-t-3xl` fought the 24px
// corner radius on a 3px-tall bar and showed colored notches at the corners (B015).
const accentStripe = {
  blue: 'before:content-[""] before:absolute before:top-0 before:inset-x-5 before:h-[3px] before:bg-brand-gradient before:rounded-full',
  red: 'before:content-[""] before:absolute before:top-0 before:inset-x-5 before:h-[3px] before:bg-accent-gradient before:rounded-full',
  mixed: 'before:content-[""] before:absolute before:top-0 before:inset-x-5 before:h-[3px] before:bg-mixed-gradient before:rounded-full',
}

const glowClass = {
  blue: 'hover:shadow-glow-blue',
  red: 'hover:shadow-glow-red',
  mixed: 'hover:shadow-glow-blue',
}

export function Card({ children, className, hover = false, accent = null, glow = false, ...props }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className={twMerge(
        // p-5 is the default surface padding so titles/content don't sit
        // flush against the rounded border. Pages that pack rows/tables
        // edge-to-edge override with className="p-0".
        'relative bg-white rounded-3xl border border-zinc-200/70 shadow-[0_8px_30px_rgb(0,0,0,0.04)] transition-shadow p-5',
        'dark:bg-zinc-900 dark:border-zinc-800 dark:shadow-[0_8px_30px_rgb(0,0,0,0.5)]',
        accent && accentStripe[accent],
        hover && 'hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:hover:shadow-[0_8px_30px_rgb(0,0,0,0.7)] dark:hover:border-zinc-700 cursor-pointer',
        glow && (glowClass[accent] || 'hover:shadow-glow-blue'),
        className
      )}
      {...props}
    >
      {children}
    </motion.div>
  )
}
