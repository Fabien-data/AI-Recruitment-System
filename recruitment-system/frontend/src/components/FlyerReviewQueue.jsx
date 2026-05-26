import { useState } from 'react'
import { FlyerReviewModal } from './FlyerReviewModal'

/**
 * Walks the agent through each extracted flyer one at a time. Each step opens
 * a FlyerReviewModal that must reach "Save" (or "Skip" / "Cancel") before the
 * queue advances. The queue closes itself when the last file is handled.
 *
 * The CRM list refetches via the parent's onClose handler, so newly-saved jobs
 * appear under their chosen project as soon as the queue exits.
 */
export function FlyerReviewQueue({ files, onClose }) {
  const [index, setIndex] = useState(0)
  const total = files?.length || 0

  if (!files || total === 0) {
    return null
  }

  const advance = () => {
    if (index + 1 < total) {
      setIndex(index + 1)
    } else {
      onClose?.()
    }
  }

  const current = files[index]

  return (
    <FlyerReviewModal
      key={index}                 // remount so internal state resets per file
      file={current}
      step={index + 1}
      total={total}
      onSaved={advance}
      onSkip={advance}
      onCancelAll={() => onClose?.()}
    />
  )
}
