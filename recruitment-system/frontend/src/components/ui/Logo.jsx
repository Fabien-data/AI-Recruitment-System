import { clsx } from 'clsx'

export function Logo({ className, size = 32, showText = true }) {
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div
        className="relative flex items-center justify-center rounded-xl bg-brand-gradient shadow-glow-blue"
        style={{ width: size, height: size }}
      >
        <svg
          width={Math.round(size * 0.55)}
          height={Math.round(size * 0.55)}
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M16 8C11.5817 8 8 11.5817 8 16C8 20.4183 11.5817 24 16 24C20.4183 24 24 20.4183 24 16C24 11.5817 20.4183 8 16 8ZM16 21C13.2386 21 11 18.7614 11 16C11 13.2386 13.2386 11 16 11C18.7614 11 21 13.2386 21 16C21 18.7614 18.7614 21 16 21Z"
            className="fill-white opacity-95"
          />
          <path d="M20 16L15 11V21L20 16Z" className="fill-white" />
        </svg>
        <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-accent-gradient rounded-full shadow-glow-red" aria-hidden="true" />
      </div>
      {showText && (
        <span className="font-bold text-xl text-zinc-900 dark:text-zinc-100 tracking-tight">
          Recruit
          <span className="bg-accent-gradient bg-clip-text text-transparent">Pro</span>
        </span>
      )}
    </div>
  )
}
