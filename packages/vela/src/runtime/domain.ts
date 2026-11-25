import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { ExecutionLocation } from '../shared/execution.ts'
import type { ChannelBinding, ChannelBindingKind } from './channels.ts'

type SessionKind = 'chat' | 'hub' | 'topic' | 'work'
type SessionState = 'idle' | 'running' | 'waiting_human' | 'stopped'

export interface ProjectRecord {
  id: string
  name: string
  cwd: string | null
  dataDir: string | null
  hubSessionId: string | null
  defaultDriver: string
  defaultLocation: ExecutionLocation | null
  defaultModel: string | null
  defaultThinkingLevel: string | null
  defaultTools: string[] | null
  config: Record<string, unknown> | null
  archived: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateProjectInput {
  id?: string
  name: string
  cwd?: string | null
  dataDir?: string | null
  /** Pass `true` to auto-create a `hub` session (Lark group), a session id, or `null` for direct local Project. */
  hubSessionId?: string | null | boolean
  defaultDriver?: string
  defaultLocation?: ExecutionLocation | null
  defaultModel?: string | null
  defaultThinkingLevel?: string | null
  defaultTools?: string[] | null
  config?: Record<string, unknown> | null
}

export interface UpdateProjectInput {
  name?: string
  cwd?: string | null
  dataDir?: string | null
  hubSessionId?: string | null
  defaultDriver?: string
  defaultLocation?: ExecutionLocation | null
  defaultModel?: string | null
  defaultThinkingLevel?: string | null
  defaultTools?: string[] | null
  config?: Record<string, unknown> | null
  archived?: boolean
}

export interface SessionRecord {
  id: string
  projectId: string | null
  kind: SessionKind
  driver: string
  externalSessionId: string | null
  name: string | null
  archived: boolean
  model: string | null
  thinkingLevel: string | null
  location: ExecutionLocation | null
  leafMessageId: string | null
  discoveredTools: string[]
  parentSessionId: string | null
  state: SessionState
  waitingReason: string | null
  followupStreak: number
  createdAt: string
  updatedAt: string
}

export interface CreateSessionInput {
  id?: string
  projectId?: string | null
  kind?: SessionKind
  driver?: string
  externalSessionId?: string | null
  name?: string | null
  model?: string | null
  thinkingLevel?: string | null
  location?: ExecutionLocation | null
  parentSessionId?: string | null
}

export interface SessionStatusInfo {
  session: SessionRecord
  activeRunId: string | null
  pendingApprovals: number
  runningJobs: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    costUsd: number
  }
}

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

interface ProjectRow {
  id: string
  name: string
  cwd: string | null
  data_dir: string | null
  hub_session_id: string | null
  default_driver: string
  default_location_json: string | null
  default_model: string | null
  default_thinking_level: string | null
  default_tools_json: string | null
  config_json: string | null
  archived: number
  created_at: string
  updated_at: string
}

interface SessionRow {
  id: string
  project_id: string | null
  kind: string
  driver: string
  external_session_id: string | null
  name: string | null
  archived: number
  model: string | null
  thinking_level: string | null
  location_json: string | null
  leaf_message_id: string | null
  discovered_tools_json: string | null
  parent_session_id: string | null
  state: string
  waiting_reason: string | null
  followup_streak: number
  created_at: string
  updated_at: string
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

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null
  return JSON.parse(raw) as T
}

function rowToProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    dataDir: row.data_dir,
    hubSessionId: row.hub_session_id,
    defaultDriver: row.default_driver,
    defaultLocation: parseJson<ExecutionLocation>(row.default_location_json),
    defaultModel: row.default_model,
    defaultThinkingLevel: row.default_thinking_level,
    defaultTools: parseJson<string[]>(row.default_tools_json),
    config: parseJson<Record<string, unknown>>(row.config_json),
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as SessionKind,
    driver: row.driver,
    externalSessionId: row.external_session_id,
    name: row.name,
    archived: row.archived === 1,
    model: row.model,
    thinkingLevel: row.thinking_level,
    location: parseJson<ExecutionLocation>(row.location_json),
    leafMessageId: row.leaf_message_id,
    discoveredTools: parseJson<string[]>(row.discovered_tools_json) ?? [],
    parentSessionId: row.parent_session_id,
    state: row.state as SessionState,
    waitingReason: row.waiting_reason,
    followupStreak: row.followup_streak ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
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

/** Manages `projects` rows without touching user directories on disk. */
export class ProjectStore {
  constructor(private readonly db: VelaDatabase) {}

