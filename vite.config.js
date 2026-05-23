import { defineConfig } from 'vite'

export default defineConfig({
  // El service worker se sirve desde /public/sw.js automáticamente
  build: {
    outDir: 'dist',
  },
})
