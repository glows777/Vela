import { resolve } from 'node:path'
import type { VelaDatabase } from '../db/index.ts'
import {
  isOwnerLive,
  PROCESS_OWNER_PREFIX,
  type RunTrigger,
  registerLiveOwner,
  unregisterLiveOwner,
} from '../runtime/driver.ts'
import { errorMessageOf } from './agent/step.ts'

export type { RunTrigger }

export interface DriverCapabilities {
  readonly recovery: 'step'
  readonly executionEnv: 'managed'
  readonly steer: boolean
  readonly approval: boolean
}

export interface DriverRunClaim {
  runId: string
  ownerToken: string
  resumedFromWaitingHuman: boolean
  release: (rollbackStatus?: 'stopped' | 'waiting_human') => void
}

function setSessionStateInDb(
  db: VelaDatabase,
  sessionId: string,
  state: 'idle' | 'running' | 'waiting_human' | 'stopped',
  waitingReason: string | null = null,
): void {
  db.run(
    'UPDATE sessions SET state = ?, waiting_reason = ?, updated_at = ? WHERE id = ?',
    state,
    waitingReason,
    new Date().toISOString(),
    sessionId,
  )
}

export function pendingApprovalState(
  db: VelaDatabase,
  sessionId: string,
  runId: string,
): { hasRunPendingApproval: boolean; hasSessionPendingApproval: boolean } {
  const hasRunPendingApproval = Boolean(
    db.get<{ id: string }>(
      `SELECT id FROM vela_tool_calls
       WHERE session_id = ? AND run_id = ? AND status = 'awaiting_approval'
       LIMIT 1`,
      sessionId,
      runId,
    ) ??
      db.get<{ id: string }>(
        `SELECT id FROM approvals
         WHERE session_id = ? AND run_id = ? AND status = 'pending'
         LIMIT 1`,
        sessionId,
        runId,
      ),
  )
  const hasSessionPendingApproval =
    hasRunPendingApproval ||
    Boolean(
      db.get<{ id: string }>(
        `SELECT id FROM vela_tool_calls
         WHERE session_id = ? AND status = 'awaiting_approval'
         LIMIT 1`,
        sessionId,
      ) ??
        db.get<{ id: string }>(
          `SELECT id FROM approvals
           WHERE session_id = ? AND status = 'pending'
           LIMIT 1`,
          sessionId,
        ),
    )
  return { hasRunPendingApproval, hasSessionPendingApproval }
}

export function finishRunInDb(
  db: VelaDatabase,
  sessionId: string,
  runId: string,
  ownerToken: string,
  status: 'completed' | 'waiting_human' | 'stopped' | 'failed' | 'interrupted',
  error?: unknown,
  sessionState: 'idle' | 'waiting_human' = status === 'waiting_human'
    ? 'waiting_human'
    : 'idle',
): void {
  const now = new Date().toISOString()
  db.transaction(() => {
    const res = db.run(
      'UPDATE runs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ? AND owner_token = ?',
      status,
      error === undefined ? null : errorMessageOf(error),
      status === 'waiting_human' ? null : now,
      now,
      runId,
      ownerToken,
    )
    if (res.changes === 1) {
      setSessionStateInDb(
        db,
        sessionId,
        sessionState,
        sessionState === 'waiting_human' ? 'approval' : null,
      )
    }
  })
}

const activeSessionsByDb = new Map<string | object, Set<string>>()
const activeOwners = new Set<string>()

function dbKey(db: VelaDatabase): string | object {
  return db.path === ':memory:' ? db : resolve(db.path)
}

