import type { VelaDatabase } from '../db/index.ts'
import type {
  RuntimeEvent,
  RuntimeEventPayload,
  StreamDeltaEvent,
} from './events.ts'

export type RuntimeEventListener = (event: RuntimeEvent) => void
export type StreamDeltaListener = (delta: StreamDeltaEvent) => void

interface EventRow {
  seq: number
  session_id: string
  project_id: string | null
  run_id: string | null
  type: string
  payload_json: string
  created_at: string
}

function rowToEvent(row: EventRow): RuntimeEvent {
  const payload = JSON.parse(row.payload_json) as RuntimeEventPayload
  return {
    ...payload,
    seq: row.seq,
    sessionId: row.session_id,
    projectId: row.project_id,
    timestamp: row.created_at,
  }
}

/**
 * Dual-track Runtime event bus:
 * - Structural state transitions are persisted to SQLite `events(seq)` with post-commit delivery.
 * - High-frequency streaming deltas are held/broadcast strictly in memory per active run.
 */
export class RuntimeEventBus {
  private readonly eventListeners = new Set<RuntimeEventListener>()
  private readonly deltaListeners = new Set<StreamDeltaListener>()
  private readonly activeDeltaBuffer = new Map<string, StreamDeltaEvent[]>()

  constructor(private readonly db: VelaDatabase) {}

  append(input: {
    sessionId: string
    projectId: string | null
    runId?: string | null
    payload: RuntimeEventPayload
  }): RuntimeEvent {
    const createdAt = new Date().toISOString()
    const payloadJson = JSON.stringify(input.payload)
    const runId =
      input.runId ??
      ('runId' in input.payload && typeof input.payload.runId === 'string'
        ? input.payload.runId
        : null)
    const res = this.db.run(
      `INSERT INTO events (session_id, project_id, run_id, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.sessionId,
      input.projectId,
      runId,
      input.payload.type,
      payloadJson,
      createdAt,
    )
    const event: RuntimeEvent = {
      ...input.payload,
      seq: Number(res.lastInsertRowid),
      sessionId: input.sessionId,
      projectId: input.projectId,
      timestamp: createdAt,
    }
    this.db.afterCommit(() => {
      for (const listener of this.eventListeners) {
        try {
          const maybePromise = listener(event) as unknown
          if (
            maybePromise &&
            typeof (maybePromise as PromiseLike<unknown>).then === 'function'
          ) {
            Promise.resolve(maybePromise).catch(() => {})
          }
        } catch {}
      }
    })
    return event
  }

  list(
    options: {
      sessionId?: string
      projectId?: string
      afterSeq?: number
      limit?: number
    } = {},
  ): RuntimeEvent[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (options.sessionId !== undefined) {
      where.push('session_id = ?')
      params.push(options.sessionId)
    }
    if (options.projectId !== undefined) {
      where.push('project_id = ?')
      params.push(options.projectId)
    }
    if (options.afterSeq !== undefined) {
      where.push('seq > ?')
      params.push(options.afterSeq)
    }
    const limitClause =
      options.limit !== undefined
        ? `LIMIT ${Math.max(1, Math.trunc(options.limit))}`
        : ''
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC ${limitClause}`
    const rows = this.db.all<Record<string, unknown>>(
      sql,
      ...params,
    ) as unknown as EventRow[]
    return rows.map(rowToEvent)
  }

  emitDelta(delta: StreamDeltaEvent): void {
    let buffer = this.activeDeltaBuffer.get(delta.sessionId)
    if (!buffer) {
      buffer = []
      this.activeDeltaBuffer.set(delta.sessionId, buffer)
    }
    buffer.push(delta)
    for (const listener of this.deltaListeners) {
      try {
        const maybePromise = listener(delta) as unknown
        if (
          maybePromise &&
          typeof (maybePromise as PromiseLike<unknown>).then === 'function'
        ) {
          Promise.resolve(maybePromise).catch(() => {})
        }
      } catch {}
    }
  }

  bufferedDeltas(sessionId: string): StreamDeltaEvent[] {
    return [...(this.activeDeltaBuffer.get(sessionId) ?? [])]
  }

  clearDeltas(sessionId: string): void {
    this.activeDeltaBuffer.delete(sessionId)
  }

  subscribeEvents(listener: RuntimeEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  subscribeDeltas(listener: StreamDeltaListener): () => void {
    this.deltaListeners.add(listener)
    return () => this.deltaListeners.delete(listener)
  }
}
