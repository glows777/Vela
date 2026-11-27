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
}

interface ActiveRunFeedback {
  sessionId: string
  runId: string
  externalChatId: string
  threadId?: string
  messageId?: string
  reactionPromise?: Promise<string | undefined>
  progress?: LarkProgress
  progressPromise?: Promise<void>
  sawSkipReply: boolean
  controlTokens: Set<string>
}

interface ControlEntry {
  sessionId: string
  externalChatId: string
  isTopic: boolean
  isDirect: boolean
  text: string
  handled: boolean
  clear: () => void
}

function ackKey(externalChatId: string, threadId?: string): string {
  return `${externalChatId}\0${threadId ?? ''}`
}

function mapRunEndOutcome(
  status: Extract<RuntimeEvent, { type: 'run_finished' }>['status'],
  sawSkipReply: boolean,
): LarkRunOutcome {
  if (status === 'stopped') return 'stopped'
  if (status === 'failed' || status === 'interrupted') return 'failed'
  return sawSkipReply ? 'silent' : 'done'
}

/**
 * Coordinates Lark `OnIt`/`DONE`/`CrossMark` reactions and live progress / run-control cards
 * for Runtime-hosted Lark sessions using `ChannelAdapterContext` event streams.
 */
export class LarkRuntimeProgressManager {
  private readonly pendingAcks = new Map<string, PendingAck[]>()
  private readonly activeRuns = new Map<string, ActiveRunFeedback>()
  private readonly controls = new Map<string, ControlEntry>()
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

  notePendingInbound(input: {
    externalChatId: string
    threadId?: string
    messageId?: string
    replyToId?: string
    text: string
    isDirect: boolean
  }): void {
    if (this.stopped) return
    const key = ackKey(input.externalChatId, input.threadId)
    const active = this.findActiveRunByRoute(
      input.externalChatId,
      input.threadId,
    )
    if (active && !input.threadId) {
      this.postIdleControlsCard(active, input)
      return
    }
    const queue = this.pendingAcks.get(key) ?? []
    queue.push({
      messageId: input.messageId,
      replyToId: input.replyToId,
      text: input.text,
      isTopic: Boolean(input.threadId),
      isDirect: input.isDirect,
    })
    if (queue.length > 32) queue.shift()
    this.pendingAcks.set(key, queue)
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
    if (!active) {
      entry.clear()
      return ignored
    }
    entry.handled = true
    entry.clear()
    if (action === 'stop') {
      void this.ctx.stopSession?.(entry.sessionId, 'lark_card_stop')
    } else if (action === 'steer' && entry.text) {
      void this.ctx.steerSession?.(entry.sessionId, entry.text)
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
    await Promise.allSettled([...this.inflightFinish])
    this.activeRuns.clear()
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

  private postIdleControlsCard(
    active: ActiveRunFeedback,
    input: {
      externalChatId: string
      replyToId?: string
      text: string
      isDirect: boolean
    },
  ): void {
    const token = randomUUID()
    const entry: ControlEntry = {
      sessionId: active.sessionId,
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

  private onStreamDelta(delta: StreamDeltaEvent): void {
    if (this.stopped || delta.type !== 'text_delta') return
    const active = this.activeRuns.get(delta.sessionId)
    if (!active || active.runId !== delta.runId) return
    active.progress?.recordTextDelta()
  }

  private onRuntimeEvent(event: RuntimeEvent): void {
    if (this.stopped) return
    if (event.type === 'run_started') {
      const binding = this.resolveLarkBinding(event.sessionId)
      if (!binding) return
      const key = ackKey(binding.externalId, binding.threadId ?? undefined)
      const pendingQueue = this.pendingAcks.get(key)
      const pending =
        event.trigger === 'channel' ? pendingQueue?.shift() : undefined
      if (pendingQueue && pendingQueue.length === 0) {
        this.pendingAcks.delete(key)
      }

      const active: ActiveRunFeedback = {
        sessionId: event.sessionId,
        runId: event.runId,
        externalChatId: binding.externalId,
        threadId: binding.threadId ?? undefined,
        messageId: pending?.replyToId ?? pending?.messageId,
        sawSkipReply: false,
        controlTokens: new Set(),
      }
      this.activeRuns.set(event.sessionId, active)

      if (binding.kind === 'group' && active.messageId) {
        active.reactionPromise = this.transport
          .addReaction(active.messageId, 'OnIt')
          .catch((error) => {
            this.options.logger.warn(
              `[lark] Feedback failed: ${errorMessage(error)}`,
            )
            return undefined
          })
      }

      if (binding.threadId && active.messageId) {
        const token = randomUUID()
        const entry: ControlEntry = {
          sessionId: event.sessionId,
          externalChatId: binding.externalId,
          isTopic: true,
          isDirect: false,
          text: pending?.text ?? '',
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
          .sendCard(binding.externalId, card, active.messageId)
          .then((cardMessageId) => {
            if (this.stopped || this.activeRuns.get(event.sessionId) !== active)
              return
            active.progress = new LarkProgress(
              this.transport,
              cardMessageId,
              card,
              async (error) => {
                this.options.logger.warn(
                  `[lark] Progress card update failed: ${errorMessage(error)}`,
                )
              },
            )
          })
          .catch((error) => {
            entry.clear()
            this.options.logger.warn(
              `[lark] Topic control card failed: ${errorMessage(error)}`,
            )
          })
      }
      return
    }

    const active = this.activeRuns.get(event.sessionId)
    if (!active || active.runId !== event.runId) return

    if (event.type === 'tool_started') {
      if (event.toolName === 'skip_reply') active.sawSkipReply = true
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
      const outcome = mapRunEndOutcome(event.status, active.sawSkipReply)
      const task = (async () => {
        try {
          if (active.progressPromise) await active.progressPromise
          const reactionId = active.reactionPromise
            ? await active.reactionPromise
            : undefined
          await finishProgress({
            transport: this.transport,
            messageId: active.messageId,
            reactionId,
            progress: active.progress,
            outcome,
          })
        } catch (error) {
          this.options.logger.warn(
            `[lark] Run feedback completion failed: ${errorMessage(error)}`,
          )
        } finally {
          if (this.activeRuns.get(event.sessionId) === active) {
            this.activeRuns.delete(event.sessionId)
          }
        }
      })()
      this.inflightFinish.add(task)
      void task.finally(() => this.inflightFinish.delete(task))
    }
  }
}
