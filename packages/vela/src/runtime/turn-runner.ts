import type { VelaDatabase } from '../db/index.ts'
import type { VelaLogger } from '../shared/logger.ts'
import { prepareTurnAnnouncement } from './channel-control.ts'
import type { ChannelAdapter } from './channels.ts'
import {
  type AgentDriver,
  type DriverTurnResult,
  LostRunOwnershipError,
} from './driver.ts'
import type { RuntimeEventBus } from './event-bus.ts'
import type { RunEndStatus } from './events.ts'
import {
  type ClaimedTurn,
  commitCompletedTurnInTx,
  finalizeTurnInDb,
  resolveOutboxTargetInDb,
} from './worker.ts'

/**
 * Executes a single claimed session turn against its `AgentDriver`, polling for out-of-band
 * `stop_requested` markers and sealing non-TX1 outcomes into SQLite.
 */
export async function executeRuntimeClaimedTurn(params: {
  db: VelaDatabase
  eventBus: RuntimeEventBus
  driver: AgentDriver | undefined
  claimed: ClaimedTurn
  abortController: AbortController
  isDisposed: () => boolean
  wakeSession: (sessionId: string) => void
  flushOutbox: () => void
  getChannelAdapter?: (name: string) => ChannelAdapter | undefined
  isChannelEnabled?: (name: string) => boolean
  logger?: VelaLogger
}): Promise<{ lostOwnership: boolean; status?: DriverTurnResult['status'] }> {
  const { db, eventBus, driver, claimed, abortController } = params
  let stopPollTimer: ReturnType<typeof setInterval> | undefined
  let result: DriverTurnResult | undefined
  try {
    if (!driver) {
      throw new Error(
        `No AgentDriver registered for "${claimed.session.driver}"`,
      )
    }
    stopPollTimer = setInterval(() => {
      if (params.isDisposed() || !db.open || abortController.signal.aborted)
        return
      try {
        if (
          db.get(
            'SELECT 1 FROM kv_meta WHERE key = ?',
            `stop_requested:${claimed.runId}`,
          )
        ) {
          abortController.abort(
            new DOMException('Stopped by control request', 'AbortError'),
          )
          void driver.abort?.(claimed.session.id)
        }
      } catch {}
    }, 50)
    stopPollTimer.unref?.()

    const initialTarget = resolveOutboxTargetInDb(
      db,
      claimed.session,
      claimed.inputs,
      claimed.runId,
    )
    const announced = params.getChannelAdapter
      ? await prepareTurnAnnouncement({
          db,
          runId: claimed.runId,
          trigger: claimed.trigger,
          inputs: claimed.inputs,
          outboxTarget: initialTarget,
          getChannelAdapter: params.getChannelAdapter,
          isChannelEnabled: params.isChannelEnabled,
          abortSignal: abortController.signal,
          logger: params.logger ?? {
            debug() {},
            info() {},
            warn() {},
            error() {},
          },
        })
      : { skipTurn: false, outboxTarget: initialTarget, inputs: claimed.inputs }
    if (announced.skipTurn) {
      finalizeTurnInDb({
        db,
        eventBus,
        claimed,
        result: { status: 'completed', silent: true },
      })
      return { lostOwnership: false, status: 'completed' }
    }
    const outboxTarget = announced.outboxTarget
    const effectiveClaimed: ClaimedTurn =
      announced.inputs === claimed.inputs
        ? claimed
        : { ...claimed, inputs: announced.inputs }

    result = await driver.runTurn({
      sessionId: effectiveClaimed.session.id,
      projectId: effectiveClaimed.session.projectId,
      runId: effectiveClaimed.runId,
      ownerToken: effectiveClaimed.ownerToken,
      trigger: effectiveClaimed.trigger,
      inputs: effectiveClaimed.inputs,
      recoverPending: effectiveClaimed.recoverPending,
      allowWaitingHuman: effectiveClaimed.allowWaitingHuman,
      abortSignal: abortController.signal,
      onDelta: (delta) => eventBus.emitDelta(delta),
      onEvent: (payload) => {
        if (
          db.get(
            'SELECT 1 FROM kv_meta WHERE key = ?',
            `stop_requested:${claimed.runId}`,
          )
        ) {
          abortController.abort(
            new DOMException('Stopped by control request', 'AbortError'),
          )
        }
        eventBus.append({
          sessionId: claimed.session.id,
          projectId: claimed.session.projectId,
          runId: claimed.runId,
          payload,
        })
      },
      wakeSession: params.wakeSession,
      flushOutbox: params.flushOutbox,
      onTerminalCommitInTx: (outcome) =>
        commitCompletedTurnInTx({
          db,
          eventBus,
          claimed: effectiveClaimed,
          outcome,
          outboxTarget,
        }),
    })

    if (!result.committedInTx) {
      finalizeTurnInDb({
        db,
        eventBus,
        claimed: effectiveClaimed,
        result,
        outboxTarget,
      })
    }
    return { lostOwnership: false, status: result.status }
  } catch (error) {
    if (error instanceof LostRunOwnershipError) {
      return { lostOwnership: true }
    }
    const msg = error instanceof Error ? error.message : String(error)
    const status: RunEndStatus = abortController.signal.aborted
      ? 'stopped'
      : 'failed'
    try {
      finalizeTurnInDb({
        db,
        eventBus,
        claimed,
        result: { status, error: msg },
      })
    } catch (finError) {
      if (!(finError instanceof LostRunOwnershipError)) throw finError
    }
    return { lostOwnership: false, status }
  } finally {
    if (stopPollTimer) clearInterval(stopPollTimer)
  }
}
