import toast from 'react-hot-toast'

const CHANNEL_LABELS = {
  whatsapp: 'WhatsApp',
  email: 'Email',
  sms: 'SMS',
}

function fmtChannel(c) {
  return CHANNEL_LABELS[c] || c
}

/**
 * Render a delivery-status toast from a backend `notification` field.
 * Shape: { success: [{channel, ...}], failed: [{channel, error}] }
 *
 * - All channels succeeded -> green toast
 * - Any failure with no success -> red toast
 * - Mixed -> amber toast listing which channels failed and why
 * - No notification object (legacy response) -> green fallback with `fallbackText`
 */
export function showNotificationToast(notification, fallbackText = 'Action completed') {
  if (!notification || (!notification.success && !notification.failed)) {
    toast.success(fallbackText)
    return
  }

  const success = notification.success || []
  const failed = notification.failed || []

  if (failed.length === 0 && success.length > 0) {
    const sent = success.map((s) => fmtChannel(s.channel)).join(', ')
    toast.success(`${fallbackText} — sent via ${sent}`, { duration: 4500 })
    return
  }

  if (success.length === 0 && failed.length > 0) {
    const detail = failed
      .map((f) => `${fmtChannel(f.channel)} (${f.error || 'failed'})`)
      .join('; ')
    toast.error(`${fallbackText} — notification failed: ${detail}`, { duration: 7000 })
    return
  }

  // Mixed: at least one succeeded, at least one failed
  const sent = success.map((s) => fmtChannel(s.channel)).join(', ')
  const failedDetail = failed
    .map((f) => `${fmtChannel(f.channel)} (${f.error || 'failed'})`)
    .join('; ')

  toast(
    `${fallbackText} — sent via ${sent}; failed: ${failedDetail}`,
    {
      icon: '⚠️',
      duration: 7000,
      style: { background: '#fef3c7', color: '#92400e', border: '1px solid #f59e0b' },
    }
  )
}

/**
 * Convenience helper for the rare case where a route returns a top-level
 * success boolean but no per-channel detail (e.g. legacy endpoint).
 */
export function showErrorToast(error, prefix = 'Request failed') {
  const msg = error?.response?.data?.error || error?.message || 'Unknown error'
  toast.error(`${prefix}: ${msg}`, { duration: 6000 })
}
