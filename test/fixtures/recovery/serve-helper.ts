import { errorMessage } from '../../../packages/vela/src/cli/error.ts'
import { sanitize } from '../../../packages/vela/src/cli/tui/components.ts'
import type { VelaEvent } from '../../../packages/vela/src/driver/index.ts'
import type { ChannelVela as Vela } from '../../../packages/vela/src/legacy-channels/index.ts'

const LINE_LIMIT = 80
const pad = (value: number) => String(value).padStart(2, '0')

function localTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function oneLine(text: string): string {
  const collapsed = sanitize(text).replace(/\s+/g, ' ').trim()
  return collapsed.length > LINE_LIMIT
    ? `${collapsed.slice(0, LINE_LIMIT)}…`
    : collapsed
}

function formatChannelEvent(
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
          : event.source === 'feedback'
            ? `Feedback failed: ${oneLine(errorMessage(event.error))}`
            : `Turn stopped: ${oneLine(errorMessage(event.error))}`
      }`
    default:
      return undefined
  }
}

/** Local legacy-channel test harness replacing removed `cli/serve.ts` inside S4a recovery fixtures until S4b migrates channels. */
export async function runServe(options: {
  vela: Vela
  write: (line: string) => void
}): Promise<number> {
  const { vela, write } = options
  const shutdown = shutdownSignals(() => {
    const deadline = setTimeout(() => {
      write(
        '[serve] Shutdown exceeded 30 seconds; unfinished work will recover as interrupted.',
      )
      for (const session of vela.sessions()) {
        session.abortBash()
        void session.abort(
          new DOMException('Shutdown deadline exceeded', 'AbortError'),
        )
      }
      process.exit(143)
    }, 30_000)
    deadline.unref()
    return vela
      .dispose({ graceful: true })
      .finally(() => clearTimeout(deadline))
  })
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

function shutdownSignals(shutdown: () => Promise<void>): {
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
  for (const [signal, code] of signals) {
    process.on(signal, () => {
      if (stopping) process.exit(code)
      stopping = true
      void shutdown().then(stop, (error) => {
        process.stderr.write(
          `[serve] Shutdown failed: ${errorMessage(error)}\n`,
        )
        stop()
      })
    })
  }
  return { stopped, requested: () => stopping }
}
