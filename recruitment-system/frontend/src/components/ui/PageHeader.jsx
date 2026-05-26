import { motion } from 'framer-motion'
import { twMerge } from 'tailwind-merge'
import { SectionIcon } from './SectionIcon'

export function PageHeader({ icon, tone = 'blue', title, subtitle, actions, className }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className={twMerge(
        'flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-2 mb-6',
        className
      )}
    >
      <div className="flex items-center gap-4 min-w-0">
        {icon && <SectionIcon icon={icon} tone={tone} size="lg" />}
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-zinc-900 dark:text-zinc-50 tracking-tight truncate">
            {title}
          </h1>
          {subtitle && (
            <p className="text-zinc-500 dark:text-zinc-400 text-sm mt-1 font-medium">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2 sm:gap-3 shrink-0">{actions}</div>}
    </motion.div>
  )
}
