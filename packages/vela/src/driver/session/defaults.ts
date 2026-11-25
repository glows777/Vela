import type { ProviderToolSpec } from '../../providers/index.ts'
import { clampThinkingLevel } from '../../providers/models/catalog.ts'
import {
  DEFAULT_THINKING_LEVEL,
  describeModel,
  limitsForModel,
  type ModelInfo,
  type ResolvedModel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '../../providers/models/index.ts'
import type { VelaLimits } from '../../shared/limits.ts'
import type { ModelInput } from '../../shared/provider-types.ts'
import type { CustomMessage, CustomMessageInfo } from '../agent/events.ts'
import { canSummarize } from '../context/compressor.ts'
import type { ContextManager } from '../context/manager.ts'
import {
  type RequestSnapshot,
  resolveRequestSnapshot,
} from '../context/request.ts'
import type { ExecutionLocation } from '../execution/types.ts'
import type { BeforeAgentStartResult } from '../extensions/events.ts'
import type { ImageContent, ModelMessage, TextContent } from '../messages.ts'
import { estimateMessagesTokens } from '../messages.ts'
import type { TokenTracker } from '../usage/tracker.ts'
import type { SessionDeps } from './deps.ts'
import type { SessionContext } from './entries.ts'
import type { SessionStore } from './index.ts'
import { messageText } from './message-queue.ts'
import type { LoadedSessionContext, SessionOptions } from './options.ts'
import type { SessionDefaults } from './resources.ts'

/** Session-local selection provenance and the prepared project's default snapshot. */
export class SessionDefaultState {
  modelChoice: ModelInput | undefined
  resolved?: ResolvedModel
  /** The selected model wrapped with extension provider hooks. */
  hooked?: ModelInput
  thinking: ThinkingLevel
  modelPinned: boolean
  thinkingPinned: boolean
  compactionPinned: boolean
  effectiveLimitOverrides: Partial<VelaLimits>
  private prepared?: SessionDefaults

  constructor(
    deps: Pick<
      SessionDeps<unknown>,
      'model' | 'thinkingLevel' | 'limitOverrides'
    >,
    options: SessionOptions,
  ) {
    this.modelChoice = options.model ?? deps.model
    this.thinking = options.thinkingLevel ?? deps.thinkingLevel
    this.modelPinned = options.model !== undefined
    this.thinkingPinned = options.thinkingLevel !== undefined
    this.compactionPinned = options.autoCompaction !== undefined
    this.effectiveLimitOverrides = { ...deps.limitOverrides }
  }

  /** The requested level clamped to the selected model's support. */
  thinkingLevelFor(info: ModelInfo): ThinkingLevel {
    return clampThinkingLevel(this.thinking, info, THINKING_LEVELS)
  }

  /** Model metadata with live `planLabel` reflecting credential/auth changes. */
  info(
    resolved: ResolvedModel,
    deps: Pick<SessionDeps<unknown>, 'planLabel'>,
    channel?: string,
  ): ModelInfo {
    const info = resolved.info
    if (!deps.planLabel) return info
    const livePlan = deps.planLabel(info.provider, channel)
    if (livePlan === info.planLabel) return info
    if (livePlan) return { ...info, planLabel: livePlan }
    const { planLabel: _, ...rest } = info
    return rest
  }

  async restore(
    context: SessionContext & { model?: string; thinkingLevel?: ThinkingLevel },
    deps: {
      extensions: { ready: Promise<void> }
      logger: SessionDeps<unknown>['logger']
    },
    id: string,
    selectModel: (model: string) => void,
  ): Promise<void> {
    if (
      context.thinkingLevel &&
      THINKING_LEVELS.includes(context.thinkingLevel)
    ) {
      this.thinking = context.thinkingLevel
      this.thinkingPinned = true
    }
    if (context.model && context.model !== this.resolved?.info.ref) {
      // Providers registered by extensions resolve only after extensions load
      await deps.extensions.ready.catch(() => {})
      try {
        selectModel(context.model)
        this.modelPinned = true
      } catch (error) {
        deps.logger.warn(
          `[session] Saved model ${context.model} for ${id} is unavailable, keeping the current model: ${error instanceof Error ? error.message : error}`,
        )
      }
    }
    if (context.model && context.model === this.resolved?.info.ref)
      this.modelPinned = true
  }

  applyOpenChoices(
    options: SessionOptions,
    selectModel: (model: ModelInput) => void,
    sync?: {
      store: SessionStore
      modelRef: () => string
      thinkingLevel: () => ThinkingLevel
    },
  ) {
    // A model or thinking level given at open (a channel's current chat entry) wins over the saved choice
    if (options.thinkingLevel !== undefined)
      this.thinking = options.thinkingLevel
    if (options.model !== undefined && options.model !== this.modelChoice)
      selectModel(options.model)
    if (sync && options.model !== undefined)
      sync.store.setModelChoice(sync.modelRef())
    if (sync && options.thinkingLevel !== undefined)
      sync.store.setThinkingLevelChoice(sync.thinkingLevel())
  }

  apply(
    defaults: SessionDefaults | undefined,
    store: SessionStore,
    limits: VelaLimits,
    context: ContextManager,
  ): void {
    if (!defaults || defaults === this.prepared) return
    // Do not resolve a model while loading resources: project providers may not be ready.
    if (!this.modelPinned && defaults.model !== this.modelChoice) {
      this.modelChoice = defaults.model
      this.resolved = undefined
      this.hooked = undefined
      if (typeof defaults.model === 'string')
        store.setModelChoice(defaults.model)
    }
    const thinking = defaults.thinkingLevel ?? DEFAULT_THINKING_LEVEL
    if (!this.thinkingPinned && thinking !== this.thinking) {
      this.thinking = thinking
      store.setThinkingLevelChoice(this.thinking)
    }
    this.effectiveLimitOverrides = { ...(defaults.limits ?? {}) }
    const effective = limitsForModel(
      this.resolved?.info ?? {},
      this.effectiveLimitOverrides,
    )
    Object.assign(limits, effective)
    Object.assign(context.limits, effective)
    if (!this.compactionPinned)
      context.autoCompaction = defaults.autoCompaction ?? true
    this.prepared = defaults
  }
}

export function buildForkSessionOptions(
  defaults: SessionDefaultState,
  store: Pick<SessionStore, 'modelAt' | 'thinkingAt'>,
  options: SessionOptions,
  location: ExecutionLocation,
  autoCompaction: boolean,
  leafId: string | null,
  unrouted: (opts: SessionOptions) => SessionOptions,
): SessionOptions {
  const branchModel =
    typeof defaults.modelChoice === 'string'
      ? (store.modelAt(leafId) ?? defaults.modelChoice)
      : defaults.modelChoice
  return {
    ...unrouted(options),
    location,
    model: branchModel,
    thinkingLevel: store.thinkingAt(leafId) ?? defaults.thinking,
    autoCompaction,
  }
}

export function resolveRunProducer(
  servingModel: ModelInput,
  modelChoice: ModelInput | undefined,
  provider: string,
  channel: string | undefined,
  authMode?: (
    provider: string,
    channel?: string,
  ) => 'api_key' | 'oauth' | undefined,
): string {
  const base = describeModel(servingModel).ref
  const mode =
    typeof modelChoice === 'string' ? authMode?.(provider, channel) : undefined
  return mode === 'oauth' ? `${base}:oauth` : base
}

function syncTrackerFromContext(
  tracker: TokenTracker,
  context: SessionContext,
  messages: ModelMessage[],
): void {
  const latest = (context as LoadedSessionContext).latestAssistantUsage
  if (latest) {
    tracker.restoreCalibration(
      latest.inputTokens,
      latest.outputTokens,
      latest.trailingMessages,
    )
  } else {
    tracker.setEstimatedTokens(estimateMessagesTokens(messages))
  }
}

export async function summarizeEntriesForTree(
  contextManager: ContextManager,
  model: ModelInput,
  system: string,
  tools: ProviderToolSpec[],
  messages: ModelMessage[],
  maxTokens: number | undefined,
  focus: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  const request: RequestSnapshot = await resolveRequestSnapshot(
    model,
    system,
    tools,
    messages,
    signal,
    maxTokens,
  )
  return contextManager.summarizeBranch(request, 0, focus)
}

export async function runLoopCompaction(
  contextManager: ContextManager,
  request: RequestSnapshot,
  maxInputTokens: number,
  reason: 'manual' | 'overflow',
  focus?: string,
): Promise<void> {
  if (!canSummarize(request.messages, maxInputTokens))
    throw new Error('Nothing to compact (session too small)')
  await contextManager.compact(request, focus, reason)
}

export async function restoreBranchState(params: {
  context: SessionContext
  contextManager: ContextManager
  registry: { discoveredTools: Set<string> }
  store: SessionStore
  customMessages: WeakMap<ModelMessage, CustomMessageInfo>
  defaults: SessionDefaultState
  deps: {
    extensions: { ready: Promise<void> }
    logger: SessionDeps<unknown>['logger']
  }
  id: string
  selectModel: (model: string) => void
  tracker: TokenTracker
  messages: ModelMessage[]
}): Promise<void> {
  params.contextManager.restore(params.context)
  params.registry.discoveredTools = new Set(await params.store.loadedTools())
  for (const [message, info] of params.context.custom)
    params.customMessages.set(message, info)
  await params.defaults.restore(
    params.context,
    params.deps,
    params.id,
    params.selectModel,
  )
  syncTrackerFromContext(params.tracker, params.context, params.messages)
}

export async function prepareAgentTurn(params: {
  inputs: ModelMessage[]
  signal: AbortSignal
  recoverPending: boolean
  normalizeInput: (m: ModelMessage) => Promise<ModelMessage>
  beforeAgentStart: (input: string) => Promise<BeforeAgentStartResult>
  setTurn: (turn: BeforeAgentStartResult) => void
  toCustomMessage: (m: CustomMessage) => ModelMessage
  emitStart: (input: string) => void
  flushBash: () => void
  flushPendingCustom: (append: (m: ModelMessage) => void) => void
  nextTurnMessages: ModelMessage[]
  append: (m: ModelMessage) => void
}): Promise<{ newMessages: ModelMessage[]; flushAndAppend: () => void }> {
  const normalized = await Promise.all(
    params.inputs.map((m) => params.normalizeInput(m)),
  )
  params.signal.throwIfAborted()
  const input = normalized.map(messageText).join('\n\n')
  params.setTurn({ sections: {}, messages: [] })
  const started = await params.beforeAgentStart(input)
  params.setTurn(started)
  const added = started.messages.map((m) => params.toCustomMessage(m))
  params.emitStart(input)
  const newMessages: ModelMessage[] = []
  const flushAndAppend = () => {
    params.flushBash()
    params.flushPendingCustom((m) => params.append(m))
    for (const m of [
      ...normalized,
      ...params.nextTurnMessages.splice(0),
      ...added,
    ]) {
      params.append(m)
      newMessages.push(m)
    }
  }
  if (!params.recoverPending) flushAndAppend()
  return { newMessages, flushAndAppend }
}

export const defaultAbortError = () =>
  new DOMException('User cancelled the current operation', 'AbortError')

export function splitUserMessageContent(
  content: string | (TextContent | ImageContent)[],
): { text: string; images?: ImageContent[] } {
  if (typeof content === 'string') return { text: content }
  return {
    text: content
      .filter((part): part is TextContent => part.type === 'text')
      .map((part) => part.text)
      .join('\n'),
    images: content.filter(
      (part): part is ImageContent => part.type === 'image',
    ),
  }
}
