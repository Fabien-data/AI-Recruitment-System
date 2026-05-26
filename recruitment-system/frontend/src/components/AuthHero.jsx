import { motion } from 'framer-motion'
import { Sparkles, Bot, Users, BarChart3 } from 'lucide-react'
import { Logo } from './ui/Logo'

const features = [
  { icon: Bot, text: 'AI-powered candidate matching' },
  { icon: Users, text: 'Multi-country recruitment pipelines' },
  { icon: BarChart3, text: 'Real-time analytics & insights' },
]

export function AuthHero() {
  return (
    <div className="relative hidden lg:flex flex-col justify-between p-12 bg-sidebar-gradient text-white overflow-hidden">
      {/* Decorative blobs */}
      <div className="absolute -top-32 -left-32 w-96 h-96 bg-primary-500/30 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-20 w-[28rem] h-[28rem] bg-accent-500/25 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute inset-0 bg-hero-mesh-dark opacity-60 pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative z-10"
      >
        <Logo size={44} />
      </motion.div>

      <div className="relative z-10 space-y-6">
        <motion.div
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
        >
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-white/70 bg-white/10 backdrop-blur-sm px-3 py-1 rounded-full border border-white/15">
            <Sparkles size={12} /> AI Recruitment Platform
          </span>
          <h1 className="mt-5 text-4xl xl:text-5xl font-bold tracking-tight leading-tight">
            Hire smarter.
            <br />
            <span className="bg-gradient-to-r from-white to-accent-200 bg-clip-text text-transparent">
              Move faster.
            </span>
          </h1>
          <p className="mt-4 text-white/75 text-base max-w-md leading-relaxed">
            Source, qualify, and place candidates across countries with an AI co-pilot working the front line for you.
          </p>
        </motion.div>

        <motion.ul
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08, delayChildren: 0.3 } } }}
          className="space-y-3"
        >
          {features.map(({ icon: Icon, text }) => (
            <motion.li
              key={text}
              variants={{ hidden: { opacity: 0, x: -8 }, show: { opacity: 1, x: 0 } }}
              className="flex items-center gap-3 text-sm text-white/85 font-medium"
            >
              <span className="flex w-8 h-8 rounded-xl bg-white/10 backdrop-blur-sm border border-white/15 items-center justify-center">
                <Icon size={16} />
              </span>
              {text}
            </motion.li>
          ))}
        </motion.ul>
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="relative z-10 text-xs text-white/50"
      >
        © {new Date().getFullYear()} RecruitPro. All rights reserved.
      </motion.p>
    </div>
  )
}
