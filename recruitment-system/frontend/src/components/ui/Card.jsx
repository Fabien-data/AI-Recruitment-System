import { twMerge } from 'tailwind-merge'
import { motion } from 'framer-motion'

const accentStripe = {
  blue: 'before:content-[""] before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-brand-gradient before:rounded-t-3xl',
  red: 'before:content-[""] before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-accent-gradient before:rounded-t-3xl',
  mixed: 'before:content-[""] before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-mixed-gradient before:rounded-t-3xl',
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
        'relative bg-white rounded-3xl border border-zinc-200/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl transition-shadow',
        'dark:bg-zinc-900/90 dark:border-zinc-800/70 dark:shadow-[0_8px_30px_rgb(0,0,0,0.4)]',
        accent && accentStripe[accent],
        hover && 'hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:hover:shadow-[0_8px_30px_rgb(0,0,0,0.6)] cursor-pointer',
        glow && (glowClass[accent] || 'hover:shadow-glow-blue'),
        className
      )}
      {...props}
    >
      {children}
    </motion.div>
  )
}
