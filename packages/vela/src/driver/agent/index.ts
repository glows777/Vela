import { openDatabase } from '../../db/index.ts'
import type { VelaLimits } from '../../shared/limits.ts'
import type {
  ModelInput,
  ReasoningOption,
} from '../../shared/provider-types.ts'
import type { RequestSnapshot } from '../context/request.ts'
import type { ModelMessage } from '../messages.ts'
import { SessionStore } from '../session/index.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { TokenTracker } from '../usage/tracker.ts'
import { VelaDriver } from '../vela-driver.ts'
import type { VelaEventListener } from './events.ts'

interface AgentLoopParameter {
  model: ModelInput
  systemPrompt: string | (() => string)
  toolRegistry: ToolRegistry
  messages: ModelMessage[]
  tokenTracker: TokenTracker
  prepareContext?: (request: RequestSnapshot) => Promise<void>
  transformContext?: (
    messages: ModelMessage[],
    producer: string,
  ) => Promise<ModelMessage[]>
  compactOnOverflow?: (signal?: AbortSignal) => Promise<void>
  abortSignal?: AbortSignal
  isDraining?: () => boolean
  onEvent?: VelaEventListener
  limits?: Partial<VelaLimits>
  supportsImages?: boolean
  maxOutputTokens?: number | (() => number | undefined)
  sessionId?: string
  reasoning?: ReasoningOption | (() => ReasoningOption | undefined)
  takeSteering?: () => ModelMessage[] | Promise<ModelMessage[]>
  newMessages?: ModelMessage[]
}

/** Runs one standalone agent turn loop using an ephemeral in-memory `VelaDriver`. */
export const agentLoop = async ({
  model,
  systemPrompt,
  toolRegistry,
  messages,
  tokenTracker,
  prepareContext,
  transformContext,
  compactOnOverflow,
  abortSignal,
  isDraining,
  onEvent,
  limits,
  reasoning,
  supportsImages = true,
  maxOutputTokens,
  sessionId = 'standalone',
  takeSteering,
  newMessages = [],
}: AgentLoopParameter) => {
  const db = openDatabase({ path: ':memory:' })
  const store = new SessionStore(sessionId, db, { ephemeral: true })
  try {
    store.ensureSessionRow()
    for (const msg of messages) {
      store.appendMessage(msg)
    }
    const driver = new VelaDriver({
      sessionId,
      db,
      store,
      registry: toolRegistry,
      tracker: tokenTracker,
      onEvent,
    })
    await driver.run({
      model,
      systemPrompt,
      messages,
      newMessages,
      supportsImages,
      maxOutputTokens,
      reasoning,
      limits,
      abortSignal,
      isDraining,
      prepareContext,
      transformContext,
      compactOnOverflow,
      takeSteering,
    })
  } finally {
    store.releaseTransient()
    if (db.open) db.close()
  }
}
