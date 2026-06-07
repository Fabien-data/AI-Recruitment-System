import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { apiClient } from './api'
import { useAuthStore } from './stores/authStore'
// Side-effect import: applies the persisted theme class to <html> before React mounts,
// preventing a flash of the wrong theme on load.
import './stores/themeStore'
import App from './App'
import './index.css'

apiClient.interceptors.response.use(
  (res) => res,
  async (err) => {
    const { response, config } = err
    if (response?.status === 401) {
      const url = config?.url || ''
      if (!url.includes('/auth/login') && !url.includes('/auth/register')) {
        useAuthStore.getState().logout()
        window.location.href = '/login'
      }
      return Promise.reject(err)
    }
    // Transient rate-limit (429): with ~20 agents hitting one backend instance, a
    // brief burst can trip the limiter. Retry a few times with backoff (honouring
    // the server's Retry-After) so it self-heals instead of surfacing as an error.
    if (response?.status === 429 && config) {
      config.__retryCount = (config.__retryCount || 0) + 1
      if (config.__retryCount <= 3) {
        const retryAfter = Number(response.headers?.['retry-after'])
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 10000)
          : Math.min(8000, 400 * 2 ** (config.__retryCount - 1)) + Math.floor(Math.random() * 300)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        return apiClient(config)
      }
    }
    return Promise.reject(err)
  }
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live-by-default: agents previously had to hard-refresh to see updates.
      // Refetch when the tab regains focus / the network reconnects, and treat
      // data as stale after 20s so a returning tab pulls fresh data. Socket
      // pushes (Communications + useRealtime) are the primary trigger; these
      // are the always-on backstop. refetchIntervalInBackground:false makes
      // every per-query refetchInterval pause while the tab is hidden.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
      staleTime: 20 * 1000,
      refetchIntervalInBackground: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <Toaster
          position="top-right"
          gutter={12}
          toastOptions={{
            duration: 3500,
            className: 'brand-toast-shadow',
            style: {
              borderRadius: '16px',
              padding: '12px 16px',
              background: 'rgba(255,255,255,0.96)',
              color: '#18181b',
              fontWeight: 600,
              fontSize: '14px',
              border: '1px solid rgba(24,24,27,0.08)',
              backdropFilter: 'blur(12px)',
            },
            success: {
              iconTheme: { primary: '#2563eb', secondary: 'white' },
              style: {
                background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                color: 'white',
                border: 'none',
              },
            },
            error: {
              iconTheme: { primary: 'white', secondary: '#dc2626' },
              style: {
                background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)',
                color: 'white',
                border: 'none',
              },
            },
            loading: {
              iconTheme: { primary: '#2563eb', secondary: '#dbeafe' },
            },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
