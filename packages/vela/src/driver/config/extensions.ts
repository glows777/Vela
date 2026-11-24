import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { VelaExtension } from '../extensions/types.ts'

const require = createRequire(import.meta.url)

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

type JitiInstance = ReturnType<typeof import('jiti').createJiti>

let jitiPromise: Promise<JitiInstance> | undefined

function getJiti(): Promise<JitiInstance> {
  if (jitiPromise) return jitiPromise
  jitiPromise = (async () => {
    const { createJiti } = await import('jiti')
    const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
    const alias: Record<string, string> = {}
    const extensionApi = resolveSibling(`../../extension-api${ext}`)
    const velaRoot = resolveSibling(`../../index${ext}`)
    const zod = resolveOptional('zod')
    if (extensionApi) alias['@glows777/vela/extension-api'] = extensionApi
    if (velaRoot) alias['@glows777/vela'] = velaRoot
    if (zod) alias.zod = zod
    // Reuse one instance with moduleCache enabled to match native ESM singleton semantics.
    return createJiti(import.meta.url, {
      interopDefault: true,
      moduleCache: true,
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
 * Uses jiti so external `.ts` extensions outside the workspace can resolve host `@glows777/vela`
 * and `zod` dependencies under both Node.js and Bun.
 */
export async function importExtension(
  path: string,
  name: string,
): Promise<VelaExtension> {
  const jiti = await getJiti()
  const factory = await jiti.import(path, { default: true })
  if (typeof factory !== 'function')
    throw new Error(`Extension ${path} has no default export (vela) => {}`)
  // Computed property name names the function; the runner uses extension.name as the extension name
  return {
    [name]: (vela: Parameters<VelaExtension>[0]) =>
      (factory as VelaExtension)(vela),
  }[name] as VelaExtension
}
