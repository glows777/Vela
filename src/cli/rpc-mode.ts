import type { SessionUI } from '../extensions/types.ts'
import { THINKING_LEVELS, type ThinkingLevel } from '../models/index.ts'
import type { Vela } from '../vela.ts'
import type { QueueMode, VelaSession } from '../vela-session.ts'
import { jsonEvent, toJsonLine } from './json-event.ts'

/**
 * RPC mode (like pi's `--mode rpc`): one JSON command per stdin line, one `response` or event per stdout line.
 * Command names, `id` / `response` / `disposition` and the extension UI sub-protocol follow pi (see docs/rpc.md).
 * Events are VelaEvents (plus `sessionId`), only for the active session. Disposes and exits when stdin closes.
 */

type RpcCommand = { id?: string; type: string; [key: string]: unknown }

type UiResponse = {
  type: 'extension_ui_response'
  id: string
  value?: string
  confirmed?: boolean
  cancelled?: boolean
}

export interface RpcModeOptions {
  vela: Vela
  /** Session opened at startup */
  sessionId: string
  /** Restore this session's history at startup (`-c` / `--session`) */
  resume: boolean
  /** Id for a new session (`new_session`) */
  newSessionId: () => string
  /** Called after the startup session opens (and resumes): command-line --model / --thinking override saved settings */
  configure?: (session: VelaSession) => void
  input: AsyncIterable<Uint8Array>
  write: (text: string) => Promise<void>
  /** Message for a failed command's `error` (the CLI swaps the SDK's no-model hint for its own); defaults to the error's message */
  describeError?: (error: unknown) => string
}

const QUEUE_MODES: QueueMode[] = ['one-at-a-time', 'all']

