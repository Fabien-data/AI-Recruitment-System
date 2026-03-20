import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'https://recruitment-backend-782458551389.us-central1.run.app',
        changeOrigin: true,
      },
      '/uploads': {
        target: process.env.VITE_API_URL || 'https://recruitment-backend-782458551389.us-central1.run.app',
        changeOrigin: true,
      },
    },
  },
})
