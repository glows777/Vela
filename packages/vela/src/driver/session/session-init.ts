import { withProviderHooks } from '../../providers/index.ts'
import {
  limitsForModel,
  type ResolvedModel,
} from '../../providers/models/index.ts'
import type { VelaLimits } from '../../shared/limits.ts'
import type { ModelInput } from '../../shared/provider-types.ts'
import type { VelaEvent, VelaEventListener } from '../agent/events.ts'
import { ContextManager } from '../context/manager.ts'
import type { ExecutionEnv, ExecutionLocation } from '../execution/types.ts'
import type { BeforeAgentStartResult } from '../extensions/events.ts'
import type { ModelMessage } from '../messages.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import { getToolListError, isToolModifier } from '../tools/tool-selection.ts'
import { CONTEXT_WINDOW, TokenTracker } from '../usage/tracker.ts'
import { VelaDriver } from '../vela-driver.ts'
import { extractToolMessageDetails } from './db-store.ts'
import { SessionDefaultState } from './defaults.ts'
import type { SessionDeps } from './deps.ts'
import type { SessionContext } from './entries.ts'
import { SessionStore } from './index.ts'
import { MessageQueue } from './message-queue.ts'
import type { PromptOptions, SessionOptions } from './options.ts'
import { pendingToolCalls } from './recovery.ts'
import { busyLocationError } from './relocation.ts'
import * as routing from './routing.ts'
import type { SessionBranchHost } from './session-branch.ts'
import type { SessionInputHost } from './session-input.ts'
import type { SessionLocationHost } from './session-location.ts'
import type { SessionRunnerHost } from './session-runner.ts'
import { UserBash } from './user-bash.ts'
import { SessionWork } from './work.ts'

export function createSessionComponents<
  Session extends {
    id: string
    channel?: string
    registry: ToolRegistry
    store: SessionStore
  },
>(params: {
  id: string
  cwd: string
  location: Readonly<ExecutionLocation>
  deps: SessionDeps<Session>
  options: SessionOptions
  messages: ModelMessage[]
  busy: { locked: boolean; controller?: AbortController }
  emit: (event: VelaEvent) => void
  save: () => Promise<void>
  prepare: (signal?: AbortSignal) => Promise<ExecutionEnv>
  start: (signal?: AbortSignal) => Promise<void>
  isClosed: () => boolean
  isDraining: () => boolean
  isMoving: () => boolean
}) {
  const { id, cwd, location, deps, options, messages, busy, emit } = params
  const backgroundWork = new SessionWork(options.unattended === true)
  const defaults = new SessionDefaultState(deps, options)
  const limits = limitsForModel({}, deps.limitOverrides)
  const store = new SessionStore(id, deps.db, {
    blobsDir: deps.blobsDir,
    logger: deps.logger,
    ephemeral: deps.ephemeral,
    cwd,
    location,
    createdAt: deps.createdAt,
    onSaved: () => deps.onSaved(id),
  })
  const registry = deps.registry.fork(
    store.transientSpillDir ?? deps.spillRoot(id),
    {
      onEvent: emit,
      sessionId: id,
    },
  )
  registry.isDraining = () => params.isDraining() || params.isMoving()
  const toolListError = options.tools
    ? getToolListError(options.tools)
    : undefined
  if (toolListError) throw new Error(`Invalid tools option: ${toolListError}`)
  if (options.tools?.some(isToolModifier))
    registry.setDefaultToolModifiers(options.tools)
  else registry.setSelection(options.tools)
  const tracker = new TokenTracker((record) => store.recordUsageRecord(record))
  const driver = new VelaDriver({
    sessionId: id,
    db: deps.db,
    store,
    registry,
    tracker,
    onEvent: emit,
  })
  const contextManager = new ContextManager(
    store,
    tracker,
    { messages, timestamps: new Map(), summary: '' },
    emit,
    limits,
  )
  const userBash = new UserBash({
    store,
    emit,
    busy,
    save: params.save,
    messages,
    tracker,
    timestamps: contextManager.state.timestamps,
    prepare: params.prepare,
    start: params.start,
    background: () => registry.background,
    isClosed: params.isClosed,
    isDraining: params.isDraining,
  })
  contextManager.autoCompaction = options.autoCompaction ?? deps.autoCompaction
  if (typeof defaults.modelChoice === 'string') {
    store.setModelChoice(defaults.modelChoice)
  }
  store.setThinkingLevelChoice(defaults.thinking)
  const messageQueue = new MessageQueue(emit)
  return {
    backgroundWork,
    defaults,
    limits,
    store,
    registry,
    tracker,
    driver,
    contextManager,
    userBash,
    messageQueue,
  }
}

