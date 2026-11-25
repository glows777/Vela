import type { VelaDatabase } from '../db/index.ts'
import { errorMessageOf } from './agent/step.ts'

export type RunTrigger =
  | 'user'
  | 'channel'
  | 'timer'
  | 'webhook'
  | 'approval'
  | 'job'
  | 'handoff'
  | 'session'

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

export const PROCESS_OWNER_PREFIX = crypto.randomUUID()

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function isOwnerLive(
  ownerToken: string | null,
  activeOwners: ReadonlySet<string>,
): boolean {
  if (!ownerToken) return false
  const [prefix, pidText] = ownerToken.split(':')
  if (prefix === PROCESS_OWNER_PREFIX) return activeOwners.has(ownerToken)
  return isPidAlive(Number(pidText))
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
