import type { ChannelExtension } from '@glows777/vela-channels'
import type { VelaOptions as CoreVelaOptions } from '@glows777/vela-core'
import {
  type TestVelaOptions as CoreOptions,
  type TestVela as CoreTestVela,
  createTestVela as createCoreTestVela,
  createFauxEmbedder,
} from '@glows777/vela-core/testing'
import type { EmbeddingFn } from '@glows777/vela-rag'
import { rag } from '@glows777/vela-rag'
import { resolveShellPath } from '../cli/shell.ts'
import { createVela, type Vela } from '../vela.ts'

export {
  cleanupTestVelas,
  type FixtureSkill,
  tempDir,
} from '@glows777/vela-core/testing'

export interface TestVelaOptions extends Omit<CoreOptions, 'extensions'> {
  extensions?: ChannelExtension[]
  embedder?: boolean | EmbeddingFn
  channelIdleMs?: number
}

type TestVelaAssembler = (options: CoreVelaOptions) => Vela

/** Compatibility fixture retains memory, optional RAG and channels. */
export function createTestVela(
  options: TestVelaOptions = {},
  assemble?: TestVelaAssembler,
): Omit<CoreTestVela, 'vela'> & { vela: Vela } {
  const {
    extensions,
    embedder: requestedEmbedder,
    channelIdleMs,
    ...base
  } = options
  const embedder =
    requestedEmbedder === true
      ? createFauxEmbedder()
      : requestedEmbedder || undefined
  let vela!: Vela
  const create: TestVelaAssembler =
    assemble ??
    ((coreOptions) =>
      createVela({
        ...coreOptions,
        shellPath: coreOptions.shellPath ?? resolveShellPath(),
        channelIdleMs,
        extensions: [
          ...(coreOptions.extensions ?? []),
          ...(embedder ? [rag({ embedder })] : []),
          ...(extensions ?? []),
        ],
      }))
  const fixture = createCoreTestVela(base, (coreOptions) => {
    vela = create(coreOptions)
    return vela
  })
  return fixture as Omit<typeof fixture, 'vela'> & { vela: Vela }
}
export type TestVela = ReturnType<typeof createTestVela>
