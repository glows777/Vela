import type {
  ImageContent,
  ModelMessage,
  VelaLogger,
  VelaSession,
} from '@glows777/vela-core/extension-api'
import { LarkDeliveryRefusedError, sendAnswer } from './delivery.ts'
import {
  type ChannelDirectory,
  type ChannelRecord,
  pendingMessageId,
} from './directory.ts'
import { errorMessage } from './log.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

const INTERRUPTION_NOTICE =
  'The previous run was interrupted. Continuing from the last saved step.'
const RESEND_NOTICE =
  'This message arrived just before the restart and was not saved. Please send it again.'
const INPUT_MARKER = 'channel.input'
/** A rejected turn's input left the branch; this entry keeps the rollback and its reason on disk. */
const REJECTED_MARKER = 'channel.input_rejected'

export function storedMessage(record: ChannelRecord): IncomingMessage {
  const sender = record.routine?.creator ?? record.requester
  return {
    channelId: record.chatId,
    chatKind: record.chatKind,
    senderId: sender.id,
    senderName: sender.name,
    replyToId: record.replyTarget,
    text: '',
    passive: record.passive,
    handoff: record.handoff,
    routine: record.routine,
    ...(record.rootId && record.threadId
      ? { topic: { rootId: record.rootId, threadId: record.threadId } }
      : {}),
  }
}

/** Only the session stores input content; markers associate saved entries with admitted message IDs. */
export class ChannelRecovery {
  private inputs = new WeakMap<VelaSession, IncomingMessage[][]>()
  private subscribed = new WeakSet<VelaSession>()
  private saves = new WeakMap<VelaSession, Promise<void>[]>()
  constructor(
    private directory: ChannelDirectory,
    private logger: VelaLogger,
    private routineSaved: (
      msg: IncomingMessage,
    ) => Promise<void> = async () => {},
  ) {}

  hasInput(
    session: VelaSession,
    id: string,
    field: 'messageId' | 'handoffId' = 'messageId',
  ): boolean {
    return session
      .getEntries()
      .some(
        (entry) =>
          entry.type === 'custom' &&
          entry.customType === INPUT_MARKER &&
          (entry.data as Record<string, unknown> | undefined)?.[field] === id,
      )
  }

  /** One prompt may cover several passive inputs; each still gets its own input marker. */
  track(
    key: string,
    session: VelaSession,
    msg: IncomingMessage | IncomingMessage[],
  ): void {
    const inputs = this.inputs.get(session) ?? []
    inputs.push(Array.isArray(msg) ? msg : [msg])
    this.inputs.set(session, inputs)
    if (this.subscribed.has(session)) return
    this.subscribed.add(session)
    session.subscribe((event) => {
      if (event.type !== 'message_start' || event.message.role !== 'user')
        return
      const batch = this.inputs.get(session)?.shift()
      const recorded = batch?.filter(
        (input) => input.replyToId || input.routine || input.handoff,
      )
      if (!recorded?.length) return
      for (const input of recorded)
        session.appendEntry(INPUT_MARKER, {
          // A note's reply target is a topic root, not a message of its own.
          messageId:
            input.routine || input.handoff ? undefined : input.replyToId,
          handoffId: input.handoff?.id,
          passive: input.passive,
          routine: input.routine,
          timestamp: Date.now(),
        })
      const ids = recorded.flatMap((input) =>
        !input.routine && !input.handoff && input.replyToId
          ? [input.replyToId]
          : [],
      )
      const save = session.save().then(async () => {
        for (const input of recorded)
          if (input.routine) await this.routineSaved(input)
        if (ids.length) await this.directory.forget(key, ids)
      })
      // Keep the failure for the run's awaited drain; do not create an unhandled rejection.
      void save.catch(() => {})
      const saves = this.saves.get(session) ?? []
      saves.push(save)
      this.saves.set(session, saves)
    })
  }

  async settled(session: VelaSession): Promise<void> {
    this.inputs.delete(session)
    const saves = this.saves.get(session) ?? []
    this.saves.delete(session)
    await Promise.all(saves)
  }

