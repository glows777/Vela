import type { ChannelExtension } from '../channels/vela.ts'
import type { EmbeddingFn } from '../extensions/rag/embedder.ts'
import { rag } from '../extensions/rag/index.ts'
import { createVela, type Vela } from '../vela.ts'
import {
  type TestVelaOptions as CoreOptions,
  createTestVela as createCoreTestVela,
} from './core-vela.ts'
import { createFauxEmbedder } from './faux-embedder.ts'

export { cleanupTestVelas, type FixtureSkill, tempDir } from './core-vela.ts'

export interface TestVelaOptions extends Omit<CoreOptions, 'extensions'> {
  extensions?: ChannelExtension[]
  embedder?: boolean | EmbeddingFn
  channelIdleMs?: number
}

/** Compatibility fixture retains memory, optional RAG and channels. */
export function createTestVela(options: TestVelaOptions = {}) {
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
