import type { ImageContent, ModelMessage } from '../messages.ts'
import type { VelaSession } from '../vela-session.ts'
import type { ChannelDirectory, ChannelRecord } from './directory.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

export const INTERRUPTION_NOTICE =
  'The previous run was interrupted. Continuing from the last saved input.'
export const RESEND_NOTICE =
  'This message arrived just before the restart and was not saved. Please send it again.'
const INPUT_MARKER = 'channel.input'

export function storedMessage(record: ChannelRecord): IncomingMessage {
  return {
    channelId: record.chatId,
    senderId: record.requester.id,
    senderName: record.requester.name,
    replyToId: record.replyTarget,
    text: '',
    ...(record.rootId && record.threadId
      ? { topic: { rootId: record.rootId, threadId: record.threadId } }
      : {}),
  }
}

/** Only the session stores input content; markers associate saved entries with admitted message IDs. */
export class ChannelRecovery {
  private inputs = new WeakMap<VelaSession, IncomingMessage[]>()
  private subscribed = new WeakSet<VelaSession>()
  private saves = new WeakMap<VelaSession, Promise<void>[]>()
  constructor(private directory: ChannelDirectory) {}

  track(session: VelaSession, msg: IncomingMessage): void {
    const inputs = this.inputs.get(session) ?? []
    inputs.push(msg)
    this.inputs.set(session, inputs)
    if (this.subscribed.has(session)) return
    this.subscribed.add(session)
    session.subscribe((event) => {
      if (event.type !== 'message_start' || event.message.role !== 'user')
        return
      const input = this.inputs.get(session)?.shift()
      if (!input?.replyToId) return
      const messageId = input.replyToId
      session.appendEntry(INPUT_MARKER, { messageId })
      const save = session
        .save()
        .then(() => this.directory.forget(session.id, [messageId]))
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

  async recover(
    record: ChannelRecord,
    channel: ChannelDefinition,
    session: VelaSession,
    run: (msg: IncomingMessage) => Promise<void>,
  ): Promise<void> {
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
      record.pendingMessageIds.includes(record.replyTarget) &&
      !savedIds.has(record.replyTarget)
    for (const id of [...record.pendingMessageIds]) {
      if (!savedIds.has(id))
        await channel.send({
          ...msg,
          replyToId: id,
          recipientId: msg.senderId,
          text: RESEND_NOTICE,
        })
      await this.directory.forget(record.key, [id])
    }
    if (missingTrigger) {
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
      await channel.send({
        ...msg,
        recipientId: msg.senderId,
        text: finalAnswer(last.message),
      })
      await this.directory.finish(record.key, 'done')
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
        : content.map((part) => ('text' in part ? part.text : '')).join('\n')
    msg.images =
      typeof content === 'string'
        ? undefined
        : content.filter(
            (part): part is ImageContent =>
              part.type === 'image' && 'data' in part,
          )
    const navigation = await session.navigateTree(user.id, { summarize: false })
    if (navigation.cancelled)
      throw new Error('Recovery was cancelled by the session tree hook')
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
    .map((part) => ('text' in part ? part.text : ''))
    .join('')
}
