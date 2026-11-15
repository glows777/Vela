import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ChannelVela,
  type ChannelVelaOptions,
  createChannelVela,
} from '@glows777/vela-channels'

export type { ChannelVela as Vela, ChannelVelaOptions as VelaOptions }

/** This package's directory, the same from `src/` and `dist/` (the file sits directly in either). */
const packageDir = fileURLToPath(new URL('..', import.meta.url))

/**
 * Vela's own README, docs and examples, next to this package (`bun run build` copies docs and examples into
 * it). The system prompt's `<docs>` section points the model there; a source checkout without a build has no
 * docs folder, so the section stays off.
 */
const docsPaths = {
  readme: join(packageDir, 'README.md'),
  docs: join(packageDir, 'docs'),
  examples: join(packageDir, 'examples'),
}

/**
 * The SDK entry point: core Vela plus channels. The system prompt's docs section points at this package, so
 * "how do I write an extension" starts from the installed documentation.
 */
export function createVela(options: ChannelVelaOptions = {}): ChannelVela {
  return createChannelVela({ ...options, docs: options.docs ?? docsPaths })
}
