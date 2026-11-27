import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import { enqueueInboxEvent } from './inbox.ts'

export interface SubscriptionRecord {
  id: string
  source: string
  eventKey: string
  projectId: string | null
  sessionId: string
  creatorId: string | null
  creatorName: string | null
  createdAt: string
}

type SubscriptionRow = {
  id: string
  source: string
  event_key: string
  project_id: string | null
  session_id: string
  creator_id: string | null
  creator_name: string | null
  created_at: string
}

function rowToSubscription(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    source: row.source,
    eventKey: row.event_key,
    projectId: row.project_id,
    sessionId: row.session_id,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    createdAt: row.created_at,
  }
}

/** Manages durable `subscriptions` and fans external events into `inbox_events`. */
export class SubscriptionManager {
  constructor(
    private readonly db: VelaDatabase,
    private readonly onWakeSession?: (sessionId: string) => void,
  ) {}

  create(input: {
    id?: string
    source: string
    eventKey: string
    projectId?: string | null
    sessionId: string
    creatorId?: string | null
    creatorName?: string | null
  }): SubscriptionRecord {
    const id = input.id ?? randomUUID()
    const now = new Date().toISOString()
    return this.db.transaction(() => {
      this.db.run(
        `INSERT OR IGNORE INTO subscriptions (
           id, source, event_key, project_id, session_id, creator_id, creator_name, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.source,
        input.eventKey,
        input.projectId ?? null,
        input.sessionId,
        input.creatorId ?? null,
        input.creatorName ?? null,
        now,
      )
      const row = this.db.get<Record<string, unknown>>(
        `SELECT * FROM subscriptions WHERE source = ? AND event_key = ? AND session_id = ? LIMIT 1`,
        input.source,
        input.eventKey,
        input.sessionId,
      ) as SubscriptionRow | undefined
      if (!row) {
        throw new Error(
          `Failed to create subscription for ${input.source}:${input.eventKey}`,
        )
      }
      return rowToSubscription(row)
    })
  }

  remove(id: string): boolean {
    const res = this.db.run('DELETE FROM subscriptions WHERE id = ?', id)
    return res.changes > 0
  }

  list(
    filter: { sessionId?: string; projectId?: string; source?: string } = {},
  ): SubscriptionRecord[] {
    const where: string[] = []
    const params: string[] = []
    if (filter.sessionId !== undefined) {
      where.push('session_id = ?')
      params.push(filter.sessionId)
    }
    if (filter.projectId !== undefined) {
      where.push('project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.source !== undefined) {
      where.push('source = ?')
      params.push(filter.source)
    }
    const sql = `SELECT * FROM subscriptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`
    const rows = this.db.all<Record<string, unknown>>(
      sql,
      ...params,
    ) as unknown as SubscriptionRow[]
    return rows.map(rowToSubscription)
  }

  findMatching(source: string, eventKey: string): SubscriptionRecord[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM subscriptions
       WHERE source = ? AND (event_key = ? OR event_key = '*')
       ORDER BY created_at ASC`,
      source,
      eventKey,
    ) as unknown as SubscriptionRow[]
    return rows.map(rowToSubscription)
  }

  dispatchEvent(input: {
    source: string
    eventKey: string
    dedupeKey: string
    summary: string
    details?: string
    final?: boolean
    payload?: Record<string, unknown>
  }): {
    matchedSessionIds: string[]
    matchedCount: number
    enqueuedCount: number
  } {
    const wakeSessions = new Set<string>()
    let matchedCount = 0
    let enqueuedCount = 0

    this.db.transaction(() => {
      const subs = this.findMatching(input.source, input.eventKey)
      matchedCount = subs.length
      const seenSessions = new Set<string>()
      const insertedSessions = new Set<string>()
      for (const sub of subs) {
        if (seenSessions.has(sub.sessionId)) continue
        seenSessions.add(sub.sessionId)
        const { inserted } = enqueueInboxEvent(this.db, {
          sessionId: sub.sessionId,
          projectId: sub.projectId,
          source: 'webhook',
          dedupeKey: `${input.source}:${input.dedupeKey}:${input.eventKey}:${sub.sessionId}`,
          wake: true,
          payload: {
            type: 'webhook',
            subscriptionId: sub.id,
            eventSource: input.source,
            eventKey: input.eventKey,
            deliveryId: input.dedupeKey,
            summary: input.summary,
            ...(input.details !== undefined ? { details: input.details } : {}),
            ...(input.final !== undefined ? { final: input.final } : {}),
            ...(input.payload ? { data: input.payload } : {}),
          },
        })
        if (inserted) {
          enqueuedCount++
          wakeSessions.add(sub.sessionId)
          insertedSessions.add(sub.sessionId)
        }
      }
      if (input.final && subs.length > 0 && insertedSessions.size > 0) {
        for (const sub of subs) {
          if (sub.eventKey !== '*' && insertedSessions.has(sub.sessionId)) {
            this.db.run('DELETE FROM subscriptions WHERE id = ?', sub.id)
          }
        }
      }
    })

    for (const sessionId of wakeSessions) {
      this.onWakeSession?.(sessionId)
    }
    return { matchedSessionIds: [...wakeSessions], matchedCount, enqueuedCount }
  }
}
