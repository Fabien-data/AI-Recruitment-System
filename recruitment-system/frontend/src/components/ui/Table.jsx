import { twMerge } from 'tailwind-merge'

export function Table({ children, className, density = 'comfortable', ...props }) {
  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table
        data-density={density}
        className={twMerge('w-full text-sm border-collapse', className)}
        {...props}
      >
        {children}
      </table>
    </div>
  )
}

function Head({ children, className, sticky = false, ...props }) {
  return (
    <thead
      className={twMerge(
        'bg-zinc-50/80 dark:bg-zinc-900/70 border-b border-zinc-200 dark:border-zinc-800',
        sticky && 'sticky top-0 z-10 backdrop-blur',
        className
      )}
      {...props}
    >
      {children}
    </thead>
  )
}

function Body({ children, className, ...props }) {
  return (
    <tbody className={twMerge('divide-y divide-zinc-100 dark:divide-zinc-800/70', className)} {...props}>
      {children}
    </tbody>
  )
}

const accentClass = {
  blue: 'border-l-2 border-l-blue-500/70',
  emerald: 'border-l-2 border-l-emerald-500/70',
  amber: 'border-l-2 border-l-amber-500/70',
  rose: 'border-l-2 border-l-rose-500/70',
  purple: 'border-l-2 border-l-purple-500/70',
  indigo: 'border-l-2 border-l-indigo-500/70',
  zinc: 'border-l-2 border-l-zinc-300/70 dark:border-l-zinc-700',
}

function Tr({ children, className, hover = true, accent, onClick, ...props }) {
  return (
    <tr
      onClick={onClick}
      className={twMerge(
        'transition-colors',
        hover && 'hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
        onClick && 'cursor-pointer',
        accent && accentClass[accent],
        className
      )}
      {...props}
    >
      {children}
    </tr>
  )
}

function Th({ children, className, icon: Icon, align = 'left', width, ...props }) {
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  return (
    <th
      style={width ? { width } : undefined}
      className={twMerge(
        'py-3 px-4 text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400 whitespace-nowrap',
        alignClass,
        className
      )}
      {...props}
    >
      <span className={twMerge('inline-flex items-center gap-1.5', align === 'right' && 'justify-end w-full')}>
        {Icon && <Icon size={13} className="text-zinc-400 dark:text-zinc-500" aria-hidden />}
        {children}
      </span>
    </th>
  )
}

function Td({ children, className, align = 'left', truncate = false, ...props }) {
  const alignClass = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  return (
    <td
      className={twMerge(
        'py-3 px-4 text-sm text-zinc-700 dark:text-zinc-300 align-middle',
        alignClass,
        truncate && 'truncate',
        className
      )}
      {...props}
    >
      {children}
    </td>
  )
}

Table.Head = Head
Table.Body = Body
Table.Tr = Tr
Table.Th = Th
Table.Td = Td
