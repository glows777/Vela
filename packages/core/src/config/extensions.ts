import { pathToFileURL } from 'node:url'
import type { VelaExtension } from '../extensions/types.ts'

/**
 * Loads an extension file whose default export is `(vela) => {}`. The returned
 * function is named after the extension, which sets its tool prefix and config section.
 * Bun loads `.ts` directly, so extensions need no build step (pi uses jiti for this).
 */
export async function importExtension(
  path: string,
  name: string,
): Promise<VelaExtension> {
  const module = (await import(pathToFileURL(path).href)) as {
    default?: unknown
  }
  const factory = module.default
  if (typeof factory !== 'function')
    throw new Error(`Extension ${path} has no default export (vela) => {}`)
  // Computed property name names the function; the runner uses extension.name as the extension name
  return {
    [name]: (vela: Parameters<VelaExtension>[0]) =>
      (factory as VelaExtension)(vela),
  }[name] as VelaExtension
}
