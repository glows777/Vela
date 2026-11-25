import type {
  ImageContent,
  QueueMode,
  ThinkingLevel,
  VelaSession,
} from '../driver/index.ts'
import { messageText } from '../driver/index.ts'
import type { Vela } from '../vela.ts'
import { jsonEvent, toJsonLine } from './json-event.ts'
import { nextModel, scopedModels } from './model-cycle.ts'

/**
 * RPC mode (like pi's `--mode rpc`): one JSON command per stdin line, one `response` or event per stdout line.
 * Command names, `id` / `response` / `disposition` and the extension UI sub-protocol follow pi (see docs/rpc.md).
 * Events are VelaEvents (plus `sessionId`), only for the active session. Disposes and exits when stdin closes.
 */

type RpcCommand = { id?: string; type: string; [key: string]: unknown }

export interface RpcModeOptions {
  vela: Vela
  /** Session opened at startup */
  sessionId: string
  /** Restore this session's history at startup (`-c` / `--session`) */
  resume: boolean
  /** Id for a new session (`new_session`) */
  newSessionId: () => string
  /** Configure the prepared session. Explicit model/thinking overrides apply only on startup. */
  configure?: (
    session: VelaSession,
    options: { startup: boolean; defaultTools?: readonly string[] },
  ) => void
  onReady?: (session: VelaSession) => Promise<void>
  input: AsyncIterable<Uint8Array>
  write: (text: string) => Promise<void>
  /** Message for a failed command's `error` (the CLI swaps the SDK's no-model hint for its own); defaults to the error's message */
  describeError?: (error: unknown) => string
  /** Settings `enabledModels`: the models `cycle_model` goes through */
  enabledModels?: string[]
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

