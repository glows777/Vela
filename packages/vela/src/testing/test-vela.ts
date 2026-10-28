import type { ChannelExtension } from '@glows777/vela-channels'
import {
  type TestVelaOptions as CoreOptions,
  type TestVela as CoreTestVela,
  createTestVela as createCoreTestVela,
  createFauxEmbedder,
} from '@glows777/vela-core/testing'
import type { EmbeddingFn } from '@glows777/vela-rag'
import { rag } from '@glows777/vela-rag'
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

/** Compatibility fixture retains memory, optional RAG and channels. */
export function createTestVela(
  options: TestVelaOptions = {},
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
  const fixture = createCoreTestVela(base, (coreOptions) => {
    vela = createVela({
      ...coreOptions,
      channelIdleMs,
      extensions: [
        ...(coreOptions.extensions ?? []),
        ...(embedder ? [rag({ embedder })] : []),
        ...(extensions ?? []),
      ],
    })
    return vela
  })
  return fixture as Omit<typeof fixture, 'vela'> & { vela: Vela }
}
export type TestVela = ReturnType<typeof createTestVela>
