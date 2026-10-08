import type { VelaEvent } from '../agent/events.ts'

/** JSON.stringify that writes Errors (including DOMException) as `{ name, message }` and bigints as strings. */
export function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Error) return { name: v.name, message: v.message }
    if (typeof v === 'bigint') return v.toString()
    return v
  })}\n`
}

/** An event line in json / rpc mode: the VelaEvent as is (Errors serialized), plus `sessionId`. */
export function jsonEvent(event: VelaEvent, sessionId: string): string {
  return toJsonLine({ ...event, sessionId })
}

/**
 * Write to stdout and wait for it to drain when the buffer is full (like pi's output-guard: a slow
 * reader must not grow memory unbounded). All json / rpc protocol output goes through here; console is redirected to stderr.
 */
export function writeStdout(text: string): Promise<void> {
  if (process.stdout.write(text)) return Promise.resolve()
  return new Promise((resolve) => process.stdout.once('drain', resolve))
}

/** json / rpc / print modes: stdout carries only results and protocol; console output from extensions and the SDK goes to stderr. */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
}
