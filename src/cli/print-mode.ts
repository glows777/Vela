import type { ModelMessage } from 'ai'
import type { Vela } from '../vela'
import type { VelaSession } from '../vela-session'
import { jsonEvent, toJsonLine, writeStdout } from './json-event'

/** 最后一条助手消息的文本（-p 的输出）。 */
export function lastAssistantText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ModelMessage
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') return message.content
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
  }
  return ''
}

/**
 * 单次模式（同 pi 的 print mode）：依次发送 messages，然后退出，返回退出码。
 * - `text`（`-p`）：stdout 只写最后一条助手回答；失败或中断时原因写 stderr，退出码 1。
 * - `json`（`--mode json`）：先写一行会话头，再每个事件一行 JSON。
 */
export async function runPrintMode(options: {
  vela: Vela
  session: VelaSession
  messages: string[]
  mode: 'text' | 'json'
}): Promise<number> {
  const { vela, session, messages, mode } = options
  let writing = Promise.resolve()
  // -p 只输出这次调用产生的回答：恢复的会话里旧的回答不算（例如 `vela -c -p /memory` 不该打印上次的回答）
  let answer: ModelMessage | undefined
  const offAnswer = session.subscribe((event) => {
    if (event.type === 'message' && event.message.role === 'assistant')
      answer = event.message
  })
  const off: () => void =
    mode === 'json'
      ? vela.subscribe((event, sessionId) => {
          if (sessionId !== session.id) return
          const line = jsonEvent(event, sessionId)
          writing = writing.then(() => writeStdout(line))
        })
      : // -p 没有界面：扩展的 notify（例如 `vela -p /memory`）写到 stderr，stdout 只放回答
        session.subscribe((event) => {
          if (event.type === 'notify')
            console.error(
              event.level === 'info'
                ? event.message
                : `[${event.level}] ${event.message}`,
            )
        })
  if (mode === 'json') {
    let model: string | undefined
    try {
      model = session.modelInfo.ref
    } catch {}
    await writeStdout(
      toJsonLine({
        type: 'session',
        id: session.id,
        cwd: vela.cwd,
        model,
        thinkingLevel: session.thinkingLevel,
      }),
    )
  }
  let exitCode = 0
  try {
    for (const message of messages) await session.prompt(message)
    if (mode === 'text') {
      const text = answer ? lastAssistantText([answer]) : ''
      if (text) await writeStdout(`${text}\n`)
    }
  } catch (error) {
    console.error(
      '[Agent] 本轮停止:',
      error instanceof Error ? error.message : error,
    )
    exitCode = 1
  } finally {
    off()
    offAnswer()
    await writing
  }
  return exitCode
}
