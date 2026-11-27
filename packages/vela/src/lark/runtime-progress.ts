import { randomUUID } from 'node:crypto'
import type {
  ChannelAdapterContext,
  ChannelBinding,
} from '../runtime/channels.ts'
import type { RuntimeEvent, StreamDeltaEvent } from '../runtime/events.ts'
import type { VelaLogger } from '../shared/logger.ts'
import {
  type LarkCardAction,
  type LarkCardResponse,
  runControlsCard,
  topicRunCard,
} from './cards.ts'
import { errorMessage } from './log.ts'
import {
  finishProgress,
  LarkProgress,
  type LarkRunOutcome,
} from './progress.ts'
import type { LarkTransport } from './transport.ts'

interface PendingAck {
  messageId?: string
  replyToId?: string
  text: string
  isTopic: boolean
  isDirect: boolean
  passive?: boolean
}

interface ActiveRunFeedback {
  sessionId: string
  runId: string
  inboxEventIds?: readonly string[]
  externalChatId: string
  threadId?: string
  messageId?: string
  isGroup: boolean
  isPassive: boolean
  sawTextDelta: boolean
  cancelled: boolean
  reactionStarted: boolean
  reactionRemoved: boolean
  reactionPromise?: Promise<string | undefined>
  progress?: LarkProgress
  progressPromise?: Promise<void>
  sawSkipReply: boolean
  controlTokens: Set<string>
}

interface ControlEntry {
  sessionId: string
  runId: string
  inboxEventId?: string
  externalChatId: string
  isTopic: boolean
  isDirect: boolean
  text: string
  handled: boolean
  clear: () => void
}

function mapRunEndOutcome(
  status: Extract<RuntimeEvent, { type: 'run_finished' }>['status'],
  silent: boolean,
): LarkRunOutcome {
  if (status === 'stopped') return 'stopped'
  if (status === 'failed' || status === 'interrupted') return 'failed'
  return silent ? 'silent' : 'done'
}

/**
 * Coordinates Lark `OnIt`/`DONE`/`CrossMark` reactions and live progress / run-control cards
 * for Runtime-hosted Lark sessions using `ChannelAdapterContext` event streams.
 */
export class LarkRuntimeProgressManager {
  private readonly pendingAcks = new Map<string, PendingAck>()
  private readonly activeRuns = new Map<string, ActiveRunFeedback>()
  private readonly controls = new Map<string, ControlEntry>()
  private readonly awaitingOutbox = new Map<
    string,
    { settle: (ok: boolean) => void; cancel: () => Promise<void> }
  >()
  private readonly inflightFinish = new Set<Promise<void>>()
  private unsubEvents?: () => void
  private unsubDeltas?: () => void
  private stopped = false

  constructor(
    private readonly ctx: ChannelAdapterContext,
    private readonly transport: LarkTransport,
    private readonly options: {
      isChatEnabled: (chatId: string) => boolean
      isOwner: (senderId: string) => boolean
      logger: VelaLogger
    },
  ) {}

  start(): void {
    this.stopped = false
    this.unsubEvents = this.ctx.subscribeEvents?.((event) => {
      this.onRuntimeEvent(event)
    })
    this.unsubDeltas = this.ctx.subscribeDeltas?.((delta) => {
      this.onStreamDelta(delta)
    })
  }

  noteAdmittedInbound(input: {
    inboxEventId: string
    externalChatId: string
    threadId?: string
    messageId?: string
    replyToId?: string
    text: string
    isDirect: boolean
    passive?: boolean
  }): void {
    if (this.stopped) return
    const ownActive = this.findActiveRunByInboxEventId(input.inboxEventId)
    if (ownActive) {
      // `scheduleSession()` may fire `run_started` synchronously before `ingestWithReceipt()` returns.
      const msgId = input.replyToId ?? input.messageId
      if (msgId && !ownActive.messageId) {
        ownActive.messageId = msgId
      }
      ownActive.isPassive = Boolean(input.passive)
      if (
        !ownActive.reactionRemoved &&
        ownActive.isGroup &&
        ownActive.messageId &&
        (!ownActive.isPassive || ownActive.sawTextDelta)
      ) {
        this.ensureReaction(ownActive)
      }
      if (
        ownActive.threadId &&
        ownActive.messageId &&
        !ownActive.progressPromise
      ) {
        this.startTopicProgressCard(ownActive, ownActive.messageId, input.text)
      }
      return
    }
    const active = this.findActiveRunByRoute(
      input.externalChatId,
      input.threadId,
    )
    if (active && input.threadId && !input.passive) {
      void Promise.resolve(
        this.ctx.steerInboxEvent?.(
          active.sessionId,
          input.inboxEventId,
          input.text,
        ),
      )
        .then((steered) => {
          if (steered) {
            this.pendingAcks.delete(input.inboxEventId)
          }
        })
        .catch((error) => {
          this.options.logger.warn(
            `[lark] Failed to auto-steer topic session ${active.sessionId}: ${errorMessage(error)}`,
          )
        })
    } else if (
      active &&
      !active.isPassive &&
      !input.threadId &&
      !input.passive
    ) {
      this.postIdleControlsCard(active, input)
    }
    this.pendingAcks.set(input.inboxEventId, {
      messageId: input.messageId,
      replyToId: input.replyToId,
      text: input.text,
      isTopic: Boolean(input.threadId),
      isDirect: input.isDirect,
      passive: input.passive,
    })
    if (this.pendingAcks.size > 256) {
      this.pendingAcks.delete(this.pendingAcks.keys().next().value as string)
    }
  }