  create(input: CreateProjectInput): ProjectRecord {
    const id = input.id ?? randomUUID()
    const now = new Date().toISOString()
    return this.db.transaction(() => {
      const autoHub = input.hubSessionId === true
      const hubSessionId =
        typeof input.hubSessionId === 'string'
          ? input.hubSessionId
          : autoHub
            ? `hub-${id}`
            : null

      this.db.run(
        `INSERT INTO projects (
           id, name, cwd, data_dir, hub_session_id, default_driver,
           default_location_json, default_model, default_thinking_level,
           default_tools_json, config_json, archived, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        id,
        input.name,
        input.cwd ?? null,
        input.dataDir ?? null,
        hubSessionId,
        input.defaultDriver ?? 'vela',
        input.defaultLocation ? JSON.stringify(input.defaultLocation) : null,
        input.defaultModel ?? null,
        input.defaultThinkingLevel ?? null,
        input.defaultTools ? JSON.stringify(input.defaultTools) : null,
        input.config ? JSON.stringify(input.config) : null,
        now,
        now,
      )

      if (autoHub && hubSessionId) {
        const location =
          input.defaultLocation ??
          (input.cwd ? { environment: 'local', cwd: input.cwd } : null)
        this.db.run(
          `INSERT INTO sessions (
             id, project_id, kind, driver, model, thinking_level, location_json,
             state, created_at, updated_at
           ) VALUES (?, ?, 'hub', ?, ?, ?, ?, 'idle', ?, ?)`,
          hubSessionId,
          id,
          input.defaultDriver ?? 'vela',
          input.defaultModel ?? null,
          input.defaultThinkingLevel ?? null,
          location ? JSON.stringify(location) : null,
          now,
          now,
        )
      }
      return this.get(id)!
    })
  }

  get(id: string): ProjectRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM projects WHERE id = ?',
      id,
    ) as ProjectRow | undefined
    return row ? rowToProject(row) : undefined
  }

  getByCwd(cwd: string): ProjectRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM projects WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1',
      cwd,
    ) as ProjectRow | undefined
    return row ? rowToProject(row) : undefined
  }

  list(options: { includeArchived?: boolean } = {}): ProjectRecord[] {
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT * FROM projects
       ${options.includeArchived ? '' : 'WHERE archived = 0'}
       ORDER BY updated_at DESC`,
    ) as unknown as ProjectRow[]
    return rows.map(rowToProject)
  }

  update(id: string, patch: UpdateProjectInput): ProjectRecord {
    const existing = this.get(id)
    if (!existing) throw new Error(`Project ${id} not found`)
    const now = new Date().toISOString()
    this.db.run(
      `UPDATE projects
       SET name = ?, cwd = ?, data_dir = ?, hub_session_id = ?, default_driver = ?,
           default_location_json = ?, default_model = ?, default_thinking_level = ?,
           default_tools_json = ?, config_json = ?, archived = ?, updated_at = ?
       WHERE id = ?`,
      patch.name ?? existing.name,
      patch.cwd !== undefined ? patch.cwd : existing.cwd,
      patch.dataDir !== undefined ? patch.dataDir : existing.dataDir,
      patch.hubSessionId !== undefined
        ? patch.hubSessionId
        : existing.hubSessionId,
      patch.defaultDriver ?? existing.defaultDriver,
      patch.defaultLocation !== undefined
        ? patch.defaultLocation
          ? JSON.stringify(patch.defaultLocation)
          : null
        : existing.defaultLocation
          ? JSON.stringify(existing.defaultLocation)
          : null,
      patch.defaultModel !== undefined
        ? patch.defaultModel
        : existing.defaultModel,
      patch.defaultThinkingLevel !== undefined
        ? patch.defaultThinkingLevel
        : existing.defaultThinkingLevel,
      patch.defaultTools !== undefined
        ? patch.defaultTools
          ? JSON.stringify(patch.defaultTools)
          : null
        : existing.defaultTools
          ? JSON.stringify(existing.defaultTools)
          : null,
      patch.config !== undefined
        ? patch.config
          ? JSON.stringify(patch.config)
          : null
        : existing.config
          ? JSON.stringify(existing.config)
          : null,
      (patch.archived ?? existing.archived) ? 1 : 0,
      now,
      id,
    )
    return this.get(id)!
  }

  /**
   * Unlinks project metadata from `vela.db` (`channel_bindings`, `timers`, `subscriptions`
   * cascade; `sessions.project_id` becomes `NULL` unless deleted separately).
   * Never deletes user project folders on disk.
   */
  remove(id: string, options: { deleteSessions?: boolean } = {}): boolean {
    return this.db.transaction(() => {
      const exists = this.get(id)
      if (!exists) return false
      if (options.deleteSessions) {
        this.db.run('DELETE FROM sessions WHERE project_id = ?', id)
      }
      const res = this.db.run('DELETE FROM projects WHERE id = ?', id)
      return res.changes > 0
    })
  }
}

/** Control-plane CRUD & status queries for `sessions`. */
export class SessionStoreControl {
  constructor(private readonly db: VelaDatabase) {}

  create(input: CreateSessionInput = {}): SessionRecord {
    const id = input.id ?? randomUUID()
    const now = new Date().toISOString()
    let inheritedLocation = input.location ?? null
    let inheritedModel = input.model ?? null
    let inheritedThinking = input.thinkingLevel ?? null
    let driver = input.driver ?? 'vela'
    if (input.projectId) {
      const project = this.db.get<Record<string, unknown>>(
        'SELECT * FROM projects WHERE id = ?',
        input.projectId,
      ) as ProjectRow | undefined
      if (!project) throw new Error(`Project ${input.projectId} not found`)
      driver = input.driver ?? project.default_driver
      inheritedModel ??= project.default_model
      inheritedThinking ??= project.default_thinking_level
      inheritedLocation ??=
        parseJson<ExecutionLocation>(project.default_location_json) ??
        (project.cwd ? { environment: 'local', cwd: project.cwd } : null)
    }

    this.db.run(
      `INSERT INTO sessions (
         id, project_id, kind, driver, external_session_id, name, archived,
         model, thinking_level, location_json, parent_session_id, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'idle', ?, ?)`,
      id,
      input.projectId ?? null,
      input.kind ?? 'chat',
      driver,
      input.externalSessionId ?? null,
      input.name ?? null,
      inheritedModel,
      inheritedThinking,
      inheritedLocation ? JSON.stringify(inheritedLocation) : null,
      input.parentSessionId ?? null,
      now,
      now,
    )
    return this.get(id)!
  }

  get(id: string): SessionRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM sessions WHERE id = ?',
      id,
    ) as SessionRow | undefined
    return row ? rowToSession(row) : undefined
  }

