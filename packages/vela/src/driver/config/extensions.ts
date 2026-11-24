import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { VelaExtension } from '../extensions/types.ts'

const require = createRequire(import.meta.url)
const HOST_MODULES_KEY = Symbol.for('vela.jiti.hostModules')
const hostLoaders: Record<string, () => Promise<unknown>> = {
  zod: () => import('zod'),
}
let shimDir: string | undefined
const bunBuiltPaths = new Map<string, Promise<string>>()

/** @internal Registers lazy host module loaders for bundled single-file builds lacking sibling files. */
export function registerExtensionHostModules(
  loaders: Record<string, () => Promise<unknown>>,
): void {
  Object.assign(hostLoaders, loaders)
}

function resolveOptional(id: string): string | undefined {
  try {
    return require.resolve(id)
  } catch {
    return undefined
  }
}

function resolveSibling(relative: string): string | undefined {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  return existsSync(path) ? path : undefined
}

function resolveDiskAliases(): Map<string, string> {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const map = new Map<string, string>()
  const extensionApi = resolveSibling(`../../extension-api${ext}`)
  const velaRoot = resolveSibling(`../../index${ext}`)
  const zod = resolveOptional('zod')
  if (extensionApi) map.set('@glows777/vela/extension-api', extensionApi)
  if (velaRoot) map.set('@glows777/vela', velaRoot)
  if (zod) map.set('zod', zod)
  return map
}

function ensureShimDir(): string {
  if (!shimDir) {
    shimDir = mkdtempSync(join(tmpdir(), 'vela-ext-host-'))
    chmodSync(shimDir, 0o700)
    const dir = shimDir
    process.once('exit', () => {
      rmSync(dir, { recursive: true, force: true })
    })
  }
  return shimDir
}

function storeHostModule(specifier: string, loaded: unknown): void {
  const hostGlobal = globalThis as unknown as Record<
    symbol,
    Record<string, unknown> | undefined
  >
  let store = hostGlobal[HOST_MODULES_KEY]
  if (!store) {
    store = {}
    hostGlobal[HOST_MODULES_KEY] = store
  }
  store[specifier] =
    loaded && typeof loaded === 'object'
      ? { ...(loaded as Record<string, unknown>) }
      : loaded
}

async function loadHostModule(
  specifier: string,
  diskPath?: string,
): Promise<boolean> {
  const loader =
    hostLoaders[specifier] ??
    (diskPath ? () => import(pathToFileURL(diskPath).href) : undefined)
  if (!loader) return false
  storeHostModule(specifier, await loader())
  return true
}

interface BunBuildPlugin {
  name: string
  setup(build: {
    onResolve(
      opts: { filter: RegExp },
      cb: (args: {
        path: string
      }) => { path: string; namespace?: string } | undefined,
    ): void
    onLoad(
      opts: { filter: RegExp; namespace: string },
      cb: (args: {
        path: string
      }) => Promise<{ contents: string; loader: 'js' }>,
    ): void
  }): void
}

interface BunLike {
  build(options: {
    entrypoints: string[]
    target: 'bun'
    format: 'esm'
    plugins: BunBuildPlugin[]
  }): Promise<{
    success: boolean
    logs: unknown[]
    outputs: Array<{ text(): Promise<string> }>
  }>
}

