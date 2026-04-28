import { useAuthStore } from '../stores/authStore'

/**
 * RoleGuard — renders children only when the logged-in user has one of
 * the allowed roles. Renders `fallback` (default: null) otherwise.
 *
 * Usage:
 *   <RoleGuard allowedRoles={['admin']}>
 *     <AdminDashboard />
 *   </RoleGuard>
 */
export default function RoleGuard({ allowedRoles, children, fallback = null }) {
  const user = useAuthStore((s) => s.user)

  if (!user || !allowedRoles.includes(user.role)) {
    return fallback
  }

  return children
}