  list(
    options: { projectId?: string | null; includeArchived?: boolean } = {},
  ): SessionRecord[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (options.projectId === null) {
      where.push('project_id IS NULL')
    } else if (options.projectId !== undefined) {
      where.push('project_id = ?')
      params.push(options.projectId)
    }
    if (!options.includeArchived) {
      where.push('archived = 0')
    }
    const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`
    const rows = this.db.all<Record<string, unknown>>(
      sql,
      ...params,
    ) as unknown as SessionRow[]
    return rows.map(rowToSession)
  }

  rename(id: string, name: string | null): SessionRecord {
    const now = new Date().toISOString()
    const res = this.db.run(
      'UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?',
      name,
      now,
      id,
    )
    if (res.changes === 0) throw new Error(`Session ${id} not found`)
    return this.get(id)!
  }

  delete(id: string): boolean {
    return this.db.transaction(() => {
      const res = this.db.run('DELETE FROM sessions WHERE id = ?', id)
      return res.changes > 0
    })
  }

  reset(id: string): SessionRecord {
    const now = new Date().toISOString()
    return this.db.transaction(() => {
      const existing = this.get(id)
      if (!existing) throw new Error(`Session ${id} not found`)
      this.db.run(
        `UPDATE sessions
         SET leaf_message_id = NULL,
             discovered_tools_json = NULL,
             external_session_id = NULL,
             state = 'idle',
             waiting_reason = NULL,
             followup_streak = 0,
             updated_at = ?
         WHERE id = ?`,
        now,
        id,
      )
      this.db.run(
        `UPDATE inbox_events
         SET status = 'dropped', processed_at = ?
         WHERE session_id = ? AND status IN ('pending', 'processing')`,
        now,
        id,
      )
      return this.get(id)!
    })
  }

  status(id: string): SessionStatusInfo {
    const session = this.get(id)
    if (!session) throw new Error(`Session ${id} not found`)
    const activeRun = this.db.get<{ id: string }>(
      `SELECT id FROM runs WHERE session_id = ? AND status IN ('queued', 'running') ORDER BY started_at DESC LIMIT 1`,
      id,
    )
    const pendingApprovals =
      this.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM approvals WHERE session_id = ? AND status = 'pending'`,
        id,
      )?.n ?? 0
    const runningJobs =
      this.db.get<{ n: number }>(
        `SELECT count(*) AS n FROM background_jobs WHERE session_id = ? AND status = 'running'`,
        id,
      )?.n ?? 0
    const usage = this.db.get<{
      input_tokens: number | null
      output_tokens: number | null
      cache_read_tokens: number | null
      cache_write_tokens: number | null
      cost_usd: number | null
    }>(
      `SELECT sum(input_tokens) AS input_tokens,
              sum(output_tokens) AS output_tokens,
              sum(cache_read_tokens) AS cache_read_tokens,
              sum(cache_write_tokens) AS cache_write_tokens,
              sum(cost_usd) AS cost_usd
       FROM usage_records WHERE session_id = ?`,
      id,
    )
    return {
      session,
      activeRunId: activeRun?.id ?? null,
      pendingApprovals,
      runningJobs,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_tokens ?? 0,
        cacheWriteTokens: usage?.cache_write_tokens ?? 0,
        costUsd: usage?.cost_usd ?? 0,
      },
    }
  }
}

/** Manages durable `channel_bindings` (group root + per-topic threads + direct DMs). */
export class ChannelBindingStore {
  constructor(private readonly db: VelaDatabase) {}

  upsert(input: UpsertChannelBindingInput): ChannelBinding {
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
    const res = this.db.run(
      'UPDATE channel_bindings SET enabled = ?, updated_at = ? WHERE id = ?',
      enabled ? 1 : 0,
      new Date().toISOString(),
      id,
    )
    return res.changes > 0 ? this.get(id) : undefined
  }

  remove(id: string): boolean {
    const res = this.db.run('DELETE FROM channel_bindings WHERE id = ?', id)
    return res.changes > 0
  }
}
