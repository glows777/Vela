import type { VelaEvent } from '../agent/events.ts'
import { errorMessage } from '../logger.ts'
import { type Vela, velaInternals } from '../vela.ts'

/** Channel text is cut to one line of this many characters, like the TUI cut replies */
const LINE_LIMIT = 80

const pad = (value: number) => String(value).padStart(2, '0')

/** `YYYY-MM-DD HH:MM:SS` in the deployment's local time, so a line can be matched to other logs */
function localTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** One log line per event: untrusted chat text must not break the line or run longer than a screen */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s*\n\s*/g, ' ').trim()
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
      return `${time} channel_message ${event.channel} ${event.senderName}: ${oneLine(event.text)}`
    case 'channel_reply':
      return `${time} channel_reply ${event.channel} → ${oneLine(event.text)}`
    case 'channel_error':
      return `${time} channel_error ${event.channel} ${event.senderId}: ${
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
  // Before startChannels(): a recovered message can be answered while channels are still starting
  const unsubscribe = vela.subscribe((event) => {
    const line = formatChannelEvent(event)
    if (line !== undefined) write(line)
  })
  try {
    await vela.startChannels()
  } catch (error) {
    unsubscribe()
    write(`[serve] failed to start channels: ${errorMessage(error)}`)
    return 1
  }
  if (velaInternals(vela).gateway.running().length === 0) {
    unsubscribe()
    write(
      '[serve] no channel started: configure one (see docs/channels.md) or check the errors above',
    )
    return 1
  }
  await stopSignal()
  unsubscribe()
  return 0
}

/** Resolves on the first SIGINT / SIGTERM / SIGHUP; a second signal exits right away */
async function stopSignal(): Promise<void> {
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
  const handlers = signals.map(([signal, code]) => {
    const handler = () => {
      if (stopping) process.exit(code)
      stopping = true
      stop()
    }
    process.on(signal, handler)
    return () => process.off(signal, handler)
  })
  await stopped
  for (const off of handlers) off()
}
