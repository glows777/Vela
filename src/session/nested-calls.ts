import type { VelaEvent } from '../agent/events.ts'
import type { NestedToolCallRecord, NestedToolCalls } from './entries.ts'

/**
 * Limits of the nested-call record on a tool result (pi's NESTED_CALL_LIMITS): arguments over the
 * per-call or total size are omitted, calls beyond the count are dropped, and the record is marked
 * incomplete when any of that happens.
 */
export const NESTED_CALL_LIMITS = {
  maxCalls: 256,
  maxArgumentBytesPerCall: 8 * 1024,
  maxArgumentBytesTotal: 32 * 1024,
  maxErrorChars: 500,
} as const

const encoder = new TextEncoder()

/** The calls one model-issued tool call made through `ctx.executeTool()` (like pi's NestedCallRecorder). */
class Recorder {
  private readonly calls: NestedToolCallRecord[] = []
  private readonly byId = new Map<
    string,
    { record: NestedToolCallRecord; started: number }
  >()
  private complete = true
  private argumentBytes = 0

  start(id: string, name: string, args: unknown): void {
    if (this.calls.length >= NESTED_CALL_LIMITS.maxCalls) {
      this.complete = false
      return
    }
    const record: NestedToolCallRecord = { id, name, status: 'unfinished' }
    const json = JSON.stringify(args ?? {}) ?? '{}'
    const bytes = encoder.encode(json).length
    if (
      bytes > NESTED_CALL_LIMITS.maxArgumentBytesPerCall ||
      this.argumentBytes + bytes > NESTED_CALL_LIMITS.maxArgumentBytesTotal
    ) {
      record.argumentsBytes = bytes
      this.complete = false
    } else {
      record.arguments = JSON.parse(json)
      this.argumentBytes += bytes
    }
    this.calls.push(record)
    this.byId.set(id, { record, started: performance.now() })
  }

  finish(id: string, isError: boolean, result: unknown): void {
    const found = this.byId.get(id)
    if (!found) return
    this.byId.delete(id)
    found.record.status = isError ? 'error' : 'ok'
    found.record.durationMs = Math.round(performance.now() - found.started)
    if (isError)
      found.record.error = String(result).slice(
        0,
        NESTED_CALL_LIMITS.maxErrorChars,
      )
  }

  snapshot(): NestedToolCalls | undefined {
    if (this.calls.length === 0 && this.complete) return undefined
    const calls = this.calls.map((call) => ({ ...call }))
    return {
      calls,
      complete:
        this.complete && calls.every((call) => call.status !== 'unfinished'),
    }
  }
}

/**
 * Collects nested tool calls from `tool_execution_*` events (those with `parentToolCallId`), grouped by
 * the model-issued call they ran under (the first segment of the id), so the session can record them
 * on that call's tool result, like pi's `nestedCalls`.
 */
export class NestedCallLog {
  private readonly recorders = new Map<string, Recorder>()

  observe(event: VelaEvent): void {
    if (
      (event.type !== 'tool_execution_start' &&
        event.type !== 'tool_execution_end') ||
      event.parentToolCallId === undefined
    )
      return
    const root = event.toolCallId.split('/')[0] as string
    let recorder = this.recorders.get(root)
    if (event.type === 'tool_execution_start') {
      if (!recorder) {
        recorder = new Recorder()
        this.recorders.set(root, recorder)
      }
      recorder.start(event.toolCallId, event.toolName, event.args)
    } else recorder?.finish(event.toolCallId, event.isError, event.result)
  }

  /** Takes the record of the calls made under a model-issued tool call (undefined if it made none). */
  take(toolCallId: string): NestedToolCalls | undefined {
    const recorder = this.recorders.get(toolCallId)
    this.recorders.delete(toolCallId)
    return recorder?.snapshot()
  }
}
