import type { VelaEvent } from '../agent/events'

/** JSON.stringify，Error（含 DOMException）写成 `{ name, message }`，bigint 写成字符串。 */
export function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Error) return { name: v.name, message: v.message }
    if (typeof v === 'bigint') return v.toString()
    return v
  })}\n`
}

/** json / rpc 模式的事件行：VelaEvent 原样（Error 序列化），多带一个 `sessionId`。 */
export function jsonEvent(event: VelaEvent, sessionId: string): string {
  return toJsonLine({ ...event, sessionId })
}

/**
 * 写 stdout 并在缓冲满时等它排空（同 pi 的 output-guard：读端慢时不无限堆内存）。
 * json / rpc 模式的协议输出都走这里，console 已经改写到 stderr。
 */
export function writeStdout(text: string): Promise<void> {
  if (process.stdout.write(text)) return Promise.resolve()
  return new Promise((resolve) => process.stdout.once('drain', resolve))
}

/** json / rpc / print 模式：stdout 只放结果和协议，扩展、SDK 的 console 输出改到 stderr。 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]) => console.error(...args)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
}
