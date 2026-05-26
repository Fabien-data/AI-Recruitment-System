import { useState } from 'react'
import { Phone } from 'lucide-react'
import { twMerge } from 'tailwind-merge'

const THREECX_WEB_URL = import.meta.env.VITE_THREECX_WEB_URL

/**
 * ClickToCall — single button to start an outbound call.
 *
 * Strategy:
 *  - If VITE_THREECX_WEB_URL is configured, open the 3CX Web Client dial URL
 *    in a new tab so the call routes through the PBX and gets logged via
 *    the 3CX webhook (`lead_call_events`).
 *  - Otherwise fall back to a plain `tel:` link, which on a workstation
 *    with the 3CX Click2Call browser extension installed still hits 3CX,
 *    and on a phone just dials.
 *
 * The button is a regular <button> rather than <a> so we can keep both
 * behaviours behind one click handler without rendering two elements.
 */
export function ClickToCall({ phone, variant = 'pill', className, children }) {
  const [busy, setBusy] = useState(false)

  if (!phone) return null

  const handleClick = () => {
    if (busy) return
    setBusy(true)
    // Brief debounce so a double-click doesn't open two tabs.
    setTimeout(() => setBusy(false), 600)

    if (THREECX_WEB_URL) {
      const encoded = encodeURIComponent(phone)
      const url = THREECX_WEB_URL.includes('{phone}')
        ? THREECX_WEB_URL.replace('{phone}', encoded)
        : `${THREECX_WEB_URL.replace(/\/$/, '')}?phone=${encoded}`
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }

    window.location.href = `tel:${phone}`
  }

  const variants = {
    pill: 'inline-flex items-center gap-2 px-3 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-2xl text-sm font-semibold hover:bg-emerald-100 transition-colors',
    inline: 'inline-flex items-center gap-1 text-sm text-emerald-700 hover:text-emerald-800 font-semibold',
    icon: 'inline-flex items-center justify-center w-8 h-8 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-full hover:bg-emerald-100 transition-colors',
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      className={twMerge(variants[variant] || variants.pill, className)}
      aria-label={`Call ${phone}`}
      title={THREECX_WEB_URL ? `Dial via 3CX: ${phone}` : `Dial: ${phone}`}
    >
      <Phone size={variant === 'icon' ? 14 : 14} />
      {variant !== 'icon' && (children || 'Call')}
    </button>
  )
}
