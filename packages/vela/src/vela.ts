import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ChannelVela,
  type ChannelVelaOptions,
  createChannelVela,
} from '@glows777/vela-channels'
import type { DocsPaths } from '@glows777/vela-core'

export type { ChannelVela as Vela, ChannelVelaOptions as VelaOptions }

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
 * The SDK entry point: core Vela plus channels. The system prompt's docs section points at this package, so
 * "how do I write an extension" starts from the installed documentation.
 */
export function createVela(options: ChannelVelaOptions = {}): ChannelVela {
  return createChannelVela({ ...options, docs: options.docs ?? docsPaths() })
}
