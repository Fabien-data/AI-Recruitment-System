import { useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { useAuthStore } from '../stores/authStore'

/**
 * Redirects to the dashboard and shows a one-time "no access" toast. Used as the
 * default deny behaviour for route guards so an unauthorized direct-URL visit
 * doesn't silently render nothing (UPGRADES.md #2).
 */
function AccessDeniedRedirect({ to = '/' }) {
  useEffect(() => {
    toast.error("You don't have access to that section.", { id: 'access-denied' })
  }, [])
  return <Navigate to={to} replace />
}

/**
 * RoleGuard — renders children only when the logged-in user passes the access
 * check. On denial it redirects to the dashboard with a notice (default), or
 * renders an explicit `fallback` if one is supplied.
 *
 * Filters (composable):
 *   - allowedRoles:    legacy role check (e.g. ['admin'])
 *   - requireSection:  section_key the user must have access to
 *   - action:          permission on that section ('view'|'create'|'edit'|'delete')
 *
 * Admin always passes. With both allowedRoles and requireSection, BOTH must pass.
 */
export default function RoleGuard({
  allowedRoles,
  requireSection,
  action = 'view',
  children,
  fallback,
}) {
  const user = useAuthStore((s) => s.user)
  const perms = useAuthStore((s) => s.sectionPermissions) || []

  // Not authenticated — let the explicit fallback (or nothing) handle it; the
  // surrounding PrivateRoute already redirects unauthenticated users to /login.
  if (!user) return fallback ?? null

  // Admin short-circuits all checks.
  if (user.role === 'admin') return children

  // Dashboard is universal for every authenticated user (mirrors the backend
  // UNIVERSAL_SECTIONS floor). Short-circuit so an empty/late sectionPermissions
  // array can never deny '/' and cause a redirect loop back to the dashboard.
  if (requireSection === 'dashboard' && action === 'view') return children

  let denied = false
  if (allowedRoles && !allowedRoles.includes(user.role)) denied = true
  if (!denied && requireSection) {
    const row = perms.find((p) => p.section_key === requireSection)
    if (!row || !row[`can_${action}`]) denied = true
  }

  if (denied) return fallback !== undefined ? fallback : <AccessDeniedRedirect />
  return children
}
