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

const LIVE_PROCESS_OWNERS = new Map<
  string,
  { abort?: (reason: string) => Promise<void> | void }
>()

export class LostRunOwnershipError extends Error {
  constructor(runId: string) {
    super(`Lost ownership of run ${runId} before finalization`)
    this.name = 'LostRunOwnershipError'
  }
}

export function registerLiveOwner(
  ownerToken: string,
  hooks: { abort?: (reason: string) => Promise<void> | void } = {},
): void {
  LIVE_PROCESS_OWNERS.set(ownerToken, hooks)
}

export function unregisterLiveOwner(ownerToken: string): void {
  LIVE_PROCESS_OWNERS.delete(ownerToken)
}

export async function abortLiveProcessOwner(
  ownerToken: string,
  reason: string,
): Promise<boolean> {
  const entry = LIVE_PROCESS_OWNERS.get(ownerToken)
  if (!entry?.abort) return false
  await entry.abort(reason)
  return true
}

export function assertSafePathSegment(value: string, label: string): void {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid ${label}: "${value}"`)
  }
}

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
  activeOwners: ReadonlySet<string> = new Set(),
): boolean {
  if (!ownerToken) return false
  const [prefix, pidText] = ownerToken.split(':')
  if (prefix === PROCESS_OWNER_PREFIX) {
    return LIVE_PROCESS_OWNERS.has(ownerToken) || activeOwners.has(ownerToken)
  }
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
  wakeSession?: (sessionId: string) => void
  flushOutbox?: () => void
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
