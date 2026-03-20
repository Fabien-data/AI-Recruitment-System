import { clsx } from 'clsx'

export function Card({ children, className, ...props }) {
  return (
    <div className={clsx('card', className)} {...props}>
      {children}
    </div>
  )
}

export function CardHeader({ children, className }) {
  return <div className={clsx('mb-4', className)}>{children}</div>
}

export function CardFooter({ children, className }) {
  return <div className={clsx('mt-4 pt-4 border-t border-gray-200', className)}>{children}</div>
}