export function bindInitialRouting<
  Session extends Parameters<typeof routing.applySessionRouting>[0],
>(session: Session, options: SessionOptions): void {
  routing.applySessionRouting(session, options)
}

export function applySessionResolvedModel(params: {
  resolved: ResolvedModel
  defaults: SessionDefaultState
  limits: VelaLimits
  contextManager: ContextManager
  tracker: TokenTracker
}): void {
  const { resolved, defaults, limits, contextManager, tracker } = params
  const previousRef = defaults.lastResolvedRef
  defaults.resolved = resolved
  defaults.lastResolvedRef = resolved.info.ref
  defaults.hooked = undefined
  const nextLimits = limitsForModel(
    resolved.info,
    defaults.effectiveLimitOverrides,
  )
  Object.assign(limits, nextLimits)
  Object.assign(contextManager.limits, nextLimits)
  const window = resolved.info.contextWindow ?? CONTEXT_WINDOW
  tracker.setModel(window, resolved.info.cost, {
    keepCalibration:
      previousRef === undefined || previousRef === resolved.info.ref,
  })
}

export function getHookedSessionModel<Session>(
  session: Session,
  deps: SessionDeps<Session>,
  defaults: SessionDefaultState,
  baseModel: ModelInput,
): ModelInput {
  defaults.hooked ??= withProviderHooks(baseModel, {
    has: (event, toolName, opts) =>
      deps.extensions.hasHandlers(event, toolName, opts),
    beforeRequest: (params) =>
      deps.extensions.beforeProviderRequest(session, params),
    afterResponse: (headers) =>
      deps.extensions.afterProviderResponse(session, headers),
    streamEvent: (event) =>
      deps.extensions.providerStreamEvent(session, {
        type: 'provider_stream_event',
        ...event,
      }),
  })
  return defaults.hooked
}

export function dispatchSessionEvent<Session>(params: {
  raw: VelaEvent
  id: string
  messageQueue: MessageQueue
  toolDetails: Map<string, unknown>
  listeners: Set<VelaEventListener>
  deps: SessionDeps<Session>
  messages: ModelMessage[]
  append: (message: ModelMessage) => void
}): void {
  let event = params.raw
  if (
    (event.type === 'message_start' || event.type === 'message_end') &&
    !event.custom
  ) {
    const custom = params.messageQueue.customMessages.get(event.message)
    if (custom) event = { ...event, custom }
  }
  if (event.type === 'tool_execution_end' && event.details !== undefined) {
    params.toolDetails.set(event.toolCallId, event.details)
  }
  for (const listener of params.listeners) listener(event)
  params.deps.forward(event, params.id)
  if (event.type === 'turn_end' && !pendingToolCalls(params.messages).length) {
    params.messageQueue.flushPendingCustom(params.append)
  }
}

export function recordSessionMessage(params: {
  message: ModelMessage
  producedBy?: string
  messageQueue: MessageQueue
  store: SessionStore
  toolDetails: Map<string, unknown>
  timestamps: Map<ModelMessage, number>
}): void {
  const { message, producedBy, messageQueue, store, toolDetails, timestamps } =
    params
  const custom = messageQueue.customMessages.get(message)
  if (custom && message.role === 'user') {
    store.appendCustomMessage(message, custom)
    timestamps.set(message, Date.now())
    return
  }
  const details = extractToolMessageDetails(message, toolDetails)
  store.appendMessage(message, { details, producedBy })
  for (const key of Object.keys(details)) toolDetails.delete(key)
  timestamps.set(message, Date.now())
}

