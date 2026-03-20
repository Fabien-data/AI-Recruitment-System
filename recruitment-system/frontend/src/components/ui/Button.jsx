import { clsx } from 'clsx'
import { Loader2 } from 'lucide-react'

const variants = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  ghost: 'btn btn-ghost',
}

export function Button({
  children,
  variant = 'primary',
  loading = false,
  disabled,
  className,
  type = 'button',
  ...props
}) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={clsx(variants[variant], 'inline-flex items-center justify-center gap-2', className)}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}
