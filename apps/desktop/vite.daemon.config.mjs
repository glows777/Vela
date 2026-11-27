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
      entry: 'src/main/daemon.ts',
      fileName: () => 'daemon.mjs',
      formats: ['es'],
    },
    rolldownOptions: {
      // Node 22.18 omits scheme-only `node:sqlite` from `builtinModules`, so Forge's default
      // externals miss it and Vite replaces it with a browser-compatibility stub in CI.
      external: ['node:sqlite'],
      output: {
        // Unpacked daemon.mjs executes directly via ELECTRON_RUN_AS_NODE=1 outside app.asar,
        // so all JS chunks and dynamic imports must stay inline in this single file.
        inlineDynamicImports: true,
        // Extension factories use their names to select configuration.
        keepNames: true,
        banner:
          "import { createRequire as __nodeCreateRequire } from 'node:module'; import { fileURLToPath as __nodeFileURLToPath } from 'node:url'; import { dirname as __nodeDirname } from 'node:path'; const require = __nodeCreateRequire(import.meta.url); const __filename = __nodeFileURLToPath(import.meta.url); const __dirname = __nodeDirname(__filename);",
      },
    },
  },
})
