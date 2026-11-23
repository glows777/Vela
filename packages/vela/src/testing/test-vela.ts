import type { VelaOptions as CoreVelaOptions } from '../driver/index.ts'
import type { ChannelExtension } from '../legacy-channels/index.ts'
import { resolveShellPath } from '../shared/shell-path.ts'
import { createVela, type Vela } from '../vela.ts'
import {
  type TestVelaOptions as CoreOptions,
  type TestVela as CoreTestVela,
  createTestVela as createCoreTestVela,
} from './core/index.ts'

export {
  cleanupTestVelas,
  type FixtureSkill,
  tempDir,
} from './core/index.ts'

export interface TestVelaOptions extends Omit<CoreOptions, 'extensions'> {
  extensions?: ChannelExtension[]
  channelIdleMs?: number
}

type TestVelaAssembler = (options: CoreVelaOptions) => Vela

/** Compatibility fixture retains memory and channels. */
export function createTestVela(
  options: TestVelaOptions = {},
  assemble?: TestVelaAssembler,
): Omit<CoreTestVela, 'vela'> & { vela: Vela } {
  const { extensions, channelIdleMs, ...base } = options
  let vela!: Vela
  const create: TestVelaAssembler =
    assemble ??
    ((coreOptions) =>
      createVela({
        ...coreOptions,
        shellPath:
          coreOptions.shellPath ??
          resolveShellPath(undefined, {
            platform: process.platform,
            env: process.env,
          }),
        channelIdleMs,
        extensions: [...(coreOptions.extensions ?? []), ...(extensions ?? [])],
      }))
  const fixture = createCoreTestVela(base, (coreOptions) => {
    vela = create(coreOptions)
    return vela
  })
  return fixture as Omit<typeof fixture, 'vela'> & { vela: Vela }
}
export type TestVela = ReturnType<typeof createTestVela>
