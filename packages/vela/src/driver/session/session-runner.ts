import type { ResolvedModel } from '../../providers/models/index.ts'
import { reasoningOption } from '../../providers/models/index.ts'
import type { VelaLimits } from '../../shared/limits.ts'
import type { ModelInput } from '../../shared/provider-types.ts'
import type { VelaEvent } from '../agent/events.ts'
import type { ContextManager } from '../context/manager.ts'
import { resolveRequestSnapshot } from '../context/request.ts'
import type { BeforeAgentStartResult } from '../extensions/events.ts'
import type { ModelMessage } from '../messages.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { VelaDriver } from '../vela-driver.ts'
import {
  linkAbortSignal,
  prepareAgentTurn,
  resolveRunProducer,
  runLoopCompaction,
  runPostTurnCompaction,
  type SessionDefaultState,
} from './defaults.ts'
import type { SessionDeps } from './deps.ts'
import type { SessionStore } from './index.ts'
import type { MessageQueue } from './message-queue.ts'
import type { PromptOptions } from './options.ts'
import { pendingToolCalls } from './recovery.ts'
import type { UserBash } from './user-bash.ts'

export interface SessionRunnerHost<Session> {
  id: string
  session: Session
  deps: SessionDeps<Session>
  store: SessionStore
  registry: ToolRegistry
  driver: VelaDriver
  contextManager: ContextManager
  messageQueue: MessageQueue
  userBash: UserBash
  defaults: SessionDefaultState
  messages: ModelMessage[]
  limits: VelaLimits
  toolDetails: Map<string, unknown>
  busy: { locked: boolean; controller?: AbortController }
  getChannel: () => string | undefined
  getAutoCompaction: () => boolean
  isDraining: () => boolean
  setPrompting: (value: boolean) => void
  setTurn: (turn: BeforeAgentStartResult) => void
  dequeueSteering: () => ModelMessage[]
  resolveModel: () => ResolvedModel
  requestModel: () => ModelInput
  maxTokens: () => number | undefined
  buildSystem: () => string
  prepareContext: (
    request: Awaited<ReturnType<typeof resolveRequestSnapshot>>,
    options?: { maxOutputTokens?: number },
  ) => Promise<void>
  start: (signal?: AbortSignal) => Promise<void>
  save: () => Promise<void>
  append: (message: ModelMessage) => void
  emit: (event: VelaEvent) => void
}

export async function runSessionQueue<Session>(
  host: SessionRunnerHost<Session>,
  input: ModelMessage | undefined,
  options: PromptOptions,
): Promise<void> {
  const busy = host.busy
  busy.locked = true
  host.setPrompting(true)
  const { controller, unlink } = linkAbortSignal(options.signal)
  busy.controller = controller
  let failure: { error: unknown } | undefined
  const flushCustom = () => {
    host.messageQueue.flushPendingCustom((m) => host.append(m))
  }
  try {
    await host.start(controller.signal)
    await host.store.assertNew()
    const hasPending = pendingToolCalls(host.messages).length > 0
    const recoverPending = input === undefined || hasPending
    if (recoverPending) {
      host.registry.discoveredTools = new Set(await host.store.loadedTools())
    }
    let inputs = input === undefined ? [] : [input]
    let firstRun = true
    do {
      let stopForHuman = false
      try {
        const outcome = await runSingleDriverLoop(
          host,
          inputs,
          controller.signal,
          firstRun && recoverPending,
          input === undefined,
        )
        stopForHuman = outcome.reason === 'waiting_human'
        await runPostTurnCompaction({
          enabled: !stopForHuman && host.getAutoCompaction(),
          signal: controller.signal,
          isDraining: host.isDraining,
          buildSnapshot: () =>
            buildSessionSnapshot(host, controller.signal, {
              model: host.requestModel(),
              maxOutputTokens: host.resolveModel().info.maxTokens,
            }),
          compactIfNeeded: (req) => host.contextManager.compactIfNeeded(req),
          warn: (msg) =>
            host.deps.logger.warn(
              `[session:${host.id}] Post-turn compaction failed: ${msg}`,
            ),
        })
      } catch (error) {
        failure ??= { error }
      }
      firstRun = false
      if (stopForHuman || controller.signal.aborted) break
      inputs = host.dequeueSteering()
      if (!inputs.length && !pendingToolCalls(host.messages).length) {
        flushCustom()
        inputs = host.dequeueSteering()
      }
    } while (inputs.length)
  } finally {
    unlink()
    const hasPendingCalls = pendingToolCalls(host.messages).length > 0
    if (!hasPendingCalls) flushCustom()
    host.toolDetails.clear()
    if (!hasPendingCalls) while (host.userBash.flush()) await host.save()
    busy.locked = false
    busy.controller = undefined
    host.setPrompting(false)
    if (!hasPendingCalls) flushCustom()
    host.emit({ type: 'agent_settled' })
  }
  if (failure) throw failure.error
}

