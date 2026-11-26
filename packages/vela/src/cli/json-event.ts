import type { RuntimeEvent, StreamDeltaEvent } from '../runtime/events.ts'

/** JSON.stringify that writes Errors (including DOMException) as `{ name, message }` and bigints as strings. */
export function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Error) return { name: v.name, message: v.message }
    if (typeof v === 'bigint') return v.toString()
    return v
  })}\n`
}

/** Formats a v0.9 `RuntimeEvent` or `StreamDeltaEvent` directly as a `--mode json` NDJSON line. */
export function jsonEvent(event: RuntimeEvent | StreamDeltaEvent): string {
  return toJsonLine(event)
}

/** Error codes meaning the reader of stdout went away (e.g. `vela --mode json … | head -3`). */
const CLOSED_PIPE_CODES = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
])
let guarded = false

function onStdoutError(error: unknown): never {
  const code = (error as { code?: unknown } | undefined)?.code
  if (typeof code === 'string' && CLOSED_PIPE_CODES.has(code)) process.exit(0)
  console.error(`[stdout] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}

/**
 * Write to stdout and wait for it to drain when the buffer is full.
 * All json / print protocol output goes through here; console is redirected to stderr.
 * If the reader closes stdout (EPIPE), the process exits quietly with code 0.
 */
export function writeStdout(text: string): Promise<void> {
  if (!guarded) {
    guarded = true
    process.stdout.on('error', onStdoutError)
  }
  try {
    if (process.stdout.write(text)) return Promise.resolve()
  } catch (error) {
    onStdoutError(error)
  }
  return new Promise((resolve) => {
    const finish = () => {
      process.stdout.off('drain', finish)
      process.stdout.off('close', finish)
      process.stdout.off('error', finish)
      resolve()
    }
    process.stdout.once('drain', finish)
    process.stdout.once('close', finish)
    process.stdout.once('error', finish)
  })
}

/** json / print modes: stdout carries only results and protocol; console output goes to stderr. */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
}
