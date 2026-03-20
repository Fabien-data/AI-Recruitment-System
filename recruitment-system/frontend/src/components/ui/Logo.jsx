import { clsx } from 'clsx'

export function Logo({ className, size = 32 }) {
  return (
    <div className={clsx("flex items-center gap-2", className)}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <rect width="32" height="32" rx="8" className="fill-primary-600" />
        <path
          d="M16 8C11.5817 8 8 11.5817 8 16C8 20.4183 11.5817 24 16 24C20.4183 24 24 20.4183 24 16C24 11.5817 20.4183 8 16 8ZM16 21C13.2386 21 11 18.7614 11 16C11 13.2386 13.2386 11 16 11C18.7614 11 21 13.2386 21 16C21 18.7614 18.7614 21 16 21Z"
          className="fill-white opacity-90"
        />
        <path
          d="M20 16L15 11V21L20 16Z"
          className="fill-white"
        />
      </svg>
      <span className="font-bold text-xl text-gray-900 tracking-tight">Recruit<span className="text-primary-600">Pro</span></span>
    </div>
  )
}
