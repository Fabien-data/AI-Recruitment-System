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
        <label
          htmlFor={inputId}
          className="block text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 ml-1 tracking-tight"
        >
          {label}
        </label>
      )}
      <input
        type={type}
        id={inputId}
        className={twMerge(
          'w-full px-4 py-2.5 bg-zinc-50 border border-zinc-200/80 text-zinc-900 placeholder-zinc-400 rounded-2xl focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 transition-all disabled:opacity-50',
          'dark:bg-zinc-800/60 dark:border-zinc-700 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-primary-400',
          error && 'border-accent-400 focus:ring-accent-400/30 focus:border-accent-400 bg-accent-50/50 dark:bg-accent-950/20 dark:border-accent-700',
          className
        )}
        aria-invalid={!!error}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...props}
      />
      {error && (
        <p
          id={`${inputId}-error`}
          className="mt-1.5 ml-1 text-sm text-accent-600 dark:text-accent-400 font-medium tracking-tight"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  )
}
