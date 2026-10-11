import type { ModelMessage } from 'ai'
import type { Vela } from '../vela.ts'
import type { VelaSession } from '../vela-session.ts'
import { jsonEvent, toJsonLine, writeStdout } from './json-event.ts'

/** Text of the last assistant message (the output of -p). */
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
 * Print mode (like pi's): send messages in order, then exit; returns the exit code.
 * - `text` (`-p`): stdout gets only the last assistant answer; on failure or abort the reason goes to stderr, exit code 1.
 * - `json` (`--mode json`): a session header line, then one JSON line per event.
 */
export async function runPrintMode(options: {
  vela: Vela
  session: VelaSession
  messages: string[]
  mode: 'text' | 'json'
}): Promise<number> {
  const { vela, session, messages, mode } = options
  let writing = Promise.resolve()
  // -p prints only answers from this run, not old ones in a resumed session (e.g. `vela -c -p /memory` must not print the previous answer)
  let answer: ModelMessage | undefined
  const offAnswer = session.subscribe((event) => {
    if (
      event.type === 'message_end' &&
      event.message.role === 'assistant' &&
      event.stopReason !== 'error' &&
      event.stopReason !== 'aborted'
    )
      answer = event.message
  })
  const off: () => void =
    mode === 'json'
      ? vela.subscribe((event, sessionId) => {
          if (sessionId !== session.id) return
          const line = jsonEvent(event, sessionId)
          writing = writing.then(() => writeStdout(line))
        })
      : // -p has no UI: extension notify (e.g. `vela -p /memory`) goes to stderr, stdout carries only the answer
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
    for (const message of messages)
      await session.prompt(message, { source: 'interactive' })
    if (mode === 'text') {
      const text = answer ? lastAssistantText([answer]) : ''
      if (text) await writeStdout(`${text}\n`)
    }
  } catch (error) {
    console.error(
      '[Agent] Turn stopped:',
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