async function runSingleDriverLoop<Session>(
  host: SessionRunnerHost<Session>,
  inputs: ModelMessage[],
  signal: AbortSignal,
  recoverPending = false,
  allowWaitingHuman = false,
): Promise<{ reason: 'done' | 'waiting_human' }> {
  await host.start(signal)
  signal.throwIfAborted()
  await host.store.assertNew()
  const { info } = host.resolveModel()
  const serving = {
    model: host.requestModel(),
    maxOutputTokens: info.maxTokens,
  }
  const channel = host.getChannel()
  const trigger = channel ? 'channel' : 'user'
  const claim = host.driver.claim({
    recoverPending,
    allowWaitingHuman,
    trigger,
    model: serving.model,
  })
  let handedOff = false
  try {
    if (host.defaults.modelChoice === undefined) {
      host.defaults.modelChoice = info.ref
      host.store.setModelChoice(info.ref)
    }
    const { newMessages, flushAndAppend } = await prepareAgentTurn({
      inputs,
      signal,
      recoverPending,
      normalizeInput: (m) => host.messageQueue.normalizeInput(m),
      beforeAgentStart: (text) =>
        host.deps.extensions.beforeAgentStart(host.session, text),
      setTurn: host.setTurn,
      toCustomMessage: (m) => host.messageQueue.customMessage(m),
      emitStart: (input) => host.emit({ type: 'agent_start', input }),
      flushBash: () => host.userBash.flush(),
      flushPendingCustom: (cb) => host.messageQueue.flushPendingCustom(cb),
      nextTurnMessages: host.messageQueue.nextTurnMessages,
      append: host.append,
    })
    const { info: servingInfo } = host.resolveModel()
    serving.model = host.requestModel()
    serving.maxOutputTokens = servingInfo.maxTokens
    handedOff = true
    return await host.driver.run({
      claim,
      model: serving.model,
      producer: () =>
        resolveRunProducer(
          serving.model,
          host.defaults.modelChoice,
          servingInfo.provider,
          host.getChannel(),
          host.deps.authMode,
        ),
      trigger,
      maxOutputTokens: serving.maxOutputTokens,
      supportsImages: servingInfo.input?.includes('image') ?? true,
      reasoning: () =>
        reasoningOption(
          host.defaults.thinkingLevelFor(servingInfo),
          servingInfo,
        ),
      systemPrompt: host.buildSystem,
      messages: host.messages,
      newMessages,
      prepareContext: (req) => host.prepareContext(req, serving),
      transformContext: (msgs, p) =>
        host.deps.extensions.transformContext(host.session, msgs, p),
      compactOnOverflow: host.getAutoCompaction()
        ? (sig) =>
            runSessionCompaction(host, 'overflow', undefined, sig, serving)
        : undefined,
      abortSignal: signal,
      isDraining: host.isDraining,
      takeSteering: () =>
        Promise.all(
          host
            .dequeueSteering()
            .map((m) => host.messageQueue.normalizeInput(m)),
        ),
      hasSteering: () => !host.isDraining() && host.messageQueue.hasSteering,
      limits: host.limits,
      recoverPending,
      allowWaitingHuman,
      onRecoveryComplete: recoverPending ? flushAndAppend : undefined,
      appendInput: host.append,
    })
  } catch (error) {
    if (!handedOff)
      claim.release(claim.resumedFromWaitingHuman ? 'waiting_human' : 'stopped')
    throw error
  }
}

function buildSessionSnapshot<Session>(
  host: SessionRunnerHost<Session>,
  signal?: AbortSignal,
  opts?: { model?: ModelInput; maxOutputTokens?: number },
) {
  return resolveRequestSnapshot(
    opts?.model ?? host.requestModel(),
    host.buildSystem(),
    host.registry.toProviderTools(),
    host.messages,
    signal,
    opts?.maxOutputTokens ?? host.maxTokens(),
  )
}

export async function runSessionCompaction<Session>(
  host: SessionRunnerHost<Session>,
  reason: 'manual' | 'overflow',
  focus?: string,
  signal?: AbortSignal,
  serving?: { model?: ModelInput; maxOutputTokens?: number },
): Promise<void> {
  const request = await buildSessionSnapshot(host, signal, serving)
  await runLoopCompaction(
    host.contextManager,
    request,
    host.limits.maxInputTokens,
    reason,
    focus,
  )
}
