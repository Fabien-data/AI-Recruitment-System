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
  (err) => {
    if (err.response?.status === 401) {
      const url = err.config?.url || ''
      if (!url.includes('/auth/login') && !url.includes('/auth/register')) {
        useAuthStore.getState().logout()
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5 * 60 * 1000,
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
