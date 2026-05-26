import toast from 'react-hot-toast'
import { motion } from 'framer-motion'
import { CheckCircle2, AlertCircle, Info, Loader2 } from 'lucide-react'

function ToastShell({ t, gradient, glow, icon: Icon, title, message, animation = 'slide-in-right' }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: 40, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 320, damping: 26 }}
      className={`pointer-events-auto flex items-start gap-3 max-w-sm rounded-2xl px-4 py-3 text-white ${gradient} ${glow} ${animation}`}
      role="status"
    >
      <div className="mt-0.5 flex-shrink-0">
        <Icon size={20} className="opacity-95" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        {title && <p className="text-sm font-semibold tracking-tight">{title}</p>}
        {message && <p className="text-xs font-medium opacity-90 leading-snug mt-0.5">{message}</p>}
      </div>
      <button
        type="button"
        onClick={() => toast.dismiss(t.id)}
        className="text-xs font-semibold opacity-70 hover:opacity-100 transition-opacity ml-1"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </motion.div>
  )
}

export const notify = {
  success(messageOrOpts, opts = {}) {
    const { title = 'Success', message, duration = 3500 } = typeof messageOrOpts === 'string'
      ? { ...opts, message: messageOrOpts }
      : { ...opts, ...messageOrOpts }
    return toast.custom(
      (t) => (
        <ToastShell
          t={t}
          gradient="bg-brand-gradient"
          glow="shadow-glow-blue"
          icon={CheckCircle2}
          title={title}
          message={message}
        />
      ),
      { duration }
    )
  },
  error(messageOrOpts, opts = {}) {
    const { title = 'Something went wrong', message, duration = 4500 } = typeof messageOrOpts === 'string'
      ? { ...opts, message: messageOrOpts }
      : { ...opts, ...messageOrOpts }
    return toast.custom(
      (t) => (
        <ToastShell
          t={t}
          gradient="bg-accent-gradient"
          glow="shadow-glow-red"
          icon={AlertCircle}
          title={title}
          message={message}
        />
      ),
      { duration }
    )
  },
  info(messageOrOpts, opts = {}) {
    const { title = 'Heads up', message, duration = 3500 } = typeof messageOrOpts === 'string'
      ? { ...opts, message: messageOrOpts }
      : { ...opts, ...messageOrOpts }
    return toast.custom(
      (t) => (
        <ToastShell
          t={t}
          gradient="bg-zinc-900 dark:bg-zinc-800"
          glow="shadow-xl"
          icon={Info}
          title={title}
          message={message}
        />
      ),
      { duration }
    )
  },
  loading(messageOrOpts, opts = {}) {
    const { title = 'Working…', message } = typeof messageOrOpts === 'string'
      ? { ...opts, message: messageOrOpts }
      : { ...opts, ...messageOrOpts }
    return toast.custom(
      (t) => (
        <ToastShell
          t={t}
          gradient="bg-zinc-900 dark:bg-zinc-800"
          glow="shadow-xl"
          icon={Loader2}
          title={title}
          message={message}
        />
      ),
      { duration: Infinity }
    )
  },
  dismiss: toast.dismiss,
}
