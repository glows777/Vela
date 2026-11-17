import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const photonWasm = join(
  dirname(require.resolve('@silvia-odwyer/photon-node')),
  'photon_rs_bg.wasm',
)

export default defineConfig({
  plugins: [
    {
      name: 'photon-wasm',
      apply: 'build',
      buildStart() {
        // Photon resolves this file beside its emitted JS at runtime.
        this.emitFile({
          type: 'asset',
          fileName: 'photon_rs_bg.wasm',
          source: readFileSync(photonWasm),
        })
      },
    },
  ],
  build: {
    lib: {
      entry: 'src/main/index.ts',
      fileName: () => 'main.mjs',
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        banner:
          "import { createRequire as __nodeCreateRequire } from 'node:module'; import { fileURLToPath as __nodeFileURLToPath } from 'node:url'; import { dirname as __nodeDirname } from 'node:path'; const require = __nodeCreateRequire(import.meta.url); const __filename = __nodeFileURLToPath(import.meta.url); const __dirname = __nodeDirname(__filename);",
      },
    },
  },
})
