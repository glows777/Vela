import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const velaPackageJson = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/vela/package.json',
)
const velaRequire = createRequire(velaPackageJson)
const velaSdkVersion = JSON.parse(readFileSync(velaPackageJson, 'utf8')).version
const photonWasm = join(
  dirname(require.resolve('@silvia-odwyer/photon-node')),
  'photon_rs_bg.wasm',
)
const jitiBabel = join(
  dirname(velaRequire.resolve('jiti/package.json')),
  'dist',
  'babel.cjs',
)

export default defineConfig({
  define: {
    __VELA_SDK_VERSION__: JSON.stringify(velaSdkVersion),
  },
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
    {
      name: 'jiti-babel',
      apply: 'build',
      buildStart() {
        // jiti loads babel.cjs dynamically via createRequire(import.meta.url) under ELECTRON_RUN_AS_NODE.
        this.emitFile({
          type: 'asset',
          fileName: 'babel.cjs',
          source: readFileSync(jitiBabel),
        })
      },
      transform(code, id) {
        if (
          id.replaceAll('\\', '/').endsWith('/jiti/lib/jiti.mjs') &&
          code.includes('"../dist/babel.cjs"')
        ) {
          return code.replace('"../dist/babel.cjs"', '"./babel.cjs"')
        }
        return undefined
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