function buildExtensionWithBun(
  bun: BunLike,
  sourcePath: string,
): Promise<string> {
  let key: string
  try {
    key = realpathSync(sourcePath)
  } catch {
    key = sourcePath
  }
  const cached = bunBuiltPaths.get(key)
  if (cached) return cached
  const pending = (async () => {
    const diskAliases = resolveDiskAliases()
    const hostSpecifiers = new Set([
      '@glows777/vela',
      '@glows777/vela/extension-api',
      'zod',
    ])
    const result = await bun.build({
      entrypoints: [key],
      target: 'bun',
      format: 'esm',
      plugins: [
        {
          name: 'vela-extension-host',
          setup(build) {
            build.onResolve({ filter: /.*/ }, (args) => {
              if (!hostSpecifiers.has(args.path)) return undefined
              if (hostLoaders[args.path] || diskAliases.has(args.path))
                return { path: args.path, namespace: 'vela-host' }
              return undefined
            })
            build.onLoad(
              { filter: /.*/, namespace: 'vela-host' },
              async (args) => {
                await loadHostModule(args.path, diskAliases.get(args.path))
                return {
                  contents: `module.exports = globalThis[Symbol.for('vela.jiti.hostModules')][${JSON.stringify(args.path)}];\n`,
                  loader: 'js',
                }
              },
            )
          },
        },
      ],
    })
    if (!result.success || result.outputs.length === 0) {
      throw new Error(
        `Failed to bundle extension ${sourcePath}: ${result.logs.map((l) => String(l)).join('; ')}`,
      )
    }
    const dir = ensureShimDir()
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
    const outPath = join(dir, `ext-${hash}.mjs`)
    writeFileSync(outPath, await result.outputs[0]!.text(), { mode: 0o600 })
    return outPath
  })().catch((error) => {
    bunBuiltPaths.delete(key)
    throw error
  })
  bunBuiltPaths.set(key, pending)
  return pending
}

async function resolveAliasWithShim(
  specifier: string,
  diskPath: string | undefined,
  shimFile: string,
): Promise<string | undefined> {
  if (diskPath) return diskPath
  if (!(await loadHostModule(specifier))) return undefined
  const target = join(ensureShimDir(), shimFile)
  writeFileSync(
    target,
    `module.exports = globalThis[Symbol.for('vela.jiti.hostModules')][${JSON.stringify(specifier)}]\n`,
    { mode: 0o600 },
  )
  return target
}

type JitiInstance = ReturnType<typeof import('jiti').createJiti>

let jitiPromise: Promise<JitiInstance> | undefined

function getJiti(): Promise<JitiInstance> {
  if (jitiPromise) return jitiPromise
  jitiPromise = (async () => {
    const { createJiti } = await import('jiti')
    const disk = resolveDiskAliases()
    const alias: Record<string, string> = {}
    const extensionApi = await resolveAliasWithShim(
      '@glows777/vela/extension-api',
      disk.get('@glows777/vela/extension-api'),
      'extension-api.cjs',
    )
    const velaRoot = await resolveAliasWithShim(
      '@glows777/vela',
      disk.get('@glows777/vela'),
      'vela.cjs',
    )
    const zod = await resolveAliasWithShim('zod', disk.get('zod'), 'zod.cjs')
    if (extensionApi) alias['@glows777/vela/extension-api'] = extensionApi
    if (velaRoot) alias['@glows777/vela'] = velaRoot
    if (zod) alias.zod = zod
    // Reuse one instance with moduleCache enabled to match native ESM singleton semantics.
    return createJiti(import.meta.url, {
      interopDefault: true,
      moduleCache: true,
      tryNative: false,
      alias,
    })
  })().catch((err) => {
    jitiPromise = undefined
    throw err
  })
  return jitiPromise
}

/**
 * Loads an extension file whose default export is `(vela) => {}`. The returned
 * function is named after the extension, which sets its tool prefix and config section.
 * Uses native TS under Bun (falling back to virtualized Bun.build host aliases when needed),
 * and jiti under Node.js so external `.ts` extensions resolve `@glows777/vela` and `zod`.
 */
export async function importExtension(
  path: string,
  name: string,
): Promise<VelaExtension> {
  let factory: unknown
  const bun = (globalThis as { Bun?: BunLike }).Bun
  if (bun) {
    try {
      const mod = (await import(pathToFileURL(path).href)) as {
        default?: unknown
      }
      factory = mod.default
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(message))
        throw error
      const builtPath = await buildExtensionWithBun(bun, path)
      const mod = (await import(pathToFileURL(builtPath).href)) as {
        default?: unknown
      }
      factory = mod.default
    }
  } else {
    const jiti = await getJiti()
    factory = await jiti.import(path, { default: true })
  }
  if (typeof factory !== 'function')
    throw new Error(`Extension ${path} has no default export (vela) => {}`)
  // Computed property name names the function; the runner uses extension.name as the extension name
  return {
    [name]: (vela: Parameters<VelaExtension>[0]) =>
      (factory as VelaExtension)(vela),
  }[name] as VelaExtension
}
