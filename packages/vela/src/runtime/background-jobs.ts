import { randomUUID } from 'node:crypto'
import type { VelaDatabase } from '../db/index.ts'
import type { ExecutionLocation } from '../shared/execution.ts'
import { enqueueInboxEvent } from './inbox.ts'

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
  private readonly liveHandles = new Map<
    string,
    { sessionId: string; abort: () => void }
  >()

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
    if (input.abort) {
      this.liveHandles.set(id, {
        sessionId: input.sessionId,
        abort: input.abort,
      })
    }
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
    this.liveHandles.delete(input.id)
    const now = new Date().toISOString()
    let shouldWake = false

    this.db.transaction(() => {
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

  stopSessionJobs(sessionId: string): number {
    let stopped = 0
    for (const [jobId, handle] of this.liveHandles) {
      if (handle.sessionId !== sessionId) continue
      this.liveHandles.delete(jobId)
      try {
        handle.abort()
      } catch {}
      this.recordFinish({ id: jobId, status: 'stopped', silent: true })
      stopped++
    }
    const now = new Date().toISOString()
    const res = this.db.run(
      `UPDATE background_jobs
       SET status = 'stopped', finished_at = COALESCE(finished_at, ?), updated_at = ?
       WHERE session_id = ? AND status = 'running'`,
      now,
      now,
      sessionId,
    )
    return Math.max(stopped, res.changes)
  }

  /** On startup, reconciles orphaned `running` jobs as `interrupted` and notifies via `inbox_events`. */
  recoverInterrupted(nowIso = new Date().toISOString()): string[] {
    const interrupted: string[] = []
    const wakeSessions = new Set<string>()

    this.db.transaction(() => {
      const rows = this.db.all<Record<string, unknown>>(
        `SELECT * FROM background_jobs WHERE status = 'running' ORDER BY started_at ASC`,
      ) as unknown as BackgroundJobRow[]
      for (const raw of rows) {
        if (this.liveHandles.has(raw.id)) continue
        const job = rowToJob(raw)
        this.db.run(
          `UPDATE background_jobs
           SET status = 'interrupted', finished_at = COALESCE(finished_at, ?), updated_at = ?
           WHERE id = ? AND status = 'running'`,
          nowIso,
          nowIso,
          job.id,
        )
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
