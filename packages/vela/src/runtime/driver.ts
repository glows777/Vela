import { randomUUID } from 'node:crypto'
import type { RuntimeEventPayload, StreamDeltaEvent } from './events.ts'

export type RunTrigger =
  | 'user'
  | 'channel'
  | 'timer'
  | 'webhook'
  | 'approval'
  | 'job'
  | 'handoff'
  | 'session'

export const PROCESS_OWNER_PREFIX = randomUUID()

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

interface AgentDriverCapabilities {
  readonly recovery: 'step' | 'turn'
  readonly executionEnv: 'managed' | 'self'
  readonly steer: boolean
  readonly approval: boolean
}

export interface DriverInboxItem {
  id: string
  source: string
  wake: boolean
  passive: boolean
  payload: Record<string, unknown>
  createdAt: string
}

export interface DriverTerminalOutcome {
  status: 'completed'
  replyText?: string
  silent?: boolean
}

export interface DriverTurnRequest {
  sessionId: string
  projectId: string | null
  runId: string
  ownerToken: string
  trigger: RunTrigger
  inputs: DriverInboxItem[]
  recoverPending: boolean
  allowWaitingHuman: boolean
  abortSignal: AbortSignal
  onDelta: (delta: StreamDeltaEvent) => void
  onEvent: (payload: RuntimeEventPayload) => void
  /**
   * Optional hook invoked inside TX1 when the driver commits a final no-tool
   * assistant response, allowing Runtime to close `runs`, `sessions`,
   * `inbox_events`, `events`, and `outbox` in the exact same SQLite transaction.
   */
  onTerminalCommitInTx?: (outcome: DriverTerminalOutcome) => void
}

export interface DriverTurnResult {
  status: 'completed' | 'waiting_human' | 'stopped' | 'failed' | 'interrupted'
  replyText?: string
  silent?: boolean
  error?: string
  committedInTx?: boolean
}

/** Driver-agnostic execution seam hosted by `VelaRuntimeEngine`. */
export interface AgentDriver {
  readonly name: string
  readonly capabilities: AgentDriverCapabilities
  runTurn(request: DriverTurnRequest): Promise<DriverTurnResult>
  steer?(sessionId: string, text: string): void | Promise<void>
  abort?(sessionId: string): void | Promise<void>
  dispose?(): void | Promise<void>
}
