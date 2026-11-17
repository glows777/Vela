import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    // Forge preserves symlinks; Bun's isolated dependencies need real package paths.
    preserveSymlinks: false,
    alias: { '@': fileURLToPath(new URL('./src/renderer', import.meta.url)) },
  },
  plugins: [react()],
  optimizeDeps: { entries: ['index.html', 'specimen.html'] },
  server: { host: '127.0.0.1' },
  build: { rollupOptions: { input: 'index.html' } },
})
