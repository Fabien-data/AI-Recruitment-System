import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function Input({
  label,
  error,
  className,
  id,
  type = 'text',
  ...props
}) {
  const inputId = id || props.name
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-semibold text-zinc-700 mb-1.5 ml-1 tracking-tight">
          {label}
        </label>
      )}
      <input
        type={type}
        id={inputId}
        className={twMerge(
          'w-full px-4 py-2.5 bg-zinc-50 border border-zinc-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-zinc-900/15 focus:border-zinc-400 transition-all disabled:opacity-50',
          error && 'border-red-400 focus:ring-red-400/20 focus:border-red-400 bg-red-50/50',
          className
        )}
        aria-invalid={!!error}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...props}
      />
      {error && (
        <p id={`${inputId}-error`} className="mt-1.5 ml-1 text-sm text-red-500 font-medium tracking-tight" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

