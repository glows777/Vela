import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createVela as createCoreVela,
  type DocsPaths,
  type Vela,
  type VelaOptions,
} from './driver/index.ts'

export type { Vela, VelaOptions }

/**
 * Vela's own README, docs and examples, next to this package (`bun run build` copies docs and examples into
 * it). The system prompt's `<docs>` section points the model there; a source checkout without a build has no
 * docs folder, so the section stays off.
 *
 * Read on the first `createVela` call, not while this module loads: a bundler that inlines this entry
 * rewrites `new URL('..', import.meta.url)` into an asset reference, and a host that only imports other
 * exports (the desktop app) would then fail before any of its own code runs.
 */
function docsPaths(): DocsPaths {
  const packageDir = fileURLToPath(new URL('..', import.meta.url))
  return {
    readme: join(packageDir, 'README.md'),
    docs: join(packageDir, 'docs'),
    examples: join(packageDir, 'examples'),
  }
}

/**
 * The SDK entry point. The system prompt's docs section points at this package, so
 * "how do I write an extension" starts from the installed documentation.
 */
export function createVela(options: VelaOptions = {}): Vela {
  return createCoreVela({
    ...options,
    docs: options.docs ?? docsPaths(),
  })
}
