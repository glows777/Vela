import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import type { ExecutionLocation } from '../shared/execution.ts'
import { isOwnerLive, PROCESS_OWNER_PREFIX } from './driver.ts'
import { enqueueInboxEvent } from './inbox.ts'

const LIVE_JOB_HANDLES = new Map<
  string,
  {
    db: VelaDatabase
    dbKey: string | VelaDatabase
    ownerToken: string
    sessionId: string
    runId: string | null
    abort: () => void
  }
>()

function resolveDbKey(db: VelaDatabase): string | VelaDatabase {
  return db.path === ':memory:' ? db : resolve(db.path)
}

function jobOwnerKey(jobId: string): string {
  return `bg_owner:${jobId}`
}

export function jobStopKey(jobId: string): string {
  return `bg_stop_requested:${jobId}`
}

export function hasLiveSessionJobs(
  db: VelaDatabase,
  sessionId: string,
): boolean {
  const dbKey = resolveDbKey(db)
  const liveTokens = new Set<string>()
  for (const [jobId, handle] of LIVE_JOB_HANDLES) {
    if (!handle.db.open) {
      LIVE_JOB_HANDLES.delete(jobId)
      continue
    }
    if (handle.dbKey === dbKey) {
      if (handle.sessionId === sessionId) return true
      liveTokens.add(handle.ownerToken)
    }
  }
  const rows = db.all<{ id: string }>(
    `SELECT id FROM background_jobs WHERE session_id = ? AND status = 'running'`,
    sessionId,
  )
  for (const row of rows) {
    const ownerRow = db.get<{ value_json: string }>(
      'SELECT value_json FROM kv_meta WHERE key = ?',
      jobOwnerKey(row.id),
    )
    if (!ownerRow) continue
    try {
      const token = JSON.parse(ownerRow.value_json) as string
      if (isOwnerLive(token, liveTokens)) return true
    } catch {}
  }
  return false
}

export type BackgroundJobStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'

export interface BackgroundJobRecord {
  id: string
  sessionId: string
  runId: string | null
  command: string
  commandHead: string
  location: ExecutionLocation | null
  status: BackgroundJobStatus
  exitCode: number | null
  outputPath: string | null
  startedAt: string
  finishedAt: string | null
  updatedAt: string
}

interface BackgroundJobRow {
  id: string
  session_id: string
  run_id: string | null
  command: string
  command_head: string
  location_json: string | null
  status: string
  exit_code: number | null
  output_path: string | null
  started_at: string
  finished_at: string | null
  updated_at: string
}

function rowToJob(row: BackgroundJobRow): BackgroundJobRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    command: row.command,
    commandHead: row.command_head,
    location: row.location_json
      ? (JSON.parse(row.location_json) as ExecutionLocation)
      : null,
    status: row.status as BackgroundJobStatus,
    exitCode: row.exit_code,
    outputPath: row.output_path,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Runtime-owned `background_jobs` persistence and process-level live handle registry.
 * Decoupled from individual `Run` / `waiting_human` worker lifecycles so background commands
 * keep running when a Run finishes or suspends, and enqueue `inbox_events` upon exit or restart.
 */
export class BackgroundJobManager {
  constructor(
    private readonly db: VelaDatabase,
    private readonly onWakeSession?: (sessionId: string) => void,
  ) {}

