import { useState, useEffect } from 'react'
import { Phone, PhoneOff, Loader2 } from 'lucide-react'

/**
 * CallPresenceToggle — in-call presence switch for the selected conversation.
 *
 * Lets an agent flag "I'm on a phone call with this candidate" so the other
 * agents see it live (via the `call_status_changed` Socket.io event) and don't
 * double-call. The dialer is external (CrazyCall) so this is a manual toggle.
 *
 * States:
 *   - on call by me      → red "End call · M:SS" (live elapsed timer)
 *   - on call by another → amber "<Agent> on call" badge + "Call anyway"
 *   - idle               → "On a call" button
 *
 * The parent owns the mutations and the conflict warning (start returns 409 if
 * another agent is already on the call; the parent confirms then forces).
 */
function fmtElapsed(startIso) {
  if (!startIso) return ''
  const start = new Date(startIso).getTime()
  if (Number.isNaN(start)) return ''
  const secs = Math.max(0, Math.floor((Date.now() - start) / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function CallPresenceToggle({ candidate, currentUserId, starting, ending, onStart, onEnd }) {
  const onCall = candidate?.call_status === 'on_call'
  const mine = onCall && candidate?.call_agent_id === currentUserId
  const [, tick] = useState(0)

  // Re-render once a second while a call is active so the elapsed timer ticks.
  useEffect(() => {
    if (!onCall) return undefined
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [onCall])

  if (mine) {
    return (
      <button
        type="button"
        onClick={onEnd}
        disabled={ending}
        className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-60 transition-colors"
        title="End your call with this candidate"
      >
        {ending ? <Loader2 size={14} className="animate-spin" /> : <PhoneOff size={14} />}
        End call · {fmtElapsed(candidate.call_started_at)}
      </button>
    )
  }

  if (onCall) {
    return (
      <div className="inline-flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">
          <Phone size={12} className="animate-pulse" /> {candidate.call_agent_name || 'Agent'} on call · {fmtElapsed(candidate.call_started_at)}
        </span>
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="text-[11px] text-zinc-500 hover:text-rose-600 underline underline-offset-2 disabled:opacity-60"
          title="Start a call anyway (you'll be warned first)"
        >
          Call anyway
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onStart}
      disabled={starting}
      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-60 transition-colors"
      title="Mark that you're on a phone call with this candidate"
    >
      {starting ? <Loader2 size={14} className="animate-spin" /> : <Phone size={14} />}
      On a call
    </button>
  )
}
