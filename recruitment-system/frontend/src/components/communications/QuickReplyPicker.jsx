/**
 * QuickReplyPicker — canned, localized agent replies for the Messages composer.
 * ============================================================================
 * A small "Quick replies" button that opens a popover listing the templates for
 * the selected candidate's language (falling back to English). Picking one
 * renders its {name}/{job}/{phone} placeholders and hands the text back to the
 * parent via onInsert — it never sends. The parent decides whether to replace
 * or append the composer text.
 *
 * Props:
 *   selectedCandidate — the active conversation; read for name/job/phone/lang.
 *   onInsert(text)    — called with the rendered template body.
 */
import { useState, useEffect, useRef } from 'react'
import { Zap, ChevronDown } from 'lucide-react'
import { clsx } from 'clsx'
import { templatesForLang, renderTemplate } from '../../constants/quick-replies'

export function QuickReplyPicker({ selectedCandidate, onInsert }) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef(null)

  // Close on outside click — same pattern as JobAutocomplete.
  useEffect(() => {
    if (!open) return
    function onDocClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false)
    }
    function onEsc(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  if (!selectedCandidate) return null

  // Language drives which set we show; fall back to en for singlish/tanglish/
  // anything we don't have strings for.
  const lang = selectedCandidate.last_language || selectedCandidate.preferred_language || 'en'
  const templates = templatesForLang(lang)

  const vars = {
    name: selectedCandidate.display_name || selectedCandidate.name || 'there',
    job: selectedCandidate.effective_job_title || selectedCandidate.latest_job_title || 'the role',
    phone: selectedCandidate.phone || selectedCandidate.whatsapp_phone || '',
  }

  const pick = (body) => {
    onInsert(renderTemplate(body, vars))
    setOpen(false)
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[11px] text-indigo-600 hover:text-indigo-800"
        title="Insert a canned reply"
      >
        <Zap size={12} /> Quick replies
        <ChevronDown size={11} className={clsx('transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 bottom-full mb-1.5 z-30 w-64 max-h-72 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg py-1">
          {templates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pick(t.body)}
              className="w-full text-left px-3 py-2 hover:bg-indigo-50 dark:hover:bg-indigo-500/10 transition-colors"
            >
              <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{t.label}</div>
              <div className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate">
                {renderTemplate(t.body, vars)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