  noteOutboxOutcome(runId: string, delivered: boolean): void {
    const entry = this.awaitingOutbox.get(runId)
    if (!entry) return
    this.awaitingOutbox.delete(runId)
    entry.settle(delivered)
  }

  handleCardAction(event: LarkCardAction): LarkCardResponse {
    const ignored: LarkCardResponse = {
      toast: {
        type: 'info',
        content: 'This control is unavailable or has expired.',
      },
    }
    const value = event.action?.value
    if (this.stopped || !value || typeof value !== 'object') return ignored
    const { action, token } = value as { action?: unknown; token?: unknown }
    if (
      typeof token !== 'string' ||
      (action !== 'queue' && action !== 'steer' && action !== 'stop')
    ) {
      return ignored
    }
    const entry = this.controls.get(token)
    const operator = event.operator?.open_id
    if (
      !entry ||
      entry.handled ||
      !operator ||
      event.context?.open_chat_id !== entry.externalChatId
    ) {
      return ignored
    }
    if (
      !this.options.isChatEnabled(entry.externalChatId) &&
      !(entry.isDirect && this.options.isOwner(operator))
    ) {
      return ignored
    }
    if (entry.isTopic && action !== 'stop') return ignored
    const active = this.activeRuns.get(entry.sessionId)
    if (!active || active.runId !== entry.runId) {
      entry.clear()
      return ignored
    }
    entry.handled = true
    entry.clear()
    if (action === 'stop') {
      if (entry.inboxEventId) {
        this.ctx.discardInboxEvent?.(entry.inboxEventId)
      }
      void Promise.resolve(
        this.ctx.stopSession?.(entry.sessionId, 'lark_card_stop'),
      ).catch((error) => {
        this.options.logger.warn(
          `[lark] Failed to stop session ${entry.sessionId}: ${errorMessage(error)}`,
        )
      })
    } else if (action === 'steer' && entry.text) {
      const steerPromise =
        entry.inboxEventId && this.ctx.steerInboxEvent
          ? this.ctx.steerInboxEvent(
              entry.sessionId,
              entry.inboxEventId,
              entry.text,
            )
          : Promise.resolve(
              this.ctx.steerSession?.(entry.sessionId, entry.text),
            ).then(() => true)
      void steerPromise.catch((error) => {
        this.options.logger.warn(
          `[lark] Failed to steer session ${entry.sessionId}: ${errorMessage(error)}`,
        )
      })
    }
    return {
      toast: {
        type: 'success',
        content: {
          queue: 'Message queued.',
          steer: 'Adding the message to the current run.',
          stop: 'Stopping the current run.',
        }[action],
      },
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubEvents?.()
    this.unsubEvents = undefined
    this.unsubDeltas?.()
    this.unsubDeltas = undefined
    for (const entry of [...this.controls.values()]) {
      entry.clear()
    }
    this.controls.clear()
    this.pendingAcks.clear()

    const pendingOutboxCancels = [...this.awaitingOutbox.values()].map((item) =>
      item.cancel(),
    )
    this.awaitingOutbox.clear()

    const liveRuns = [...this.activeRuns.values()]
    this.activeRuns.clear()
    const teardownTasks = liveRuns.map((active) =>
      this.cancelActiveFeedback(active),
    )

    await Promise.allSettled([
      ...pendingOutboxCancels,
      ...teardownTasks,
      ...this.inflightFinish,
    ])
  }

  private resolveLarkBinding(sessionId: string): ChannelBinding | undefined {
    const bindings = this.ctx.listBindings?.({
      channel: 'lark',
      enabledOnly: true,
    })
    if (!bindings?.length) return undefined
    const direct = bindings.find((b) => b.sessionId === sessionId)
    if (direct) return direct
    const session = this.ctx.getSession?.(sessionId)
    if (session?.projectId && session.kind === 'hub') {
      return bindings.find(
        (b) => b.projectId === session.projectId && !b.threadId,
      )
    }
    return undefined
  }

  private findActiveRunByInboxEventId(
    inboxEventId: string,
  ): ActiveRunFeedback | undefined {
    for (const active of this.activeRuns.values()) {
      if (active.inboxEventIds?.includes(inboxEventId)) {
        return active
      }
    }
    return undefined
  }

  private findActiveRunByRoute(
    externalChatId: string,
    threadId?: string,
  ): ActiveRunFeedback | undefined {
    for (const active of this.activeRuns.values()) {
      if (
        active.externalChatId === externalChatId &&
        (active.threadId ?? undefined) === (threadId ?? undefined)
      ) {
        return active
      }
    }
    return undefined
  }

  private startTopicProgressCard(
    active: ActiveRunFeedback,
    messageId: string,
    text: string,
  ): void {
    if (active.progressPromise) return
    const token = randomUUID()
    const entry: ControlEntry = {
      sessionId: active.sessionId,
      runId: active.runId,
      externalChatId: active.externalChatId,
      isTopic: true,
      isDirect: false,
      text,
      handled: false,
      clear: () => {
        this.controls.delete(token)
        active.controlTokens.delete(token)
      },
    }
    this.controls.set(token, entry)
    active.controlTokens.add(token)
    const card = topicRunCard(token)
    active.progressPromise = this.transport
      .sendCard(active.externalChatId, card, messageId)
      .then((cardMessageId) => {
        const prog = new LarkProgress(
          this.transport,
          cardMessageId,
          card,
          async (error) => {
            this.options.logger.warn(
              `[lark] Progress card update failed: ${errorMessage(error)}`,
            )
          },
        )
        if (this.stopped || active.cancelled) {
          void prog.cancel().catch(() => {})
          return
        }
        active.progress = prog
      })
      .catch((error) => {
        entry.clear()
        this.options.logger.warn(
          `[lark] Topic control card failed: ${errorMessage(error)}`,
        )
      })
  }

  private postIdleControlsCard(
    active: ActiveRunFeedback,
    input: {
      inboxEventId: string
      externalChatId: string
      replyToId?: string
      text: string
      isDirect: boolean
    },
  ): void {
    const token = randomUUID()
    const entry: ControlEntry = {
      sessionId: active.sessionId,
      runId: active.runId,
      inboxEventId: input.inboxEventId,
      externalChatId: input.externalChatId,
      isTopic: false,
      isDirect: input.isDirect,
      text: input.text,
      handled: false,
      clear: () => {
        this.controls.delete(token)
        active.controlTokens.delete(token)
      },
    }
    this.controls.set(token, entry)
    active.controlTokens.add(token)
    const card = runControlsCard(token)
    void this.transport
      .sendCard(input.externalChatId, card, input.replyToId)
      .catch((error) => {
        entry.clear()
        this.options.logger.warn(
          `[lark] Control card failed: ${errorMessage(error)}`,
        )
      })
  }

  private ensureReaction(active: ActiveRunFeedback): void {
    if (
      this.stopped ||
      active.reactionStarted ||
      active.reactionRemoved ||
      !active.isGroup ||
      !active.messageId
    ) {
      return
    }
    active.reactionStarted = true
    active.reactionPromise = this.transport
      .addReaction(active.messageId, 'OnIt')
      .then(async (id) => {
        if (
          (this.stopped || active.reactionRemoved) &&
          active.messageId &&
          id
        ) {
          await this.transport
            .removeReaction(active.messageId, id)
            .catch(() => {})
          return undefined
        }
        return id
      })
      .catch((error) => {
        this.options.logger.warn(
          `[lark] Feedback failed: ${errorMessage(error)}`,
        )
        return undefined
      })
  }

  private async cancelActiveFeedback(active: ActiveRunFeedback): Promise<void> {
    active.cancelled = true
    active.reactionRemoved = true
    if (active.progressPromise) {
      await active.progressPromise.catch(() => {})
    }
    await active.progress?.cancel().catch(() => {})
    if (active.reactionPromise && active.messageId) {
      const id = await active.reactionPromise.catch(() => undefined)
      if (id) {
        await this.transport
          .removeReaction(active.messageId, id)
          .catch(() => {})
      }
    }
  }

  private onStreamDelta(delta: StreamDeltaEvent): void {
    if (this.stopped || delta.type !== 'text_delta') return
    const active = this.activeRuns.get(delta.sessionId)
    if (!active || active.runId !== delta.runId) return
    if (delta.delta) {
      active.sawTextDelta = true
      if (active.isPassive && !active.sawSkipReply) {
        this.ensureReaction(active)
      }
    }
    active.progress?.recordTextDelta()
  }

  private onRuntimeEvent(event: RuntimeEvent): void {
    if (this.stopped) return
    if (event.type === 'run_started') {
      const binding = this.resolveLarkBinding(event.sessionId)
      if (!binding) return
      let pending: PendingAck | undefined
      let matchedPassive = false
      for (const inboxId of event.inboxEventIds ?? []) {
        const candidate = this.pendingAcks.get(inboxId)
        if (!candidate) continue
        this.pendingAcks.delete(inboxId)
        if (!candidate.passive) {
          pending = candidate
        } else {
          matchedPassive = true
          // Select the newest passive input in the batch to match outboxTargetFromInputs.
          if (!pending || pending.passive) pending = candidate
        }
      }
      const isPassive = Boolean(pending?.passive && matchedPassive)

      const active: ActiveRunFeedback = {
        sessionId: event.sessionId,
        runId: event.runId,
        inboxEventIds: event.inboxEventIds,
        externalChatId: binding.externalId,
        threadId: binding.threadId ?? undefined,
        messageId: pending?.replyToId ?? pending?.messageId,
        isGroup: binding.kind === 'group',
        isPassive,
        sawTextDelta: false,
        cancelled: false,
        reactionStarted: false,
        reactionRemoved: false,
        sawSkipReply: false,
        controlTokens: new Set(),
      }
      this.activeRuns.set(event.sessionId, active)

      if (!isPassive && binding.kind === 'group' && active.messageId) {
        this.ensureReaction(active)
      }

      if (binding.threadId && active.messageId) {
        this.startTopicProgressCard(
          active,
          active.messageId,
          pending?.text ?? '',
        )
      }
      return
    }

    const active = this.activeRuns.get(event.sessionId)
    if (!active || active.runId !== event.runId) return

    if (event.type === 'tool_started') {
      active.progress?.recordToolStart(
        event.toolCallId,
        event.toolName,
        event.input,
      )
      return
    }

    if (event.type === 'tool_finished') {
      if (event.toolName === 'skip_reply' && !event.isError) {
        active.sawSkipReply = true
      }
      active.progress?.recordToolEnd(
        event.toolCallId,
        event.toolName,
        event.isError,
        event.details,
      )
      return
    }

    if (event.type === 'run_finished') {
      for (const token of active.controlTokens) {
        this.controls.delete(token)
      }
      active.controlTokens.clear()
      if (this.activeRuns.get(event.sessionId) === active) {
        this.activeRuns.delete(event.sessionId)
      }
      const outcome = mapRunEndOutcome(
        event.status,
        event.silent ?? active.sawSkipReply,
      )
      const finalize = async (finalOutcome: LarkRunOutcome): Promise<void> => {
        try {
          if (finalOutcome === 'silent') {
            active.cancelled = true
            active.reactionRemoved = true
          }
          if (active.progressPromise) {
            await active.progressPromise.catch(() => {})
          }
          const reactionId = active.reactionPromise
            ? await active.reactionPromise.catch(() => undefined)
            : undefined
          await finishProgress({
            transport: this.transport,
            messageId: active.messageId,
            reactionId,
            progress: active.progress,
            outcome: finalOutcome,
          })
          if (finalOutcome === 'silent') {
            await active.progress?.cancel().catch(() => {})
          }
        } catch (error) {
          this.options.logger.warn(
            `[lark] Run feedback completion failed: ${errorMessage(error)}`,
          )
        }
      }

      if (event.replyPending && outcome === 'done') {
        const waitPromise = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (this.awaitingOutbox.delete(event.runId)) {
              void this.cancelActiveFeedback(active).finally(resolve)
            } else {
              resolve()
            }
          }, 30_000)
          this.awaitingOutbox.set(event.runId, {
            settle: (ok) => {
              clearTimeout(timer)
              void finalize(ok ? 'done' : 'failed').finally(resolve)
            },
            cancel: async () => {
              clearTimeout(timer)
              await this.cancelActiveFeedback(active)
              resolve()
            },
          })
        })
        this.inflightFinish.add(waitPromise)
        void waitPromise.finally(() => this.inflightFinish.delete(waitPromise))
        return
      }

      const task = finalize(outcome)
      this.inflightFinish.add(task)
      void task.finally(() => this.inflightFinish.delete(task))
    }
  }
}
