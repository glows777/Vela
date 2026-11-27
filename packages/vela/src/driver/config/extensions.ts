import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { VelaExtension } from '../extensions/types.ts'

const nodeRequire = createRequire(import.meta.url)
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
    return nodeRequire.resolve(id)
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
    (diskPath ? () => import(pathToFileURL(diskPath).href) : undefined) ??
    hostLoaders[specifier]
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
      opts: { filter: RegExp; namespace?: string },
      cb: (args: {
        path: string
      }) =>
        | { contents: string; loader: 'js' | 'jsx' | 'ts' | 'tsx' }
        | undefined,
    ): void
  }): void
}

interface BunTranspilerLike {
  scanImports(code: string): Array<{ kind: string; path: string }>
}

interface BunLike {
  Transpiler?: new (options: {
    loader: 'js' | 'jsx' | 'ts' | 'tsx'
  }) => BunTranspilerLike
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

function bunLoaderForPath(filePath: string): 'js' | 'jsx' | 'ts' | 'tsx' {
  if (filePath.endsWith('.tsx')) return 'tsx'
  if (filePath.endsWith('.jsx')) return 'jsx'
  if (/\.(?:mjs|cjs|js)$/.test(filePath)) return 'js'
  return 'ts'
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch)
}

function skipBalancedTemplateExpr(src: string, start: number): number {
  let i = start
  let depth = 1
  while (i < src.length && depth > 0) {
    const ch = src[i]!
    if (ch === "'" || ch === '"') {
      i = skipQuoted(src, i, ch)
    } else if (ch === '`') {
      i = skipTemplate(src, i)
    } else if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i + 2)
      i = nl === -1 ? src.length : nl + 1
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
    } else {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      i += 1
    }
  }
  return i
}

function skipQuoted(src: string, start: number, quote: string): number {
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    i += 1
    if (ch === quote) break
  }
  return i
}

function skipTemplate(src: string, start: number): number {
  let i = start + 1
  while (i < src.length) {
    const ch = src[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '$' && src[i + 1] === '{') {
      i = skipBalancedTemplateExpr(src, i + 2)
      continue
    }
    i += 1
    if (ch === '`') break
  }
  return i
}

/** Rewrites bare `import.meta.{url,dir,path}` tokens in source code for one module path without touching string literals or comments. */
function rewriteImportMetaForFile(source: string, filePath: string): string {
  const metaReplacements: Record<string, string> = {
    url: JSON.stringify(pathToFileURL(filePath).href),
    dir: JSON.stringify(dirname(filePath)),
    path: JSON.stringify(filePath),
  }
  const rewriteSlice = (start: number, end: number): string => {
    let out = ''
    let i = start
    while (i < end) {
      const ch = source[i]!
      if (ch === "'" || ch === '"') {
        const next = skipQuoted(source, i, ch)
        out += source.slice(i, next)
        i = next
        continue
      }
      if (ch === '`') {
        let j = i + 1
        out += '`'
        while (j < end) {
          const tc = source[j]!
          if (tc === '\\') {
            out += source.slice(j, j + 2)
            j += 2
            continue
          }
          if (tc === '$' && source[j + 1] === '{') {
            const exprEnd = skipBalancedTemplateExpr(source, j + 2)
            out += `\${${rewriteSlice(j + 2, exprEnd - 1)}}`
            j = exprEnd
            continue
          }
          out += tc
          j += 1
          if (tc === '`') break
        }
        i = j
        continue
      }
      if (ch === '/' && source[i + 1] === '/') {
        const nl = source.indexOf('\n', i + 2)
        const next = nl === -1 || nl > end ? end : nl + 1
        out += source.slice(i, next)
        i = next
        continue
      }
      if (ch === '/' && source[i + 1] === '*') {
        const close = source.indexOf('*/', i + 2)
        const next = close === -1 || close + 2 > end ? end : close + 2
        out += source.slice(i, next)
        i = next
        continue
      }
      if (
        source.startsWith('import.meta.', i) &&
        (i === 0 || !isIdentChar(source[i - 1]!))
      ) {
        const afterDot = i + 'import.meta.'.length
        let propEnd = afterDot
        while (propEnd < end && isIdentChar(source[propEnd]!)) propEnd += 1
        const prop = source.slice(afterDot, propEnd)
        if (prop in metaReplacements) {
          out += metaReplacements[prop]!
          i = propEnd
          continue
        }
      }
      out += ch
      i += 1
    }
    return out
  }
  return rewriteSlice(0, source.length)
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
        plugins: [
          {
            name: 'vela-extension-host',
            setup(build) {
              build.onResolve({ filter: /^file:\/\// }, (args) => ({
                path: fileURLToPath(args.path),
              }))
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
              build.onLoad(
                { filter: /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/, namespace: 'file' },
                (args) => {
                  const text = readFileSync(args.path, 'utf8')
                  if (!text.includes('import.meta.')) return undefined
                  return {
                    contents: rewriteImportMetaForFile(text, args.path),
                    loader: bunLoaderForPath(args.path),
                  }
                },
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

function needsHostBundlerUnderBun(bun: BunLike, sourcePath: string): boolean {
  let source = ''
  try {
    source = readFileSync(sourcePath, 'utf8')
  } catch {
    return false
  }
  const runtimeImports =
    typeof bun.Transpiler === 'function'
      ? new bun.Transpiler({ loader: bunLoaderForPath(sourcePath) })
          .scanImports(source)
          .map((item) => item.path)
      : [
          ...source.matchAll(
            /['"](@glows777\/vela(?:\/extension-api)?|zod)['"]/g,
          ),
        ].map((m) => m[1]!)
  const importsVela = runtimeImports.some(
    (spec) =>
      spec === '@glows777/vela' || spec === '@glows777/vela/extension-api',
  )
  if (importsVela && !hasLocalPackage(sourcePath, '@glows777/vela')) {
    return true
  }
  const importsBareZod = runtimeImports.includes('zod')
  if (importsBareZod && !hasLocalPackage(sourcePath, 'zod')) {
    return true
  }
  return false
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
    if (needsHostBundlerUnderBun(bun, path)) {
      const builtUrl = await buildExtensionWithBun(bun, path)
      const mod = (await import(builtUrl)) as { default?: unknown }
      factory = mod.default
    } else {
      try {
        const mod = (await import(pathToFileURL(path).href)) as {
          default?: unknown
        }
        factory = mod.default
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (
          !/Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/.test(message)
        )
          throw error
        const builtUrl = await buildExtensionWithBun(bun, path)
        const mod = (await import(builtUrl)) as {
          default?: unknown
        }
        factory = mod.default
      }
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
