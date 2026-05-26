import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { apiClient } from '../api'

export const useAuthStore = create(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,

      login: async (email, password) => {
        const data = await apiClient.post('/api/auth/login', { email, password }).then(res => res.data)
        const { user, token } = data
        set({ user, token, isAuthenticated: true })
        apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`
        return user
      },

      register: async ({ email, password, full_name, role }) => {
        const data = await apiClient
          .post('/api/auth/register', { email, password, full_name, role })
          .then(res => res.data)
        const { user, token } = data
        set({ user, token, isAuthenticated: true })
        apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`
        return user
      },

      logout: () => {
        set({ user: null, token: null, isAuthenticated: false })
        delete apiClient.defaults.headers.common['Authorization']
      },

      setToken: (token) => {
        set({ token })
        if (token) {
          apiClient.defaults.headers.common['Authorization'] = `Bearer ${token}`
        }
      },
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
