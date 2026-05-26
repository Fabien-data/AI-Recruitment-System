import { twMerge } from 'tailwind-merge'

const tones = {
  blue: {
    bg: 'bg-brand-gradient',
    glow: 'shadow-glow-blue',
    ring: 'ring-primary-500/20',
  },
  red: {
    bg: 'bg-accent-gradient',
    glow: 'shadow-glow-red',
    ring: 'ring-accent-500/20',
  },
  mixed: {
    bg: 'bg-mixed-gradient',
    glow: 'shadow-glow-blue',
    ring: 'ring-primary-500/20',
  },
}

const sizes = {
  sm: { box: 'w-9 h-9 rounded-xl', icon: 18 },
  md: { box: 'w-11 h-11 rounded-2xl', icon: 22 },
  lg: { box: 'w-14 h-14 rounded-2xl', icon: 26 },
  xl: { box: 'w-16 h-16 rounded-3xl', icon: 30 },
}

export function SectionIcon({ icon: Icon, tone = 'blue', size = 'md', className }) {
  const t = tones[tone] || tones.blue
  const s = sizes[size] || sizes.md
  return (
    <div
      className={twMerge(
        'flex items-center justify-center text-white ring-1',
        t.bg,
        t.glow,
        t.ring,
        s.box,
        className
      )}
      aria-hidden="true"
    >
      {Icon && <Icon size={s.icon} strokeWidth={2.25} />}
    </div>
  )
}
