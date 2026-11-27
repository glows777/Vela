import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { ChannelBinding, ChannelBindingKind } from './channels.ts'

export interface UpsertChannelBindingInput {
  id?: string
  channel: string
  externalId: string
  threadId?: string | null
  kind: ChannelBindingKind
  projectId?: string | null
  sessionId?: string | null
  enabled?: boolean
  config?: Record<string, unknown>
}

interface ChannelBindingRow {
  id: string
  channel: string
  external_id: string
  thread_id: string | null
  kind: string
  project_id: string | null
  session_id: string | null
  enabled: number
  config_json: string | null
}

function rowToBinding(row: ChannelBindingRow): ChannelBinding {
  return {
    id: row.id,
    channel: row.channel,
    externalId: row.external_id,
    threadId: row.thread_id,
    kind: row.kind as ChannelBindingKind,
    projectId: row.project_id,
    sessionId: row.session_id,
    enabled: row.enabled === 1,
    ...(row.config_json
      ? { config: JSON.parse(row.config_json) as Record<string, unknown> }
      : {}),
  }
}

/** Manages durable `channel_bindings` (group root + per-topic threads + direct DMs). */
export class ChannelBindingStore {
  constructor(private readonly db: VelaDatabase) {}

  upsert(input: UpsertChannelBindingInput): ChannelBinding {
    return this.db.transaction(() => {
      const now = new Date().toISOString()
      const threadId = input.threadId ?? null
      const existing = this.findByExternal(
        input.channel,
        input.externalId,
        threadId ?? undefined,
      )
      const id = existing?.id ?? input.id ?? randomUUID()
      const enabled = input.enabled ?? existing?.enabled ?? true
      const configJson =
        input.config !== undefined
          ? JSON.stringify(input.config)
          : existing?.config
            ? JSON.stringify(existing.config)
            : null

      if (existing) {
        this.db.run(
          `UPDATE channel_bindings
           SET kind = ?, project_id = ?, session_id = ?, enabled = ?, config_json = ?, updated_at = ?
           WHERE id = ?`,
          input.kind,
          input.projectId !== undefined ? input.projectId : existing.projectId,
          input.sessionId !== undefined ? input.sessionId : existing.sessionId,
          enabled ? 1 : 0,
          configJson,
          now,
          id,
        )
      } else {
        this.db.run(
          `INSERT INTO channel_bindings (
             id, channel, external_id, thread_id, kind, project_id, session_id,
             enabled, config_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.channel,
          input.externalId,
          threadId,
          input.kind,
          input.projectId ?? null,
          input.sessionId ?? null,
          enabled ? 1 : 0,
          configJson,
          now,
          now,
        )
      }
      return this.get(id)!
    })
  }

  get(id: string): ChannelBinding | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM channel_bindings WHERE id = ?',
      id,
    ) as ChannelBindingRow | undefined
    return row ? rowToBinding(row) : undefined
  }

  findByExternal(
    channel: string,
    externalId: string,
    threadId?: string,
  ): ChannelBinding | undefined {
    const row = threadId
      ? (this.db.get<Record<string, unknown>>(
          'SELECT * FROM channel_bindings WHERE channel = ? AND external_id = ? AND thread_id = ?',
          channel,
          externalId,
          threadId,
        ) as ChannelBindingRow | undefined)
      : (this.db.get<Record<string, unknown>>(
          'SELECT * FROM channel_bindings WHERE channel = ? AND external_id = ? AND thread_id IS NULL',
          channel,
          externalId,
        ) as ChannelBindingRow | undefined)
    return row ? rowToBinding(row) : undefined
  }

  list(
    filter: {
      channel?: string
      projectId?: string
      enabledOnly?: boolean
    } = {},
  ): ChannelBinding[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.channel !== undefined) {
      where.push('channel = ?')
      params.push(filter.channel)
    }
    if (filter.projectId !== undefined) {
      where.push('project_id = ?')
      params.push(filter.projectId)
    }
    if (filter.enabledOnly) {
      where.push('enabled = 1')
    }
    const sql = `SELECT * FROM channel_bindings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`
    const rows = this.db.all<Record<string, unknown>>(
      sql,
      ...params,
    ) as unknown as ChannelBindingRow[]
    return rows.map(rowToBinding)
  }

  setEnabled(id: string, enabled: boolean): ChannelBinding | undefined {
    return this.db.transaction(() => {
      const existing = this.get(id)
      if (!existing) return undefined
      const now = new Date().toISOString()
      let nextConfigJson: string | null | undefined
      if (existing.config && 'disabledBySync' in existing.config) {
        const { disabledBySync: _, ...rest } = existing.config
        nextConfigJson =
          Object.keys(rest).length > 0 ? JSON.stringify(rest) : null
      }
      if (nextConfigJson !== undefined) {
        this.db.run(
          'UPDATE channel_bindings SET enabled = ?, config_json = ?, updated_at = ? WHERE id = ?',
          enabled ? 1 : 0,
          nextConfigJson,
          now,
          id,
        )
      } else {
        this.db.run(
          'UPDATE channel_bindings SET enabled = ?, updated_at = ? WHERE id = ?',
          enabled ? 1 : 0,
          now,
          id,
        )
      }
      return this.get(id)
    })
  }

  remove(id: string): boolean {
    const res = this.db.run('DELETE FROM channel_bindings WHERE id = ?', id)
    return res.changes > 0
  }
}
