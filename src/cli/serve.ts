import type { VelaEvent } from '../core.ts'
import { errorMessage } from '../logger.ts'
import type { Vela } from '../vela.ts'
import { sanitize } from './tui/components.ts'

/** Channel text is cut to one line of this many characters, like the TUI cut replies */
const LINE_LIMIT = 80

const pad = (value: number) => String(value).padStart(2, '0')

/** `YYYY-MM-DD HH:MM:SS` in the deployment's local time, so a line can be matched to other logs */
function localTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * One log line for untrusted text (chat messages, sender names): terminal sequences are stripped first,
 * because a participant could otherwise write the operator's clipboard or repaint the terminal this logs to.
 */
function oneLine(text: string): string {
  const collapsed = sanitize(text).replace(/\s+/g, ' ').trim()
  return collapsed.length > LINE_LIMIT
    ? `${collapsed.slice(0, LINE_LIMIT)}…`
    : collapsed
}

/** The stderr line for a channel event; `undefined` for every other event */
export function formatChannelEvent(
  event: VelaEvent,
  at = new Date(),
): string | undefined {
  const time = localTime(at)
  switch (event.type) {
    case 'channel_message':
      return `${time} channel_message ${oneLine(event.channel)} ${oneLine(event.senderName)}: ${oneLine(event.text)}`
    case 'channel_reply':
      return `${time} channel_reply ${oneLine(event.channel)} → ${oneLine(event.text)}`
    case 'channel_error':
      return `${time} channel_error ${oneLine(event.channel)} ${oneLine(event.senderId)}: ${
        event.aborted
          ? 'Turn aborted'
          : `Turn stopped: ${oneLine(errorMessage(event.error))}`
      }`
    default:
      return undefined
  }
}

/**
 * Runs the registered channels until SIGINT / SIGTERM, which stop them through `dispose()`.
 * stdout stays empty: one line per channel event goes to `write` (stderr), like a service log.
 * Returns 1 when nothing started, so a misconfigured daemon does not idle for days.
 */
export async function runServe(options: {
  vela: Vela
  write: (line: string) => void
}): Promise<number> {
  const { vela, write } = options
  // Before starting: a stop request while a transport is still connecting must reach dispose() too
  const shutdown = shutdownSignals()
  // Also before starting: a recovered message can be answered while later channels are still connecting
  const unsubscribe = vela.subscribe((event) => {
    const line = formatChannelEvent(event)
    if (line !== undefined) write(line)
  })
  const stop = () => {
    unsubscribe()
    return 0
  }
  try {
    await vela.startChannels()
  } catch (error) {
    if (shutdown.requested()) return stop()
    unsubscribe()
    write(`[serve] failed to start channels: ${errorMessage(error)}`)
    return 1
  }
  if (shutdown.requested()) return stop()
  if (vela.runningChannels().length === 0) {
    unsubscribe()
    write(
      '[serve] no channel started: configure one (see docs/channels.md) or check the errors above',
    )
    return 1
  }
  await shutdown.stopped
  return stop()
}

/**
 * Installs the stop handlers and returns the first stop request. They stay installed for the rest of
 * the run, so a second signal exits right away instead of waiting for a slow shutdown.
 */
function shutdownSignals(): {
  stopped: Promise<void>
  requested: () => boolean
} {
  const signals: [NodeJS.Signals, number][] = [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ...(process.platform === 'win32'
      ? []
      : ([['SIGHUP', 129]] as [NodeJS.Signals, number][])),
  ]
  let stopping = false
  let stop!: () => void
  const stopped = new Promise<void>((resolve) => {
    stop = resolve
  })
  for (const [signal, code] of signals)
    process.on(signal, () => {
      if (stopping) process.exit(code)
      stopping = true
      stop()
    })
  return { stopped, requested: () => stopping }
}
