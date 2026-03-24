import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { motion } from 'framer-motion'

export function Card({ children, className, hover = false, ...props }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={twMerge(
        'bg-white rounded-3xl border border-zinc-200/50 shadow-[0_8px_30px_rgb(0,0,0,0.04)] backdrop-blur-xl',
        hover && 'transition-shadow hover:shadow-[0_8px_30px_rgb(0,0,0,0.08)] cursor-pointer',
        className
      )}
      {...props}
    >
      {children}
    </motion.div>
  )
}
