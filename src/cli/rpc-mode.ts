import type { SessionUI } from '../extensions/types'
import { THINKING_LEVELS, type ThinkingLevel } from '../models'
import type { Vela } from '../vela'
import type { QueueMode, VelaSession } from '../vela-session'
import { jsonEvent, toJsonLine } from './json-event'

/**
 * RPC 模式（同 pi 的 `--mode rpc`）：stdin 每行一个 JSON 命令，stdout 每行一个 `response` 或事件。
 * 命令名、`id` / `response` / `disposition`、扩展界面子协议都照 pi（见 docs/rpc.md）；
 * 事件是 VelaEvent（多带 `sessionId`），只发当前活跃会话的。stdin 关闭时 dispose 并退出。
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
  /** 启动时打开的会话 */
  sessionId: string
  /** 启动时恢复这个会话的历史（`-c` / `--session`） */
  resume: boolean
  /** 新会话的 id（`new_session`） */
  newSessionId: () => string
  /** 启动会话打开之后（恢复之后）调用：命令行的 --model / --thinking 覆盖保存的设置 */
  configure?: (session: VelaSession) => void
  input: ReadableStream<Uint8Array>
  write: (text: string) => Promise<void>
}

const QUEUE_MODES: QueueMode[] = ['one-at-a-time', 'all']

export async function runRpcMode(options: RpcModeOptions): Promise<void> {
  const { vela } = options
  let output = Promise.resolve()
  const send = (record: unknown) => {
    const line = toJsonLine(record)
    output = output.then(() => options.write(line))
    return output
  }

  // 扩展界面：需要回答的发 extension_ui_request 等 extension_ui_response，其它只发
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

  vela.subscribe((event, sessionId) => {
    if (sessionId !== session.id) return
    const line = jsonEvent(event, sessionId)
    output = output.then(() => options.write(line))
  })

  const idle = () => {
    if (session.isRunning)
      throw new Error('有任务正在执行中，先 abort 或等它结束')
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
  // prompt 被接受后它的 Promise 才结束；失败已经在 agent_end 事件里报告，这里只防止未处理的 rejection
  const start = (run: Promise<void>) => void run.catch(() => {})

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
        throw new Error('streamingBehavior 只能是 steer / followUp')
      if (isExtensionCommand(message)) {
        await session.prompt(message)
        return { disposition: 'handled' }
      }
      if (session.isRunning) {
        await session.prompt(message, { streamingBehavior: behavior })
        return { disposition: 'queued' }
      }
      start(session.prompt(message))
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
        throw new Error(`没有会话 ${id}`)
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
      await session.save()
    },
    get_commands: () => ({ commands: vela.commands() }),
  }

  async function enqueue(command: RpcCommand, behavior: 'steer' | 'followUp') {
    const message = String(command.message ?? '')
    if (message.startsWith('/') && isExtensionCommand(message))
      throw new Error('扩展命令用 prompt 执行')
    if (!session.isRunning) {
      start(session.prompt(message))
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
        throw new Error('缺少 type')
    } catch (error) {
      await send({
        type: 'response',
        command: 'parse',
        success: false,
        error: `命令解析失败: ${error instanceof Error ? error.message : error}`,
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
      if (!handler) throw new Error(`未知命令: ${command.type}`)
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
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // 只按 \n 分帧（不用 readline：它会在 U+2028 / U+2029 处断行，同 pi 的提醒），容忍 \r\n
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

  // stdin 关闭：没回答的界面请求按取消处理，中断正在跑的任务，dispose 后退出（同 pi）
  for (const [id, resolve] of pending)
    resolve({ type: 'extension_ui_response', id, cancelled: true })
  pending.clear()
  await session.abort()
  await Promise.allSettled(inFlight)
  await output
}

function queueMode(mode: unknown): QueueMode {
  if (!QUEUE_MODES.includes(mode as QueueMode))
    throw new Error(`mode 只能是 ${QUEUE_MODES.join(' / ')}`)
  return mode as QueueMode
}
