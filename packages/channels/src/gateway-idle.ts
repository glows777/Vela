import type { VelaLogger, VelaSession } from '@glows777/vela-core/extension-api'
import { errorMessage } from './log.ts'

const DEFAULT_CHANNEL_IDLE_MS = 10 * 60_000
/** With `idleMs` 0, how often a session that is busy at its deadline is checked again. */
const BUSY_RECHECK_MS = 1000

/** Idle cleanup owns timers and in-flight save-before-close operations. */
export class GatewayIdle {
  readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** New input waits until the close is done, then reopens the session. */
  readonly closing = new Map<string, Promise<void>>()

  constructor(
    private idleMs: number | undefined,
    private find: (id: string) => VelaSession | undefined,
    private queued: (id: string) => boolean,
    private stopped: () => boolean,
    private logger: VelaLogger,
  ) {}

  cancel(id: string): void {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * Channel sessions would otherwise stay open (and in memory) for as long as the process runs, one per
   * conversation. Once a chat's queue is empty, the session is closed after `idleMs`; its history
   * is saved, and the next message reopens and resumes it.
   */
  schedule(id: string, delay?: number): void {
    if (this.stopped()) return
    const idleMs = this.idleMs ?? DEFAULT_CHANNEL_IDLE_MS
    const timer = setTimeout(() => {
      this.timers.delete(id)
      const session = this.find(id)
      // A queued message rearms the timer once its reply is sent
      if (!session || this.queued(id)) return
      // Running (an extension or SDK caller is using it), or opened with a UI (the terminal resumed it): check
      // again later, so it is still closed once that use ends without another channel message
      if (session.isRunning || session.hasUI) {
        this.schedule(id, idleMs || BUSY_RECHECK_MS)
        return
      }
      const closed = this.closeIdleSession(id, session, idleMs)
        .catch((error) =>
          this.logger.error(
            `[gateway] Failed to close idle session ${id}: ${errorMessage(error)}`,
          ),
        )
        .finally(() => {
          if (this.closing.get(id) === closed) this.closing.delete(id)
        })
      this.closing.set(id, closed)
    }, delay ?? idleMs)
    // An idle timer alone doesn't keep the process alive
    timer.unref?.()
    this.timers.set(id, timer)
  }

  private async closeIdleSession(
    id: string,
    session: VelaSession,
    idleMs: number,
  ): Promise<void> {
    try {
      // A failed close discards pending history. Keep the live session until a real save succeeds.
      await session.save({ reportFailure: true })
    } catch {
      return
    }
    // New work may have arrived while saving; its queue will rearm idle cleanup.
    if (this.stopped() || this.find(id) !== session || this.queued(id)) return
    if (session.isRunning || session.hasUI) {
      this.schedule(id, idleMs || BUSY_RECHECK_MS)
      return
    }
    await session.close()
  }
}