export async function runRpcMode(options: RpcModeOptions): Promise<void> {
  const { vela } = options
  const describe =
    options.describeError ??
    ((error: unknown) =>
      error instanceof Error ? error.message : String(error))
  let output = Promise.resolve()
  const send = (record: unknown) => {
    const line = toJsonLine(record)
    output = output.then(() => options.write(line))
    return output
  }

  // Extension UI: requests that need an answer send extension_ui_request and wait for extension_ui_response; the rest are just sent
  const pending = new Map<string, (response: UiResponse) => void>()
  const request = (method: string, fields: Record<string, unknown>) =>
    new Promise<UiResponse>((resolve) => {
      const id = crypto.randomUUID()
      pending.set(id, resolve)
      void send({ type: 'extension_ui_request', id, method, ...fields })
    })
  const notifyClient = (method: string, fields: Record<string, unknown>) =>
    void send({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method,
      ...fields,
    })
  const ui: SessionUI = {
    notify: (message, level = 'info') =>
      notifyClient('notify', { message, notifyType: level }),
    async confirm(title, message) {
      const response = await request('confirm', { title, message })
      return !response.cancelled && response.confirmed === true
    },
    async select(title, choices) {
      const response = await request('select', { title, options: choices })
      return response.cancelled ? undefined : response.value
    },
    async input(title, placeholder) {
      const response = await request('input', { title, placeholder })
      return response.cancelled ? undefined : response.value
    },
    setStatus: (key, text) =>
      notifyClient('setStatus', { statusKey: key, statusText: text }),
    setWidget: (key, lines) =>
      notifyClient('setWidget', { widgetKey: key, widgetLines: lines }),
  }

  let session = vela.session(options.sessionId, { ui })
  if (options.resume) await session.resume()
  options.configure?.(session)

  // Failures inside the agent loop are already reported in agent_end; when the prompt Promise rejects, this decides whether to report again
  let reportedError: unknown
  vela.subscribe((event, sessionId) => {
    if (sessionId !== session.id) return
    if (event.type === 'agent_end' && event.error !== undefined)
      reportedError = event.error
    const line = jsonEvent(event, sessionId)
    output = output.then(() => options.write(line))
  })

  const idle = () => {
    if (session.isRunning)
      throw new Error('A task is running; abort it or wait for it to finish')
  }
  const switchTo = async (next: VelaSession) => {
    const previous = session
    session = next
    if (previous !== next) await previous.close()
  }
  const commandName = (message: string) => message.slice(1).split(/\s/, 1)[0]
  const isExtensionCommand = (message: string) =>
    message.startsWith('/') &&
    vela.commands().some((c) => c.name === commandName(message))
  /**
   * A prompt already answered with started: failures before the loop starts (no model, model doesn't support the
   * thinking level, extension hook error) produce no agent_end, so like pi we send another success:false response
   * for this command to tell the client what went wrong.
   */
  const start = (run: Promise<void>, command: RpcCommand) =>
    void run.catch((error) => {
      if (error === reportedError) return
      void send({
        ...(command.id === undefined ? {} : { id: command.id }),
        type: 'response',
        command: command.type,
        success: false,
        error: describe(error),
      })
    })

  const handlers: Record<
    string,
    (command: RpcCommand) => Promise<unknown> | unknown
  > = {
    async prompt(command) {
      const message = String(command.message ?? '')
      const behavior = command.streamingBehavior as
        | 'steer'
        | 'followUp'
        | undefined
      if (
        behavior !== undefined &&
        behavior !== 'steer' &&
        behavior !== 'followUp'
      )
        throw new Error('streamingBehavior must be steer or followUp')
      if (isExtensionCommand(message)) {
        await session.prompt(message)
        return { disposition: 'handled' }
      }
      if (session.isRunning) {
        await session.prompt(message, { streamingBehavior: behavior })
        return { disposition: 'queued' }
      }
      start(session.prompt(message), command)
      return { disposition: 'started' }
    },
    steer: (command) => enqueue(command, 'steer'),
    follow_up: (command) => enqueue(command, 'followUp'),
    async abort() {
      await session.abort()
    },
    clear_queue: () => session.clearQueue(),
    async new_session() {
      idle()
      const next = vela.session(options.newSessionId(), { ui })
      await switchTo(next)
      return { sessionId: next.id }
    },
    async switch_session(command) {
      idle()
      const id = String(command.sessionId ?? '')
      if (!(await vela.listSessions()).some((s) => s.id === id))
        throw new Error(`No session ${id}`)
      const next = vela.session(id, { ui })
      if (next !== session) await next.resume()
      await switchTo(next)
      return { sessionId: next.id }
    },
    list_sessions: async () => ({ sessions: await vela.listSessions() }),
    get_state() {
      let model: string | undefined
      try {
        model = session.modelInfo.ref
      } catch {}
      const queue = session.queue
      return {
        sessionId: session.id,
        sessionName: session.name,
        model,
        thinkingLevel: session.thinkingLevel,
        isStreaming: session.isRunning,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
        messageCount: session.messages.length,
        pendingMessageCount: queue.steering.length + queue.followUp.length,
      }
    },
    get_messages: () => ({ messages: session.messages }),
    set_model(command) {
      const model =
        typeof command.model === 'string'
          ? command.model
          : `${command.provider}/${command.modelId}`
      session.setModel(model)
      return session.modelInfo
    },
    get_available_models: () => ({ models: vela.models() }),
    set_thinking_level(command) {
      session.setThinkingLevel(command.level as ThinkingLevel)
    },
    get_available_thinking_levels: () => ({ levels: THINKING_LEVELS }),
    set_steering_mode(command) {
      session.steeringMode = queueMode(command.mode)
    },
    set_follow_up_mode(command) {
      session.followUpMode = queueMode(command.mode)
    },
    async compact(command) {
      let result: unknown
      const off = session.subscribe((event) => {
        if (event.type === 'context' && event.action === 'compact')
          result = event
      })
      try {
        await session.compact(
          typeof command.customInstructions === 'string'
            ? command.customInstructions
            : undefined,
        )
      } finally {
        off()
      }
      return result
    },
    async set_session_name(command) {
      session.setName(
        typeof command.name === 'string' ? command.name : undefined,
      )
      // Can't save separately mid-run (it would interleave with the loop's writes and drop new messages); the run saves when it ends
      if (!session.isRunning) await session.save()
    },
    get_commands: () => ({ commands: vela.commands() }),
  }

  async function enqueue(command: RpcCommand, behavior: 'steer' | 'followUp') {
    const message = String(command.message ?? '')
    if (message.startsWith('/') && isExtensionCommand(message))
      throw new Error('Run extension commands with prompt')
    if (!session.isRunning) {
      start(session.prompt(message), command)
      return { disposition: 'started' }
    }
    await (behavior === 'steer'
      ? session.steer(message)
      : session.followUp(message))
    return { disposition: 'queued' }
  }

  const handle = async (line: string) => {
    let command: RpcCommand
    try {
      command = JSON.parse(line)
      if (
        !command ||
        typeof command !== 'object' ||
        typeof command.type !== 'string'
      )
        throw new Error('Missing type')
    } catch (error) {
      await send({
        type: 'response',
        command: 'parse',
        success: false,
        error: `Failed to parse command: ${error instanceof Error ? error.message : error}`,
      })
      return
    }
    if (command.type === 'extension_ui_response') {
      const resolve = pending.get(String(command.id))
      pending.delete(String(command.id))
      resolve?.(command as unknown as UiResponse)
      return
    }
    const id = command.id === undefined ? {} : { id: command.id }
    const handler = handlers[command.type]
    try {
      if (!handler) throw new Error(`Unknown command: ${command.type}`)
      const data = await handler(command)
      await send({
        ...id,
        type: 'response',
        command: command.type,
        success: true,
        ...(data === undefined ? {} : { data }),
      })
    } catch (error) {
      await send({
        ...id,
        type: 'response',
        command: command.type,
        success: false,
        error: describe(error),
      })
    }
  }

  // Split frames on \n only (not readline: it also breaks on U+2028 / U+2029, as pi warns); tolerates \r\n
  const decoder = new TextDecoder()
  let buffer = ''
  const inFlight = new Set<Promise<void>>()
  const dispatch = (line: string) => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.trim()) return
    const task = handle(line)
    inFlight.add(task)
    void task.finally(() => inFlight.delete(task))
  }
  for await (const chunk of options.input) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      dispatch(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer) dispatch(buffer)

  // stdin closed: treat unanswered UI requests as cancelled, abort the running task, dispose and exit (like pi)
  for (const [id, resolve] of pending)
    resolve({ type: 'extension_ui_response', id, cancelled: true })
  pending.clear()
  await session.abort()
  await Promise.allSettled(inFlight)
  await output
}

function queueMode(mode: unknown): QueueMode {
  if (!QUEUE_MODES.includes(mode as QueueMode))
    throw new Error(`mode must be one of ${QUEUE_MODES.join(' / ')}`)
  return mode as QueueMode
}
