import { useAuthStore } from '../stores/authStore'

/**
 * RoleGuard — renders children only when the logged-in user passes the access
 * check. Renders `fallback` (default: null) otherwise.
 *
 * Three composable filters:
 *   - allowedRoles:    legacy role check (e.g. ['admin', 'sourcing_department'])
 *   - requireSection:  section_key (e.g. 'candidates') the user must have access to
 *   - action:          which permission on that section ('view'|'create'|'edit'|'delete')
 *
 * Admin always passes. A request with both allowedRoles and requireSection
 * must satisfy BOTH. If neither is given, only authentication is required.
 *
 * Usage:
 *   <RoleGuard allowedRoles={['admin']}><AdminDashboard /></RoleGuard>
 *   <RoleGuard requireSection="marketing_hub" action="view" fallback={<Navigate to="/" />}>
 *     <MarketingHub />
 *   </RoleGuard>
 */
export default function RoleGuard({
  allowedRoles,
  requireSection,
  action = 'view',
  children,
  fallback = null,
}) {
  const user = useAuthStore((s) => s.user)
  const perms = useAuthStore((s) => s.sectionPermissions) || []

  if (!user) return fallback

  // Admin short-circuits all checks.
  if (user.role === 'admin') return children

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return fallback
  }

  if (requireSection) {
    const row = perms.find((p) => p.section_key === requireSection)
    if (!row || !row[`can_${action}`]) return fallback
  }

  return children
}
