import { MapPin } from 'lucide-react'

// Render a 2-letter ISO country code as an emoji flag. Falls back to a pin icon.
function countryEmoji(code) {
  if (!code || code.length !== 2) return null
  const upper = code.toUpperCase()
  const A = 0x1f1e6
  return String.fromCodePoint(A + upper.charCodeAt(0) - 65) + String.fromCodePoint(A + upper.charCodeAt(1) - 65)
}

export function CountryFlag({ code, name, className = '' }) {
  if (!code && !name) return null
  const flag = countryEmoji(code)
  return (
    <span className={`inline-flex items-center gap-1 text-sm text-zinc-700 dark:text-zinc-300 ${className}`}>
      {flag ? (
        <span aria-hidden className="text-base leading-none">{flag}</span>
      ) : (
        <MapPin size={12} aria-hidden />
      )}
      {name || code}
    </span>
  )
}