  recordStart(input: {
    id?: string
    sessionId: string
    runId?: string | null
    command: string
    commandHead: string
    location?: ExecutionLocation | null
    outputPath?: string | null
    abort?: () => void
  }): BackgroundJobRecord {
    const id = input.id ?? randomUUID()
    const now = new Date().toISOString()
    const ownerToken = `${PROCESS_OWNER_PREFIX}:${process.pid}:${id}`
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO background_jobs (
           id, session_id, run_id, command, command_head, location_json,
           status, output_path, started_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
        id,
        input.sessionId,
        input.runId ?? null,
        input.command,
        input.commandHead,
        input.location ? JSON.stringify(input.location) : null,
        input.outputPath ?? null,
        now,
        now,
      )
      this.db.run(
        `INSERT INTO kv_meta (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        jobOwnerKey(id),
        JSON.stringify(ownerToken),
        now,
      )
    })
    LIVE_JOB_HANDLES.set(id, {
      db: this.db,
      dbKey: resolveDbKey(this.db),
      ownerToken,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      abort: input.abort ?? (() => {}),
    })
    return this.get(id)!
  }

  recordFinish(input: {
    id: string
    status: 'completed' | 'failed' | 'stopped'
    exitCode?: number | null
    outputPath?: string | null
    summaryText?: string
    silent?: boolean
  }): BackgroundJobRecord | undefined {
    const existing = this.get(input.id)
    if (!existing) return undefined
    LIVE_JOB_HANDLES.delete(input.id)
    const now = new Date().toISOString()
    let shouldWake = false

    this.db.transaction(() => {
      this.db.run('DELETE FROM kv_meta WHERE key = ?', jobOwnerKey(input.id))
      this.db.run('DELETE FROM kv_meta WHERE key = ?', jobStopKey(input.id))
      const res = this.db.run(
        `UPDATE background_jobs
         SET status = ?, exit_code = ?, output_path = COALESCE(?, output_path),
             finished_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
        input.status,
        input.exitCode ?? null,
        input.outputPath ?? null,
        now,
        now,
        input.id,
      )
      if (res.changes === 1 && !input.silent) {
        const session = this.db.get<{ project_id: string | null }>(
          'SELECT project_id FROM sessions WHERE id = ?',
          existing.sessionId,
        )
        const { inserted } = enqueueInboxEvent(this.db, {
          sessionId: existing.sessionId,
          projectId: session?.project_id ?? null,
          source: 'job',
          dedupeKey: `job:${existing.id}`,
          wake: true,
          payload: {
            type: 'background_job',
            jobId: existing.id,
            status: input.status,
            commandHead: existing.commandHead,
            ...(input.exitCode !== undefined && input.exitCode !== null
              ? { exitCode: input.exitCode }
              : {}),
            ...((input.outputPath ?? existing.outputPath)
              ? { outputPath: input.outputPath ?? existing.outputPath }
              : {}),
            text:
              input.summaryText ??
              `Background command "${existing.commandHead}" ${input.status}${
                input.exitCode !== undefined && input.exitCode !== null
                  ? ` (exit code ${input.exitCode})`
                  : ''
              }.`,
          },
        })
        shouldWake = inserted
      }
    })

    if (shouldWake) this.onWakeSession?.(existing.sessionId)
    return this.get(input.id)
  }

  stopSessionJobs(sessionId: string, runId?: string): number {
    const dbKey = resolveDbKey(this.db)
    const now = new Date().toISOString()
    let stopped = 0
    for (const [jobId, handle] of LIVE_JOB_HANDLES) {
      if (handle.dbKey !== dbKey || handle.sessionId !== sessionId) continue
      if (runId !== undefined && handle.runId !== runId) continue
      LIVE_JOB_HANDLES.delete(jobId)
      try {
        handle.abort()
      } catch {}
      this.recordFinish({ id: jobId, status: 'stopped', silent: true })
      stopped++
    }
    const liveTokens = new Set(
      [...LIVE_JOB_HANDLES.values()]
        .filter((h) => h.dbKey === dbKey && h.db.open)
        .map((h) => h.ownerToken),
    )
    const rows =
      runId !== undefined
        ? this.db.all<{ id: string }>(
            `SELECT id FROM background_jobs WHERE session_id = ? AND run_id = ? AND status = 'running'`,
            sessionId,
            runId,
          )
        : this.db.all<{ id: string }>(
            `SELECT id FROM background_jobs WHERE session_id = ? AND status = 'running'`,
            sessionId,
          )
    for (const row of rows) {
      const ownerRow = this.db.get<{ value_json: string }>(
        'SELECT value_json FROM kv_meta WHERE key = ?',
        jobOwnerKey(row.id),
      )
      let ownerToken: string | null = null
      if (ownerRow) {
        try {
          ownerToken = JSON.parse(ownerRow.value_json) as string
        } catch {}
      }
      if (ownerToken && isOwnerLive(ownerToken, liveTokens)) {
        this.db.run(
          `INSERT INTO kv_meta (key, value_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          jobStopKey(row.id),
          JSON.stringify({ sessionId }),
          now,
        )
        stopped++
        continue
      }
      const res = this.db.run(
        `UPDATE background_jobs
         SET status = 'stopped', finished_at = COALESCE(finished_at, ?), updated_at = ?
         WHERE id = ? AND status = 'running'`,
        now,
        now,
        row.id,
      )
      this.db.run('DELETE FROM kv_meta WHERE key = ?', jobOwnerKey(row.id))
      this.db.run('DELETE FROM kv_meta WHERE key = ?', jobStopKey(row.id))
      stopped += res.changes
    }
    return stopped
  }

  /** On startup, reconciles orphaned `running` jobs as `interrupted` and notifies via `inbox_events`. */
  recoverInterrupted(
    nowIso = new Date().toISOString(),
    skipSession?: (sessionId: string) => boolean,
  ): string[] {
    const dbKey = resolveDbKey(this.db)
    const interrupted: string[] = []
    const wakeSessions = new Set<string>()
    for (const [jobId, handle] of LIVE_JOB_HANDLES) {
      if (!handle.db.open) {
        LIVE_JOB_HANDLES.delete(jobId)
      }
    }
    const liveTokens = new Set(
      [...LIVE_JOB_HANDLES.values()]
        .filter((entry) => entry.dbKey === dbKey)
        .map((entry) => entry.ownerToken),
    )

    this.db.transaction(() => {
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT * FROM background_jobs WHERE status = 'running' ORDER BY started_at ASC`,
      ) as unknown as BackgroundJobRow[]
      for (const raw of rows) {
        if (skipSession?.(raw.session_id)) continue
        const localHandle = LIVE_JOB_HANDLES.get(raw.id)
        if (localHandle && localHandle.dbKey === dbKey) continue
        const ownerRow = this.db.get<{ value_json: string }>(
          'SELECT value_json FROM kv_meta WHERE key = ?',
          jobOwnerKey(raw.id),
        )
        let ownerToken: string | null = null
        if (ownerRow) {
          try {
            ownerToken = JSON.parse(ownerRow.value_json) as string
          } catch {}
        }
        if (ownerToken && isOwnerLive(ownerToken, liveTokens)) continue

        const job = rowToJob(raw)
        this.db.run(
          `UPDATE background_jobs
           SET status = 'interrupted', finished_at = COALESCE(finished_at, ?), updated_at = ?
           WHERE id = ? AND status = 'running'`,
          nowIso,
          nowIso,
          job.id,
        )
        this.db.run('DELETE FROM kv_meta WHERE key = ?', jobOwnerKey(job.id))
        this.db.run('DELETE FROM kv_meta WHERE key = ?', jobStopKey(job.id))
        const session = this.db.get<{ project_id: string | null }>(
          'SELECT project_id FROM sessions WHERE id = ?',
          job.sessionId,
        )
        enqueueInboxEvent(this.db, {
          sessionId: job.sessionId,
          projectId: session?.project_id ?? null,
          source: 'job',
          dedupeKey: `job-interrupted:${job.id}`,
          wake: true,
          payload: {
            type: 'background_job',
            jobId: job.id,
            status: 'interrupted',
            commandHead: job.commandHead,
            text: `Background command "${job.commandHead}" ended when Vela restarted before it finished.`,
          },
        })
        interrupted.push(job.id)
        wakeSessions.add(job.sessionId)
      }
    })

    for (const sessionId of wakeSessions) {
      this.onWakeSession?.(sessionId)
    }
    return interrupted
  }

  get(id: string): BackgroundJobRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM background_jobs WHERE id = ?',
      id,
    ) as BackgroundJobRow | undefined
    return row ? rowToJob(row) : undefined
  }

  listBySession(
    sessionId: string,
    status?: BackgroundJobStatus,
  ): BackgroundJobRecord[] {
    const rows = status
      ? (this.db.all<Record<string, unknown>>(
          `SELECT * FROM background_jobs WHERE session_id = ? AND status = ? ORDER BY started_at ASC`,
          sessionId,
          status,
        ) as unknown as BackgroundJobRow[])
      : (this.db.all<Record<string, unknown>>(
          `SELECT * FROM background_jobs WHERE session_id = ? ORDER BY started_at ASC`,
          sessionId,
        ) as unknown as BackgroundJobRow[])
    return rows.map(rowToJob)
  }
}
