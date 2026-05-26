import { Mail, Phone, Globe, Footprints, UserPlus, Bot, MessageSquare } from 'lucide-react'

// Inline brand SVGs (Lucide doesn't ship brand icons)
function WhatsAppGlyph({ size = 14 }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M16 0C7.2 0 0 7.2 0 16c0 2.8.7 5.5 2.1 7.9L0 32l8.4-2c2.3 1.2 4.9 1.9 7.6 1.9 8.8 0 16-7.2 16-16S24.8 0 16 0zm0 29c-2.5 0-4.8-.7-6.9-2l-.5-.3-4.9 1.2 1.3-4.8-.3-.5C3.3 20.6 2.6 18.3 2.6 16 2.6 8.6 8.6 2.6 16 2.6S29.4 8.6 29.4 16 23.4 29.4 16 29.4zm7.4-9.6c-.4-.2-2.4-1.2-2.8-1.3-.4-.1-.6-.2-.9.2-.3.4-1 1.3-1.3 1.6-.2.3-.5.3-.9.1-2.3-1.1-3.8-2-5.3-4.6-.4-.7.4-.6 1.1-2 .1-.3.1-.5 0-.7-.1-.2-.9-2.2-1.2-3-.3-.8-.7-.7-.9-.7h-.8c-.3 0-.7.1-1.1.5s-1.5 1.5-1.5 3.5c0 2.1 1.5 4.1 1.7 4.4.2.3 3 4.7 7.4 6.6 2.6 1.1 3.6 1.2 4.9 1 .8-.1 2.4-1 2.7-1.9.3-.9.3-1.7.2-1.9-.1-.2-.4-.3-.8-.5z" />
    </svg>
  )
}

function MessengerGlyph({ size = 14 }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M16 1.3C7.6 1.3 1 7.5 1 15.6c0 4.3 1.9 8 4.9 10.6V32l4.7-2.6c1.7.5 3.5.7 5.4.7 8.4 0 15-6.2 15-14.3S24.4 1.3 16 1.3zm1.6 19.6L13.8 17l-7.2 4 7.9-8.4 3.9 3.9 7.1-3.9-7.9 8.3z" />
    </svg>
  )
}

const SOURCE_MAP = {
  whatsapp: {
    label: 'WhatsApp',
    Icon: WhatsAppGlyph,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_0_2px_rgba(16,185,129,0.18)]',
    pillClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800/60',
    animate: 'animate-pulse-soft',
    dot: 'bg-emerald-500',
  },
  whatsapp_chatbot: {
    label: 'WhatsApp Bot',
    Icon: WhatsAppGlyph,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_0_2px_rgba(16,185,129,0.18)]',
    pillClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800/60',
    animate: 'animate-pulse-soft',
    dot: 'bg-emerald-500',
  },
  chatbot_intake: {
    label: 'Chatbot',
    Icon: Bot,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-violet-400 to-violet-600',
    pillClass: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-800/60',
    dot: 'bg-violet-500',
  },
  email: {
    label: 'Email',
    Icon: Mail,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-sky-400 to-sky-600',
    pillClass: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800/60',
    dot: 'bg-sky-500',
  },
  messenger: {
    label: 'Messenger',
    Icon: MessengerGlyph,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-blue-400 via-fuchsia-500 to-purple-600',
    pillClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800/60',
    dot: 'bg-blue-500',
  },
  phone: {
    label: 'Phone',
    Icon: Phone,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-indigo-400 to-indigo-600',
    pillClass: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-300 dark:border-indigo-800/60',
    animate: 'animate-wiggle',
    dot: 'bg-indigo-500',
  },
  walkin: {
    label: 'Walk-in',
    Icon: Footprints,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-amber-400 to-amber-600',
    pillClass: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800/60',
    dot: 'bg-amber-500',
  },
  web: {
    label: 'Web',
    Icon: Globe,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-cyan-400 to-cyan-600',
    pillClass: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/50 dark:text-cyan-300 dark:border-cyan-800/60',
    dot: 'bg-cyan-500',
  },
  manual: {
    label: 'Manual',
    Icon: UserPlus,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-zinc-400 to-zinc-600',
    pillClass: 'bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
    dot: 'bg-zinc-500',
  },
  agent_dashboard: {
    label: 'Agent',
    Icon: UserPlus,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-rose-400 to-rose-600',
    pillClass: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800/60',
    dot: 'bg-rose-500',
  },
  auto_ingest: {
    label: 'Auto-Ingest',
    Icon: Bot,
    iconClass: 'text-white',
    iconWrap: 'bg-gradient-to-br from-teal-400 to-teal-600',
    pillClass: 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/50 dark:text-teal-300 dark:border-teal-800/60',
    dot: 'bg-teal-500',
  },
}

const FALLBACK = {
  label: 'Unknown',
  Icon: MessageSquare,
  iconClass: 'text-white',
  iconWrap: 'bg-gradient-to-br from-zinc-400 to-zinc-500',
  pillClass: 'bg-zinc-100 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700',
  dot: 'bg-zinc-400',
}

function resolveSource(rawSource) {
  if (!rawSource) return { key: 'unknown', meta: FALLBACK }
  const key = String(rawSource).toLowerCase().trim()
  return { key, meta: SOURCE_MAP[key] || { ...FALLBACK, label: rawSource } }
}

/**
 * Pill-style badge with animated icon for a candidate source.
 *
 * variant="pill"   → full pill with icon + label (default)
 * variant="icon"   → just the icon disc (compact rows)
 * variant="dot"    → tiny colored dot + label (ultra-compact)
 */
export function SourceBadge({ source, variant = 'pill', className = '' }) {
  const { meta } = resolveSource(source)
  const { Icon, iconClass, iconWrap, pillClass, animate, label } = meta

  if (variant === 'icon') {
    return (
      <span
        title={label}
        className={`inline-flex items-center justify-center w-7 h-7 rounded-full ${iconWrap} ${animate || ''} ${className}`}
        aria-label={`Source: ${label}`}
      >
        <Icon size={14} className={iconClass} />
      </span>
    )
  }

  if (variant === 'dot') {
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 ${className}`}>
        <span className={`w-2 h-2 rounded-full ${meta.dot} ${animate || ''}`} />
        {label}
      </span>
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1.5 pl-1 pr-2.5 py-0.5 rounded-full border text-xs font-semibold tracking-tight ${pillClass} ${className}`}
      aria-label={`Source: ${label}`}
    >
      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full ${iconWrap} ${animate || ''}`}>
        <Icon size={11} className={iconClass} />
      </span>
      {label}
    </span>
  )
}
