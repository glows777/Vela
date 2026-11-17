import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/preload/index.ts', import.meta.url)),
      fileName: () => 'preload.cjs',
      formats: ['cjs'],
    },
    rollupOptions: { external: ['electron'] },
  },
})
