import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ChannelHost,
  type ChannelVela,
  type ChannelVelaOptions,
  createChannelVela,
  type LocalHost,
} from '@glows777/vela-channels'

import type { LarkHost } from '@glows777/vela-lark'

export type { ChannelVelaOptions as VelaOptions }

export interface Vela extends ChannelVela {
  channel(name: 'local'): LocalHost
  channel(name: 'lark'): LarkHost
  channel(name: string): ChannelHost
}

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
export function createVela(options: ChannelVelaOptions = {}): Vela {
  return createChannelVela({
    ...options,
    docs: options.docs ?? docsPaths,
  }) as Vela
}
