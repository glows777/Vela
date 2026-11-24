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
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { VelaExtension } from '../extensions/types.ts'

const require = createRequire(import.meta.url)
const HOST_MODULES_KEY = Symbol.for('vela.jiti.hostModules')
const hostLoaders: Record<string, () => Promise<unknown>> = {
  zod: () => import('zod'),
}
let shimDir: string | undefined
const bunBuiltUrls = new Map<string, Promise<string>>()

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
      cb: (args: { path: string }) => { contents: string; loader: 'js' },
    ): void
  }): void
}

interface BunLike {
  build(options: {
    entrypoints: string[]
    target: 'bun'
    format: 'esm'
    plugins: BunBuildPlugin[]
    define?: Record<string, string>
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
  const cached = bunBuiltUrls.get(key)
  if (cached) return cached
  const pending = (async () => {
    const diskAliases = resolveDiskAliases()
    const hostSpecifiers = new Set([
      '@glows777/vela',
      '@glows777/vela/extension-api',
      ...(hasLocalPackage(key, 'zod') ? [] : ['zod']),
    ])
    const needed = new Set<string>()
    let result: Awaited<ReturnType<BunLike['build']>>
    try {
      result = await bun.build({
        entrypoints: [key],
        target: 'bun',
        format: 'esm',
        define: {
          'import.meta.url': JSON.stringify(pathToFileURL(key).href),
          'import.meta.dir': JSON.stringify(dirname(key)),
          'import.meta.path': JSON.stringify(key),
        },
        plugins: [
          {
            name: 'vela-extension-host',
            setup(build) {
              build.onResolve({ filter: /.*/ }, (args) => {
                if (!hostSpecifiers.has(args.path)) return undefined
                if (hostLoaders[args.path] || diskAliases.has(args.path)) {
                  needed.add(args.path)
                  return { path: args.path, namespace: 'vela-host' }
                }
                return undefined
              })
              build.onLoad(
                { filter: /.*/, namespace: 'vela-host' },
                (args) => ({
                  contents: `module.exports = globalThis[Symbol.for('vela.jiti.hostModules')][${JSON.stringify(args.path)}];\n`,
                  loader: 'js',
                }),
              )
            },
          },
        ],
      })
    } catch (error) {
      const detail =
        error instanceof AggregateError
          ? error.errors.map(String).join('; ')
          : error instanceof Error
            ? error.message
            : String(error)
      throw new Error(`Failed to bundle extension ${sourcePath}: ${detail}`)
    }
    if (!result.success || result.outputs.length === 0) {
      throw new Error(
        `Failed to bundle extension ${sourcePath}: ${result.logs.map((l) => String(l)).join('; ')}`,
      )
    }
    await Promise.all(
      [...needed].map((spec) => loadHostModule(spec, diskAliases.get(spec))),
    )
    const code = `${await result.outputs[0]!.text()}\n//# sourceURL=${pathToFileURL(key).href}\n`
    return `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
  })().catch((error) => {
    bunBuiltUrls.delete(key)
    throw error
  })
  bunBuiltUrls.set(key, pending)
  return pending
}

async function resolveAliasWithShim(
  specifier: string,
  diskPath: string | undefined,
  shimFile: string,
  forceHostBridge = false,
): Promise<string | undefined> {
  if (!forceHostBridge && diskPath) return diskPath
  if (
    !(await loadHostModule(specifier, forceHostBridge ? diskPath : undefined))
  )
    return diskPath
  const target = join(ensureShimDir(), shimFile)
  writeFileSync(
    target,
    `module.exports = globalThis[Symbol.for('vela.jiti.hostModules')][${JSON.stringify(specifier)}]\n`,
    { mode: 0o600 },
  )
  return target
}

function hasLocalPackage(fromPath: string, specifier: string): boolean {
  let target = fromPath
  try {
    target = realpathSync(fromPath)
  } catch {
    // Fall back to the provided path if realpath fails.
  }
  let dir = dirname(target)
  while (true) {
    if (existsSync(join(dir, 'node_modules', specifier, 'package.json')))
      return true
    const parent = dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

type JitiInstance = ReturnType<typeof import('jiti').createJiti>

const jitiPromises = new Map<boolean, Promise<JitiInstance>>()

function getJiti(aliasZod: boolean): Promise<JitiInstance> {
  const existing = jitiPromises.get(aliasZod)
  if (existing) return existing
  const pending = (async () => {
    const { createJiti } = await import('jiti')
    const disk = resolveDiskAliases()
    const alias: Record<string, string> = {}
    const extensionApi = await resolveAliasWithShim(
      '@glows777/vela/extension-api',
      disk.get('@glows777/vela/extension-api'),
      'extension-api.cjs',
      true,
    )
    const velaRoot = await resolveAliasWithShim(
      '@glows777/vela',
      disk.get('@glows777/vela'),
      'vela.cjs',
      true,
    )
    if (extensionApi) alias['@glows777/vela/extension-api'] = extensionApi
    if (velaRoot) alias['@glows777/vela'] = velaRoot
    if (aliasZod) {
      const zod = await resolveAliasWithShim('zod', disk.get('zod'), 'zod.cjs')
      if (zod) alias.zod = zod
    }
    // Reuse one instance per zod-resolution mode with moduleCache enabled for ESM singleton semantics.
    return createJiti(import.meta.url, {
      interopDefault: true,
      moduleCache: true,
      tryNative: false,
      alias,
    })
  })().catch((err) => {
    jitiPromises.delete(aliasZod)
    throw err
  })
  jitiPromises.set(aliasZod, pending)
  return pending
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
      const builtUrl = await buildExtensionWithBun(bun, path)
      const mod = (await import(builtUrl)) as {
        default?: unknown
      }
      factory = mod.default
    }
  } else {
    const jiti = await getJiti(!hasLocalPackage(path, 'zod'))
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