  /**
   * The context guard stopped a turn before it reached the model. Drop that turn's input and record
   * the branch: the input never became context, so keeping it would fail every later prompt, and a
   * channel chat has no way to compact or reset its own session.
   */
  async dropRejectedInput(
    session: VelaSession,
    channelName: string,
    messageId: string | undefined,
    boundary: string | null,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof Error) || !error.message.includes('safe input size'))
      return
    try {
      const branch = session.getBranch()
      const turn = branch.slice(
        branch.findIndex((entry) => entry.id === boundary) + 1,
      )
      // A turn that already ran the model is not an input-size rejection: keep its work.
      if (
        turn.some(
          (entry) =>
            entry.type === 'message' && entry.message.role === 'assistant',
        )
      )
        return
      const input = turn.find(
        (entry) => entry.type === 'message' && entry.message.role === 'user',
      )
      if (!input) return
      const navigation = await session.navigateTree(input.id, {
        summarize: false,
      })
      if (navigation.cancelled)
        throw new Error('the session tree hook cancelled the rollback')
      session.appendEntry(REJECTED_MARKER, {
        messageId,
        reason: 'context over the safe input size',
      })
    } catch (rollbackError) {
      this.logger.warn(
        `[${channelName}] Could not drop the rejected input: ${errorMessage(rollbackError)}`,
      )
    }
  }

  async recover(
    record: ChannelRecord,
    channel: ChannelDefinition,
    session: VelaSession,
    run: (msg: IncomingMessage) => Promise<void>,
  ): Promise<void> {
    const dropped = record.pendingMessageIds
      .filter((input) => typeof input !== 'string')
      .map(pendingMessageId)
    if (
      record.passive &&
      record.state === 'running' &&
      record.replyTarget &&
      !dropped.includes(record.replyTarget)
    )
      dropped.push(record.replyTarget)
    if (dropped.length) {
      for (const messageId of dropped)
        if (!this.hasInput(session, messageId))
          session.appendEntry(INPUT_MARKER, {
            messageId,
            passive: true,
            timestamp: Date.now(),
          })
      await session.save()
      await this.directory.forget(record.key, dropped)
      record.pendingMessageIds = record.pendingMessageIds.filter(
        (input) => !dropped.includes(pendingMessageId(input)),
      )
      this.logger.info(
        `[${record.channel}] Dropped ${dropped.length} passive input(s) after restart; no unsolicited work resumed`,
      )
    }
    const msg = storedMessage(record)
    const entries = session.getEntries()
    const savedIds = new Set(
      entries.flatMap((entry) => {
        if (entry.type !== 'custom' || entry.customType !== INPUT_MARKER)
          return []
        const id = (entry.data as { messageId?: unknown } | undefined)
          ?.messageId
        return typeof id === 'string' ? [id] : []
      }),
    )
    const missingTrigger =
      record.replyTarget &&
      record.pendingMessageIds.some(
        (input) => pendingMessageId(input) === record.replyTarget,
      ) &&
      !savedIds.has(record.replyTarget)
    for (const input of [...record.pendingMessageIds]) {
      const id = pendingMessageId(input)
      if (!savedIds.has(id))
        await channel.send({
          ...msg,
          replyToId: id,
          text: RESEND_NOTICE,
        })
      await this.directory.forget(record.key, [id])
    }
    if (
      record.state === 'running' &&
      record.handoff &&
      !this.hasInput(session, record.handoff.id, 'handoffId')
    ) {
      // The note never reached the session: drop it like a queued note, and do not resend the previous answer.
      this.logger.info(
        `[${record.channel}] Dropped a hand-off note interrupted before it was saved`,
      )
      await this.directory.finish(record.key, 'done', true)
      return
    }
    if (missingTrigger || record.passive) {
      await this.directory.finish(record.key, 'done')
      return
    }
    if (record.state !== 'running') return
    const branch = session
      .getBranch()
      .filter((entry) => entry.type === 'message')
    const last = branch.at(-1)
    if (
      last?.message.role === 'assistant' &&
      !last.stopReason &&
      finalAnswer(last.message)
    ) {
      try {
        await sendAnswer(
          session,
          channel,
          {
            ...msg,
            recipientId: msg.senderId,
            text: finalAnswer(last.message),
          },
          true,
        )
      } catch (error) {
        if (!(error instanceof LarkDeliveryRefusedError)) throw error
        // A permanent refusal must not become a fresh feedback message on every startup.
        await this.directory.finish(record.key, 'done')
        this.logger.warn(
          `[${record.channel}] Final reply delivery refused; recovery settled without resending: ${error.message}`,
        )
        return
      }
      await this.directory.finish(record.key, 'done', true)
      return
    }
    const user = branch.findLast((entry) => entry.message.role === 'user')
    if (!user) {
      await this.directory.finish(record.key, 'done')
      return
    }
    const content = user.message.content
    msg.text =
      typeof content === 'string'
        ? content
        : content
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n')
    msg.images =
      typeof content === 'string'
        ? undefined
        : content.filter(
            (part): part is ImageContent =>
              part.type === 'image' && 'data' in part,
          )
    await channel.send({
      ...msg,
      recipientId: msg.senderId,
      text: INTERRUPTION_NOTICE,
    })
    await run(msg)
  }
}

function finalAnswer(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  if (message.content.some((part) => part.type === 'tool-call')) return ''
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}
