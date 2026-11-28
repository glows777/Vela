import type { AgentErrorKind, ImageContent } from '../driver/index.ts'
import { failureHint } from '../driver/index.ts'
import type { VelaRuntime } from '../runtime-sdk-types.ts'
import { jsonEvent, toJsonLine, writeStdout } from './json-event.ts'
import type { CliSessionClient } from './runtime-client.ts'

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('')
}

/**
 * Print mode (like pi's): send messages in order, then exit; returns the exit code.
 * - `text` (`-p`): stdout gets only the last assistant answer; on failure or abort the reason goes to stderr, exit code 1.
 * - `json` (`--mode json`): a session header line, then one v0.9 `RuntimeEvent` / `StreamDeltaEvent` JSON line per event.
 */
export async function runPrintMode(options: {
  runtime: VelaRuntime
  session: CliSessionClient
  messages: string[]
  images?: ImageContent[]
  mode: 'text' | 'json'
}): Promise<number> {
  const { runtime, session, messages, mode } = options
  let writing = Promise.resolve()
  let lastReply = ''
  let activeRunId: string | undefined
  let activeRunFailed = false
  let failure:
    | {
        message: string
        kind: AgentErrorKind | undefined
        errorHint?: string
      }
    | undefined

  let headerWritten = mode !== 'json'
  const pendingJsonLines: string[] = []
  const enqueueJsonLine = (line: string) => {
    if (!headerWritten) {
      pendingJsonLines.push(line)
      return
    }
    writing = writing.then(() => writeStdout(line))
  }

  const unsubEvents = runtime.events.subscribe((event) => {
    if (event.sessionId !== session.id) return
    if (mode === 'json') {
      enqueueJsonLine(jsonEvent(event))
    }
    if (event.type === 'run_started') {
      activeRunId = event.runId
      activeRunFailed = false
    } else if (event.type === 'message_committed') {
      const msg = event.message as { role?: unknown; content?: unknown }
      if (msg.role === 'assistant' && event.runId === activeRunId) {
        lastReply = extractMessageText(msg.content)
      }
    } else if (event.type === 'notify' && mode === 'text') {
      console.error(
        event.level === 'info'
          ? event.message
          : `[${event.level}] ${event.message}`,
      )
    } else if (event.type === 'run_finished') {
      if (event.status === 'failed') {
        if (event.runId === activeRunId) activeRunFailed = true
        failure ??= {
          message: event.error ?? 'Turn failed',
          kind: event.errorKind,
          errorHint: event.errorHint,
        }
      } else if (event.status === 'stopped') {
        if (event.runId === activeRunId) activeRunFailed = true
        failure ??= { message: 'Stopped', kind: undefined }
      } else if (event.status === 'waiting_human') {
        if (event.runId === activeRunId) activeRunFailed = true
        failure ??= {
          message: 'Waiting for human approval or input',
          kind: undefined,
        }
      }
    }
  })

  const unsubDeltas =
    mode === 'json'
      ? runtime.events.subscribeDeltas((delta) => {
          if (delta.sessionId !== session.id) return
          enqueueJsonLine(jsonEvent(delta))
        })
      : () => {}

  if (mode === 'json') {
    const snap = await session.refresh({ includeEntries: false })
    await writeStdout(
      toJsonLine({
        type: 'session',
        id: session.id,
        cwd: snap.cwd,
        model: snap.modelInfo?.ref,
        thinkingLevel: snap.thinkingLevel,
      }),
    )
    headerWritten = true
    if (pendingJsonLines.length > 0) {
      const flushed = pendingJsonLines.splice(0)
      writing = writing.then(async () => {
        for (const line of flushed) {
          await writeStdout(line)
        }
      })
    }
  }

  let exitCode = 0
  try {
    for (const [index, message] of messages.entries()) {
      const res = await session.prompt(message, {
        images: index === 0 ? options.images : undefined,
      })
      if (!res.handledCommand) {
        await session.waitForSettled()
      }
      if (failure) break
    }
    if (mode === 'text' && lastReply && !activeRunFailed && !failure) {
      await writeStdout(`${lastReply}\n`)
    }
    if (failure) {
      throw new Error(failure.message)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[Agent] Turn stopped:', msg)
    const hint = failure?.errorHint ?? failureHint(failure?.kind, error)
    if (mode === 'text' && hint) console.error(hint)
    exitCode = 1
  } finally {
    unsubDeltas()
    unsubEvents()
    await writing
  }
  return exitCode
}