  let session = vela.session(options.sessionId)
  if (options.resume) await session.resume()
  const initial = await session.resources()
  options.configure?.(session, {
    startup: true,
    defaultTools: initial.defaultTools,
  })
  await options.onReady?.(session)

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
    const resources = await next.resources()
    options.configure?.(next, {
      startup: false,
      defaultTools: resources.defaultTools,
    })
    const previous = session
    session = next
    if (previous !== next) await previous.close()
  }
  const commandName = (message: string) => message.slice(1).split(/\s/, 1)[0]
  const isExtensionCommand = (message: string) =>
    message.startsWith('/') &&
    vela.commands(session.id).some((c) => c.name === commandName(message))
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
      const images = readImages(command.images)
      const behavior = command.streamingBehavior as 'steer' | undefined
      if (behavior !== undefined && behavior !== 'steer')
        throw new Error('streamingBehavior must be steer')
      if (isExtensionCommand(message)) {
        await session.prompt(message, { source: 'rpc', images })
        return { disposition: 'handled' }
      }
      if (session.isRunning) {
        await session.prompt(message, {
          streamingBehavior: behavior,
          source: 'rpc',
          images,
        })
        return { disposition: 'queued' }
      }
      start(session.prompt(message, { source: 'rpc', images }), command)
      return { disposition: 'started' }
    },
    steer: (command) => enqueue(command),
    async abort() {
      await session.abort()
    },
    clear_queue: () => session.clearQueue(),
    pending_approvals: () => ({ approvals: session.pendingApprovals() }),
    resolve_approval(command) {
      if (typeof command.approvalId !== 'string' || !command.approvalId.trim())
        throw new Error('approvalId must be a non-empty string')
      if (typeof command.approved !== 'boolean')
        throw new Error('approved must be true or false')
      return session.resolveApproval(command.approvalId, {
        approved: command.approved,
        ...(typeof command.reason === 'string'
          ? { reason: command.reason }
          : {}),
        ...(typeof command.decidedBy === 'string'
          ? { decidedBy: command.decidedBy }
          : {}),
      })
    },
    async continue_interrupted(command) {
      idle()
      start(session.continueInterrupted(), command)
      return { disposition: 'started' }
    },
    // Like pi: runs a shell command for the user (the TUI's `!`), answered with its result when it finishes
    bash(command) {
      if (typeof command.command !== 'string' || !command.command.trim())
        throw new Error('command must be a non-empty string')
      return session.executeBash(command.command, {
        excludeFromContext: command.excludeFromContext === true,
        ...(command.id === undefined ? {} : { id: command.id }),
      })
    },
    abort_bash() {
      session.abortBash()
    },
    // Moves running shell commands to the background (upstream's `background_tasks`): with an id,
    // just that model-issued bash call; without one, every call the session runs in the foreground.
    async background_tasks(command) {
      if (
        command.tool_use_id !== undefined &&
        (typeof command.tool_use_id !== 'string' || !command.tool_use_id.trim())
      )
        throw new Error('tool_use_id must be a non-empty string')
      return { ids: await session.backgroundTasks(command.tool_use_id) }
    },
    async new_session() {
      idle()
      const next = vela.session(options.newSessionId())
      await switchTo(next)
      return { sessionId: next.id }
    },
    async switch_session(command) {
      idle()
      const id = String(command.sessionId ?? '')
      const alreadyOpen = vela
        .sessions()
        .some((candidate) => candidate.id === id)
      const next = vela.session(id)
      try {
        if (next === session) {
          if (!(await vela.listSessions()).some((s) => s.id === id))
            throw new Error(`No session ${id}`)
        } else if (!(await next.resume())) {
          throw new Error(`No session ${id}`)
        }
        await switchTo(next)
      } catch (error) {
        if (!alreadyOpen && next !== session) await next.close()
        throw error
      }
      return { sessionId: next.id }
    },
    list_sessions: async () => ({ sessions: await vela.listSessions() }),
    // Session tree (pi's command names and shapes); fork / clone switch to the new session like pi
    get_tree: () => ({ tree: session.getTree(), leafId: session.getLeafId() }),
    get_entries(command) {
      let entries = session.getEntries()
      if (command.since !== undefined) {
        const index = entries.findIndex((entry) => entry.id === command.since)
        if (index < 0) throw new Error(`Entry not found: ${command.since}`)
        entries = entries.slice(index + 1)
      }
      return { entries, leafId: session.getLeafId() }
    },
    get_fork_messages: () => ({
      messages: session
        .getEntries()
        .flatMap((entry) =>
          entry.type === 'message' && entry.message.role === 'user'
            ? [{ entryId: entry.id, text: messageText(entry.message) }]
            : [],
        ),
    }),
    async fork(command) {
      idle()
      const result = await session.fork(String(command.entryId ?? ''), {
        sessionId: options.newSessionId(),
      })
      if (result.session) await switchTo(result.session)
      return { text: result.selectedText ?? '', cancelled: result.cancelled }
    },
    async clone() {
      idle()
      const result = await session.clone({ sessionId: options.newSessionId() })
      if (result.session) await switchTo(result.session)
      return { cancelled: result.cancelled }
    },
    async export_html(command) {
      return {
        path: await session.exportHtml(
          typeof command.outputPath === 'string'
            ? command.outputPath
            : undefined,
        ),
      }
    },
    set_auto_compaction(command) {
      if (typeof command.enabled !== 'boolean')
        throw new Error('enabled must be true or false')
      session.autoCompaction = command.enabled
    },
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
        messageCount: session.messages.length,
        autoCompactionEnabled: session.autoCompaction,
        pendingMessageCount: queue.steering.length,
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
    get_available_thinking_levels: () => ({
      levels: session.availableThinkingLevels(),
    }),
    // Like pi: null when there is nothing to cycle to
    async cycle_model() {
      const active = session
      const resources = await active.resources()
      if (active !== session) throw new Error('Active session changed')
      const enabledModels = resources.enabledModels ?? options.enabledModels
      let current: string | undefined
      try {
        current = session.modelInfo.ref
      } catch {}
      const next = nextModel(
        scopedModels(vela.models(), enabledModels),
        current,
      )
      if (!next) return null
      session.setModel(next.ref)
      return {
        model: session.modelInfo,
        thinkingLevel: session.thinkingLevel,
        isScoped: Boolean(enabledModels?.length),
      }
    },
    cycle_thinking_level() {
      const levels = session.availableThinkingLevels()
      if (levels.length < 2) return null
      const level =
        levels[(levels.indexOf(session.thinkingLevel) + 1) % levels.length]
      session.setThinkingLevel(level as ThinkingLevel)
      return { level: session.thinkingLevel }
    },
    set_steering_mode(command) {
      session.steeringMode = queueMode(command.mode)
    },
    async compact(command) {
      let result: unknown
      const off = session.subscribe((event) => {
        // Like pi: the compaction result
        if (event.type === 'compaction_end' && event.reason === 'manual')
          result = event.result
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
      await session.save()
    },
    // Like pi: extension commands, prompt templates and skills, each with its `source`
    async get_commands() {
      const resources = await session.resources()
      return {
        commands: [
          ...vela
            .commands(session.id)
            .map((command) => ({ ...command, source: 'extension' as const })),
          ...resources.promptTemplates.map((t) => ({
            name: t.name,
            description: t.description,
            source: 'prompt' as const,
          })),
          ...resources.skills.map((s) => ({
            name: `skill:${s.name}`,
            description: s.description,
            source: 'skill' as const,
          })),
        ],
      }
    },
  }

  async function enqueue(command: RpcCommand) {
    const message = String(command.message ?? '')
    const images = readImages(command.images)
    if (message.startsWith('/') && isExtensionCommand(message))
      throw new Error('Run extension commands with prompt')
    if (!session.isRunning) {
      start(session.prompt(message, { source: 'rpc', images }), command)
      return { disposition: 'started' }
    }
    await session.steer(message, { source: 'rpc', images })
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

  // stdin closed: abort the running task, dispose and exit (like pi)
  session.abortBash()
  await session.abort()
  await Promise.allSettled(inFlight)
  await output
}

function queueMode(mode: unknown): QueueMode {
  if (!QUEUE_MODES.includes(mode as QueueMode))
    throw new Error(`mode must be one of ${QUEUE_MODES.join(' / ')}`)
  return mode as QueueMode
}

/** Validate the JSON shape at the protocol boundary; core handles image decoding and omission hints. */
function readImages(value: unknown): ImageContent[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.some(
      (image) =>
        !image ||
        typeof image !== 'object' ||
        image.type !== 'image' ||
        typeof image.data !== 'string' ||
        typeof image.mimeType !== 'string',
    )
  )
    throw new Error(
      'images must be an array of { type: "image", data: base64, mimeType }',
    )
  return value.map((image) => ({
    type: 'image',
    data: image.data,
    mimeType: image.mimeType,
  }))
}
