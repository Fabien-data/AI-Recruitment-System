import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { apiClient } from '../api'

export const useAuthStore = create(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      // Migration 021: section-level permissions returned at login time so the
      // sidebar and route guards can filter without an extra round-trip.
      // Array of { section_key, can_view, can_create, can_edit, can_delete, source }.
      sectionPermissions: [],

      login: async (email, password) => {
        const data = await apiClient.post('/api/auth/login', { email, password }).then(res => res.data)
        const { user, token, section_permissions } = data
        set({
          user,
          token,
          isAuthenticated: true,
          sectionPermissions: section_permissions || [],
        })
        apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`
        return user
      },

      register: async ({ email, password, full_name, role }) => {
        const data = await apiClient
          .post('/api/auth/register', { email, password, full_name, role })
          .then(res => res.data)
        const { user, token } = data
        set({ user, token, isAuthenticated: true, sectionPermissions: [] })
        apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`
        return user
      },

      logout: async () => {
        // Best-effort: close the session row on the server before tearing down
        // local state. Network errors must not block the local logout.
        try {
          if (get().token) {
            await apiClient.post('/api/auth/logout')
          }
        } catch (_err) {
          // ignore — local state will be cleared anyway
        }
        set({ user: null, token: null, isAuthenticated: false, sectionPermissions: [] })
        delete apiClient.defaults.headers.common['Authorization']
      },

      setToken: (token) => {
        set({ token })
        if (token) {
          apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`
        }
      },

      // Allows the AdminDashboard to refresh perms after editing the current
      // user's own access, without forcing a full re-login.
      setSectionPermissions: (sectionPermissions) => set({ sectionPermissions: sectionPermissions || [] }),
    }),
    {
      name: 'auth-storage',
      onRehydrateStorage: () => (state) => {
        if (state?.token) {
          apiClient.defaults.headers.common['Authorization'] = `Bearer ${state.token}`
        }
      },
    }
  )
)

// Set auth header on load if token was already in memory
const token = useAuthStore.getState().token
if (token) {
  apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`
}

// ── Role helpers ─────────────────────────────────────────────────────────────
export const ROLES = {
  ADMIN: 'admin',
  PROJECT_HANDLER: 'project_handler',
  SOURCING_DEPARTMENT: 'sourcing_department',
  MARKETING_AGENT: 'marketing_agent',
}

export function useRole() {
  const user = useAuthStore((s) => s.user)
  const role = user?.role ?? null

  return {
    role,
    isAdmin: role === ROLES.ADMIN,
    isProjectHandler: role === ROLES.PROJECT_HANDLER,
    isSourcingDept: role === ROLES.SOURCING_DEPARTMENT,
    isMarketingAgent: role === ROLES.MARKETING_AGENT,
    // Can create/edit jobs and projects
    canEdit: role === ROLES.ADMIN || role === ROLES.SOURCING_DEPARTMENT || role === ROLES.PROJECT_HANDLER,
    // Can delete jobs (admin + sourcing)
    canDelete: role === ROLES.ADMIN || role === ROLES.SOURCING_DEPARTMENT,
    // Can delete candidates (admin only)
    canDeleteCandidate: role === ROLES.ADMIN,
    // Full analytics access
    hasFullAnalytics: role === ROLES.ADMIN || role === ROLES.SOURCING_DEPARTMENT,
    // Admin dashboard access
    hasAdminDashboard: role === ROLES.ADMIN,
    // Marketing Hub access
    hasMarketingHub: role === ROLES.ADMIN || role === ROLES.SOURCING_DEPARTMENT || role === ROLES.MARKETING_AGENT,
  }
}

/**
 * useSectionAccess('candidates', 'view') → boolean
 *
 * Admin always passes. For everyone else, looks up the section_permissions
 * array delivered by the login response. Used by RoleGuard and Layout's nav
 * builder to hide things the user can't see.
 */
export function useSectionAccess(sectionKey, action = 'view') {
  const role = useAuthStore((s) => s.user?.role)
  const perms = useAuthStore((s) => s.sectionPermissions) || []
  if (role === ROLES.ADMIN) return true
  // Dashboard is universal for any authenticated user (mirrors backend floor).
  if (sectionKey === 'dashboard' && action === 'view') return true
  const row = perms.find((p) => p.section_key === sectionKey)
  if (!row) return false
  return !!row[`can_${action}`]
}
