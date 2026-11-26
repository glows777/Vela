import type { CustomMessage } from '../agent/events.ts'
import { abortable } from '../execution/location.ts'
import type { ModelMessage } from '../messages.ts'
import { userPromptMessage } from './defaults.ts'
import type { SessionDeps } from './deps.ts'
import type { MessageQueue } from './message-queue.ts'
import type { PromptOptions, SendMessageOptions } from './options.ts'

export interface SessionInputHost<Session> {
  id: string
  session: Session
  deps: SessionDeps<Session>
  messageQueue: MessageQueue
  commands: Map<AbortController, Promise<void>>
  isDraining: () => boolean
  drainError: () => Error
  isClosed: () => boolean
  isMoving: () => boolean
  isLocked: () => boolean
  isPrompting: () => boolean
  start: (signal?: AbortSignal) => Promise<void>
  startExtensions: () => Promise<void>
  append: (message: ModelMessage) => void
  runInput: (message: ModelMessage, options: PromptOptions) => Promise<void>
}

export function promptSessionInput<Session>(
  host: SessionInputHost<Session>,
  input: string,
  options: PromptOptions,
  mode: 'command' | 'expand' | 'literal' = 'expand',
): Promise<void> {
  if (host.isDraining()) return Promise.reject(host.drainError())
  if (host.isClosed())
    return Promise.reject(new Error(`Session ${host.id} is closed`))
  if (host.isMoving())
    return Promise.reject(new Error('Session is changing location'))
  const { expandInput, prepareCommands } = host.deps
  const slash = mode !== 'literal' && input.startsWith('/')
  const hooks = prepareCommands || host.deps.extensions.hasHandlers('input')
  if (!slash && !hooks) return promptSessionModel(host, input, options)
  return trackSessionInput(host, options.signal, async (signal) => {
    await abortable(
      prepareCommands ? host.start(signal) : host.startExtensions(),
      signal,
    )
    if (host.isDraining()) throw host.drainError()
    if (host.isClosed()) throw new Error(`Session ${host.id} is closed`)
    signal.throwIfAborted()
    const extensions = host.deps.extensions
    const command = mode === 'command' && slash
    if (command && (await extensions.runCommand(host.session, input, signal))) {
      return
    }
    signal.throwIfAborted()
    let text = input
    let images = options.images
    if (extensions.hasHandlers('input')) {
      const event = await abortable(
        extensions.input(
          host.session,
          text,
          options.source ?? 'sdk',
          host.isPrompting() ? options.streamingBehavior : undefined,
          images,
        ),
        signal,
      )
      if (!event) return
      text = event.text
      images = event.images
    }
    if (host.isDraining()) throw host.drainError()
    if (mode !== 'literal' && text.startsWith('/')) {
      signal.throwIfAborted()
      text = await abortable(expandInput(text, host.session, signal), signal)
    }
    return promptSessionModel(host, text, { ...options, images, signal })
  })
}

async function trackSessionInput<Session>(
  host: SessionInputHost<Session>,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forward, { once: true })
  if (signal?.aborted) forward()
  const task = run(controller.signal)
  host.commands.set(controller, task)
  try {
    return await task
  } finally {
    host.commands.delete(controller)
    signal?.removeEventListener('abort', forward)
  }
}

export async function sendSessionCustomMessage<Session>(
  host: SessionInputHost<Session>,
  message: CustomMessage,
  options: SendMessageOptions = {},
): Promise<void> {
  if (host.isClosed()) throw new Error(`Session ${host.id} is closed`)
  const entry = host.messageQueue.customMessage(message)
  if (options.deliverAs === 'nextTurn') {
    host.messageQueue.nextTurnMessages.push(entry)
    return
  }
  if (host.isPrompting() && options.triggerTurn !== false) {
    host.messageQueue.enqueue(entry)
    return
  }
  if (options.triggerTurn) return promptSessionMessage(host, entry, {})
  if (host.isLocked()) {
    host.messageQueue.pendingCustom.push(entry)
    return
  }
  host.append(entry)
}

function promptSessionModel<Session>(
  host: SessionInputHost<Session>,
  input: string,
  options: PromptOptions,
): Promise<void> {
  return promptSessionMessage(
    host,
    userPromptMessage(input, options.images),
    options,
  )
}

function promptSessionMessage<Session>(
  host: SessionInputHost<Session>,
  message: ModelMessage,
  options: PromptOptions,
): Promise<void> {
  if (host.isDraining()) return Promise.reject(host.drainError())
  if (host.isClosed())
    return Promise.reject(new Error(`Session ${host.id} is closed`))
  // Input hooks can finish after cancellation, while the aborted loop is still cleaning up.
  if (options.signal?.aborted) return Promise.reject(options.signal.reason)
  if (host.isLocked()) {
    // Only the prompt loop drains the queue; nothing can be queued while /defend, a skill or compact holds the lock
    if (!host.isPrompting() || !options.streamingBehavior)
      return Promise.reject(
        new Error(
          'A task is already running: queue with steer() (or streamingBehavior), or wait for it to finish',
        ),
      )
    host.messageQueue.enqueue(message)
    return Promise.resolve()
  }
  return host.runInput(message, options)
}
