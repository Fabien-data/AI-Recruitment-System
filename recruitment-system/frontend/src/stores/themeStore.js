import { create } from 'zustand'

const STORAGE_KEY = 'recruitpro-theme'

function applyThemeClass(theme) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
}

function readInitialTheme() {
  if (typeof window === 'undefined') return 'light'
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const useThemeStore = create((set, get) => ({
  theme: readInitialTheme(),
  setTheme: (theme) => {
    applyThemeClass(theme)
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, theme)
    set({ theme })
  },
  toggle: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },
}))

// Apply once at module load so the class is on <html> before React renders.
applyThemeClass(readInitialTheme())
