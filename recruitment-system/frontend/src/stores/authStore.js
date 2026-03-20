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