export interface SessionAdapterAccess<Session> {
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
  options: SessionOptions
  messages: ModelMessage[]
  limits: VelaLimits
  toolDetails: Map<string, unknown>
  busy: { locked: boolean; controller?: AbortController }
  commands: Map<AbortController, Promise<void>>
  getStarted: () => Promise<void> | undefined
  resetForSwitch: (target: Readonly<ExecutionLocation>) => void
  setDisplayName: (name: string | undefined) => void
  getLocation: () => Readonly<ExecutionLocation>
  getName: () => string | undefined
  getChannel: () => string | undefined
  getParentSession: () => string | undefined
  getAutoCompaction: () => boolean
  getModel: () => ModelInput
  getMaxTokens: () => number | undefined
  getThinkingLevel: () => SessionDeps<Session>['thinkingLevel']
  isDraining: () => boolean
  drainError: () => Error
  isClosed: () => boolean
  isMoving: () => boolean
  isPrompting: () => boolean
  setPrompting: (value: boolean) => void
  setTurn: (turn: BeforeAgentStartResult) => void
  exclusive: <T>(
    what: string,
    task: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>
  start: (signal?: AbortSignal) => Promise<void>
  startExtensions: () => Promise<void>
  prepare: (signal?: AbortSignal) => Promise<unknown>
  loadBranch: (ctx: SessionContext) => Promise<void>
  selectModel: (model: ModelInput) => void
  resolveModel: () => ResolvedModel
  requestModel: () => ModelInput
  buildSystem: () => string
  prepareContext: (
    request: Parameters<SessionRunnerHost<Session>['prepareContext']>[0],
    options?: { maxOutputTokens?: number },
  ) => Promise<void>
  save: () => Promise<void>
  append: (message: ModelMessage) => void
  emit: (event: VelaEvent) => void
  dequeueSteering: () => ModelMessage[]
  trackRun: (run: Promise<void>) => Promise<void>
  execEnv: (signal?: AbortSignal) => Promise<ExecutionEnv>
}

export function buildSessionHosts<Session>(
  access: SessionAdapterAccess<Session>,
): {
  location: () => SessionLocationHost<Session>
  branch: () => SessionBranchHost<Session>
  input: () => SessionInputHost<Session>
  runner: () => SessionRunnerHost<Session>
} {
  const runner = (): SessionRunnerHost<Session> => ({
    id: access.id,
    session: access.session,
    deps: access.deps,
    store: access.store,
    registry: access.registry,
    driver: access.driver,
    contextManager: access.contextManager,
    messageQueue: access.messageQueue,
    userBash: access.userBash,
    defaults: access.defaults,
    messages: access.messages,
    limits: access.limits,
    toolDetails: access.toolDetails,
    busy: access.busy,
    getChannel: access.getChannel,
    getAutoCompaction: access.getAutoCompaction,
    isDraining: access.isDraining,
    setPrompting: access.setPrompting,
    setTurn: access.setTurn,
    dequeueSteering: access.dequeueSteering,
    resolveModel: access.resolveModel,
    requestModel: access.requestModel,
    maxTokens: access.getMaxTokens,
    buildSystem: access.buildSystem,
    prepareContext: access.prepareContext,
    start: access.start,
    save: access.save,
    append: access.append,
    emit: access.emit,
  })
  return {
    location: (): SessionLocationHost<Session> => ({
      session: access.session,
      deps: access.deps,
      store: access.store,
      options: access.options,
      defaults: access.defaults,
      getStarted: access.getStarted,
      resetForSwitch: access.resetForSwitch,
      setDisplayName: access.setDisplayName,
      loadBranch: access.loadBranch,
      selectModel: access.selectModel,
      modelRef: () => access.resolveModel().info.ref,
      thinkingLevel: access.getThinkingLevel,
      prepare: access.prepare,
    }),
    branch: (): SessionBranchHost<Session> => ({
      id: access.id,
      session: access.session,
      deps: access.deps,
      store: access.store,
      registry: access.registry,
      contextManager: access.contextManager,
      defaults: access.defaults,
      options: access.options,
      get location() {
        return access.getLocation()
      },
      get name() {
        return access.getName()
      },
      get channel() {
        return access.getChannel()
      },
      get parentSession() {
        return access.getParentSession()
      },
      get autoCompaction() {
        return access.getAutoCompaction()
      },
      getModel: access.getModel,
      getMaxTokens: access.getMaxTokens,
      exclusive: access.exclusive,
      start: access.start,
      buildSystem: access.buildSystem,
      loadBranch: access.loadBranch,
      save: access.save,
      execEnv: access.execEnv,
    }),
    input: (): SessionInputHost<Session> => ({
      id: access.id,
      session: access.session,
      deps: access.deps,
      messageQueue: access.messageQueue,
      commands: access.commands,
      isDraining: access.isDraining,
      drainError: access.drainError,
      isClosed: access.isClosed,
      isMoving: access.isMoving,
      isLocked: () => access.busy.locked,
      isPrompting: access.isPrompting,
      start: access.start,
      startExtensions: access.startExtensions,
      append: access.append,
      runInput: (m: ModelMessage, opts: PromptOptions) =>
        access.trackRun(runSessionQueueCompat(runner(), m, opts)),
    }),
    runner,
  }
}

let runQueueFn:
  | ((
      host: SessionRunnerHost<never>,
      input: ModelMessage | undefined,
      options: PromptOptions,
    ) => Promise<void>)
  | undefined

/** @internal Avoids a circular import between session-init and session-runner. */
export function registerSessionQueueRunner(
  fn: (
    host: SessionRunnerHost<never>,
    input: ModelMessage | undefined,
    options: PromptOptions,
  ) => Promise<void>,
): void {
  runQueueFn = fn
}

function runSessionQueueCompat<Session>(
  host: SessionRunnerHost<Session>,
  input: ModelMessage | undefined,
  options: PromptOptions,
): Promise<void> {
  if (!runQueueFn) throw new Error('Session queue runner not registered')
  return runQueueFn(host as unknown as SessionRunnerHost<never>, input, options)
}

export async function runExclusiveSessionTask<T>(params: {
  id: string
  what: string
  isDraining: () => boolean
  drainError: () => Error
  isClosed: () => boolean
  busy: { locked: boolean; controller?: AbortController }
  setRunning: (run: Promise<void> | undefined, match?: Promise<void>) => void
  flushPendingCustom: () => void
  flushBash: () => boolean
  save: () => Promise<void>
  task: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  if (params.isDraining()) throw params.drainError()
  if (params.isClosed()) throw new Error(`Session ${params.id} is closed`)
  if (params.busy.locked) {
    throw new Error(
      `A task is already running; ${params.what} after it finishes`,
    )
  }
  const busy = params.busy
  busy.locked = true
  const controller = new AbortController()
  busy.controller = controller
  const run = params.task(controller.signal)
  const running = run.then(
    () => {},
    () => {},
  )
  params.setRunning(running)
  try {
    return await run
  } finally {
    params.setRunning(undefined, running)
    params.flushPendingCustom()
    while (params.flushBash()) await params.save()
    busy.locked = false
    busy.controller = undefined
  }
}

export function runLocationGate<T>(params: {
  locked: boolean
  isBashRunning: boolean
  hasWork: boolean
  hasCommands: boolean
  hasActiveCalls: boolean
  setMoving: (value: boolean) => void
  exclusive: <R>(
    what: string,
    task: (signal: AbortSignal) => Promise<R>,
  ) => Promise<R>
  task: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  if (
    params.locked ||
    params.isBashRunning ||
    params.hasWork ||
    params.hasCommands ||
    params.hasActiveCalls
  ) {
    return Promise.reject(busyLocationError())
  }
  return params.exclusive('change or restore location', async (signal) => {
    params.setMoving(true)
    try {
      return await params.task(signal)
    } finally {
      params.setMoving(false)
    }
  })
}