export function claimRunInDb(options: {
  db: VelaDatabase
  sessionId: string
  ensureSessionRow: () => void
  recoverPending?: boolean
  allowWaitingHuman?: boolean
  trigger?: RunTrigger
  producer: string
}): DriverRunClaim {
  const { db, sessionId } = options
  const allowWaitingHuman =
    options.allowWaitingHuman ?? Boolean(options.recoverPending)
  const ownerToken = `${PROCESS_OWNER_PREFIX}:${process.pid}:${crypto.randomUUID()}`
  let runId: string = crypto.randomUUID()
  let resumedFromWaitingHuman = false
  const now = new Date().toISOString()

  const key = dbKey(db)
  let active = activeSessionsByDb.get(key)
  if (!active) {
    active = new Set()
    activeSessionsByDb.set(key, active)
  }
  if (active.has(sessionId)) {
    throw new Error(`Session ${sessionId} already has an active run`)
  }
  active.add(sessionId)
  activeOwners.add(ownerToken)
  registerLiveOwner(ownerToken)

  try {
    options.ensureSessionRow()
    db.transaction(() => {
      const cur = db.get<{ state: string }>(
        'SELECT state FROM sessions WHERE id = ?',
        sessionId,
      )
      const existingState = cur?.state ?? 'unknown'
      const runningRows = db.all<{ id: string; owner_token: string | null }>(
        "SELECT id, owner_token FROM runs WHERE session_id = ? AND status = 'running'",
        sessionId,
      )
      if (
        runningRows.some((row) => isOwnerLive(row.owner_token, activeOwners))
      ) {
        throw new Error(`Session ${sessionId} already has an active run`)
      }
      if (!allowWaitingHuman && existingState === 'waiting_human') {
        throw new Error(
          `Session ${sessionId} cannot start a new run while state is 'waiting_human'`,
        )
      }
      if (existingState === 'running' || runningRows.length > 0) {
        db.run(
          `UPDATE runs
           SET status = 'interrupted', finished_at = COALESCE(finished_at, ?), updated_at = ?
           WHERE session_id = ? AND status = 'running'`,
          now,
          now,
          sessionId,
        )
      }

      const claimed = db.run(
        `UPDATE sessions
         SET state = 'running', waiting_reason = NULL, updated_at = ?
         WHERE id = ? AND state IN ('idle', 'running'${allowWaitingHuman ? ", 'waiting_human'" : ''})`,
        now,
        sessionId,
      )
      if (claimed.changes !== 1) {
        throw new Error(
          `Session ${sessionId} cannot ${options.recoverPending ? 'resume' : 'start a new'} run while state is '${existingState}'`,
        )
      }

      const waitingRun = options.recoverPending
        ? db.get<{ id: string }>(
            `SELECT id FROM runs
             WHERE session_id = ? AND status = 'waiting_human'
             ORDER BY started_at DESC LIMIT 1`,
            sessionId,
          )
        : undefined
      if (waitingRun) {
        const resumed = db.run(
          `UPDATE runs
           SET status = 'running', owner_token = ?, updated_at = ?
           WHERE id = ? AND status = 'waiting_human'`,
          ownerToken,
          now,
          waitingRun.id,
        )
        if (resumed.changes !== 1) {
          throw new Error(
            `Waiting run ${waitingRun.id} changed state concurrently`,
          )
        }
        runId = waitingRun.id
        resumedFromWaitingHuman = true
      } else {
        db.run(
          `INSERT INTO runs (
             id, session_id, project_id, driver, trigger, status, model, owner_token, started_at, updated_at
           ) VALUES (?, ?, NULL, 'vela', ?, 'running', ?, ?, ?, ?)`,
          runId,
          sessionId,
          options.trigger ?? 'user',
          options.producer,
          ownerToken,
          now,
          now,
        )
      }
    }, 'IMMEDIATE')
  } catch (error) {
    activeOwners.delete(ownerToken)
    unregisterLiveOwner(ownerToken)
    active.delete(sessionId)
    if (active.size === 0) activeSessionsByDb.delete(key)
    throw error
  }

  let released = false
  return {
    runId,
    ownerToken,
    resumedFromWaitingHuman,
    release: (rollbackStatus) => {
      if (released) return
      released = true
      try {
        if (rollbackStatus) {
          finishRunInDb(db, sessionId, runId, ownerToken, rollbackStatus)
        }
      } finally {
        activeOwners.delete(ownerToken)
        unregisterLiveOwner(ownerToken)
        active.delete(sessionId)
        if (active.size === 0) activeSessionsByDb.delete(key)
      }
    },
  }
}
