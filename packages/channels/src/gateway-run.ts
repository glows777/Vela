import type { VelaLogger, VelaSession } from '@glows777/vela-core/extension-api'
import { publishChannelEvent } from '@glows777/vela-core/extension-api'
import type { TopicAdmission } from './admission.ts'
import type { TopicCommands } from './commands.ts'
import type { ChannelDirectory } from './directory.ts'
import type { RunFeedback } from './feedback.ts'
import type { GatewayIdle } from './gateway-idle.ts'
import type { ChannelHandoff } from './handoff.ts'
import { errorMessage } from './log.ts'
import type { ChannelRecovery } from './recovery.ts'
import type { ChannelRoutines } from './routines.ts'
import type { ChannelSessions } from './sessions.ts'
import type {
  ChannelDefinition,
  ChannelOutcome,
  ChannelSessionUpdate,
  IncomingMessage,
  OutgoingMessage,
} from './types.ts'
import type { ChannelUsage } from './usage.ts'

const MAX_SAVE_FAILURES = 3

/** One admitted run, including preparation, persisted recovery and reply delivery. */
export class GatewayRun {
  private subscribed = new WeakSet<VelaSession>()
  private saveFailures = new Map<string, number>()

  constructor(
    private directory: ChannelDirectory,
    private admission: TopicAdmission,
    private commands: TopicCommands,
    private feedback: RunFeedback,
    private sessions: ChannelSessions,
    private usage: ChannelUsage,
    private recovery: ChannelRecovery,
    private routines: ChannelRoutines,
    private handoff: ChannelHandoff,
    private idle: GatewayIdle,
    private channel: (name: string) => ChannelDefinition | undefined,
    private changed: (id: string, run?: ChannelSessionUpdate['run']) => void,
    private stopped: () => boolean,
    private logger: VelaLogger,
  ) {}

  saved(id: string): void {
    this.saveFailures.delete(this.directory.keyForSession(id))
  }

  clearSaveFailures(): void {
    this.saveFailures.clear()
  }

  async process(
    id: string,
    channelName: string,
    msg: IncomingMessage | IncomingMessage[],
    recovered = false,
  ): Promise<void> {
    const messages = Array.isArray(msg) ? msg : [msg]
    const trigger = messages[0]!
    const processing = this.commands.begin(id)
    this.changed(id, { type: 'started', runId: processing.runId })
    let outcome: ChannelOutcome | undefined = 'failed'
    try {
      outcome = await this.processRun(
        id,
        channelName,
        messages,
        processing,
        recovered,
      )
    } catch (error) {
      await this.feedback.feedbackError(channelName, trigger, error)
    } finally {
      this.commands.end(id, processing)
      this.changed(id, {
        type: 'finished',
        runId: processing.runId,
        outcome: outcome ?? 'done',
      })
      if (outcome)
        await Promise.all(
          (this.feedback.acknowledgements.get(trigger) ?? []).map((input) =>
            input.finish(outcome!),
          ),
        )
    }
  }

  private async processRun(
    id: string,
    channelName: string,
    messages: IncomingMessage[],
    processing: { stopped: boolean; preparing: boolean },
    recovered = false,
  ): Promise<ChannelOutcome | undefined> {
    if (this.stopped()) return 'stopped'
    let trigger = messages[0]!
    this.logger.debug(
      `[${channelName}] input ${trigger.replyToId ?? '-'} preparing at=${new Date().toISOString()}`,
    )
    await this.idle.closing.get(id)
    const channel = this.channel(channelName)
    if (trigger.externalEvent) {
      const record = this.directory.get(id)
      if (!record || channel?.canRecover?.(trigger, record.chatKind) === false)
        return 'done'
    }
    const topicSession =
      trigger.topic || trigger.passive
        ? await this.admission.admit(id, channel, trigger)
        : undefined
    if (trigger.topic && !topicSession) return 'failed'
    let batch = messages
    if (trigger.passive && topicSession) {
      // A merged evaluation must skip every input a restart already recorded.
      const known = batch.filter(
        (item) =>
          item.replyToId &&
          this.recovery.hasInput(topicSession, item.replyToId),
      )
      if (known.length) {
        await this.directory.forget(
          id,
          known.flatMap((item) => (item.replyToId ? [item.replyToId] : [])),
        )
        batch = batch.filter((item) => !known.includes(item))
        if (!batch.length) return 'done'
        trigger = batch[0]!
      }
    }
    const ids = (items: IncomingMessage[]) =>
      items.flatMap((item) => (item.replyToId ? [item.replyToId] : []))
    const inputs = channel
      ? this.feedback.acknowledge(channel, trigger, !recovered)
      : []
    await Promise.all(inputs.map((input) => input.ready))
    this.logger.debug(
      `[${channelName}] input ${trigger.replyToId ?? '-'} acknowledged at=${new Date().toISOString()}`,
    )
    const input = trigger
    const task = trigger.text
    // Each merged input keeps its own attribution, images and marker; only the prompt is shared.
    const prepared: (IncomingMessage | undefined)[] = []
    for (const message of batch)
      prepared.push(
        !processing.stopped && !recovered && channel?.prepareMessage
          ? await channel.prepareMessage(message)
          : message,
      )
    const evaluated = prepared.filter(
      (message): message is IncomingMessage => !!message,
    )
    this.logger.debug(
      `[${channelName}] input ${trigger.replyToId ?? '-'} prepared at=${new Date().toISOString()}`,
    )
    const stopped = async (
      session = topicSession ?? this.sessions.open(id, channelName, trigger),
    ): Promise<ChannelOutcome> => {
      await this.directory.forget(id, ids(batch))
      await this.directory.finish(id, 'stopped')
      await this.sendReply(
        session,
        channelName,
        trigger,
        'Stopped the current run.',
      )
      return 'stopped'
    }
    if (processing.stopped) return stopped()
    if (evaluated.length < batch.length)
      await this.directory.forget(
        id,
        ids(batch.filter((_, index) => !prepared[index])),
      )
    if (!evaluated.length) {
      // Undefined means the adapter handled the input without a model prompt.
      return 'failed'
    }
    if (this.stopped()) return 'failed'
    const answered = evaluated[evaluated.length - 1]!
    const images = evaluated.flatMap((message) => message.images ?? [])
    // The merged run answers the most recent input; earlier ones are its context.
    const merged =
      evaluated.length > 1
        ? {
            ...answered,
            text: evaluated.map((message) => message.text).join('\n\n'),
            ...(images.length ? { images } : {}),
          }
        : answered
    const session = topicSession ?? this.sessions.open(id, channelName, merged)
    this.admission.observe(id, channelName, merged, task)
    this.usage.track(id, merged.channelId, session)
    if (!this.subscribed.has(session)) {
      this.subscribed.add(session)
      session.subscribe((event) => {
        if (event.type !== 'session_save_failed') return
        if (!this.stopped())
          this.saveFailures.set(id, (this.saveFailures.get(id) ?? 0) + 1)
        this.logger.error(
          `[gateway] Could not save session ${id}: ${errorMessage(event.error)}`,
        )
      })
    }
    if ((this.saveFailures.get(id) ?? 0) >= MAX_SAVE_FAILURES) {
      try {
        // Retry the retained live session, without appending the new input or calling the model.
        await session.save()
      } catch {
        // The refusal below reports the continuing outage; only a real write clears the count.
      }
    }
    // A blocked session must reply even when the storage outage also prevents reads.
    if (
      (this.saveFailures.get(id) ?? 0) < MAX_SAVE_FAILURES &&
      !this.admission.resumed.has(session)
    ) {
      await session.resume()
      this.admission.resumed.add(session)
    }
    if (
      merged.routine &&
      !recovered &&
      !(await this.routines.shouldRun(merged, session))
    )
      return 'done'
    for (const message of evaluated)
      publishChannelEvent(session, {
        type: 'channel_message',
        channel: channelName,
        senderId: message.senderId,
        senderName: message.senderName,
        text: message.text,
      })

    if ((this.saveFailures.get(id) ?? 0) >= MAX_SAVE_FAILURES) {
      if (merged.passive) {
        this.logger.error(
          `[${channelName}] Passive evaluation paused: session ${session.id} cannot be saved`,
        )
        return 'failed'
      }
      await this.sendReply(
        session,
        channelName,
        merged,
        "This session can't be saved. New prompts are paused after 3 consecutive save failures. Please ask the operator to restore session storage.",
      )
      return 'failed'
    }

    await this.handoff.beforeRun(id, session, merged)
    if (processing.stopped) return stopped(session)
    processing.preparing = false
    return this.feedback.prompt(
      id,
      channelName,
      channel,
      merged,
      session,
      inputs,
      input,
      evaluated.length > 1 ? evaluated : undefined,
    )
  }

  async sendReply(
    session: VelaSession,
    channelName: string,
    msg: IncomingMessage,
    replyText: string,
  ): Promise<boolean> {
    const channel = this.channel(channelName)
    if (!replyText || !channel) return false
    const reply: OutgoingMessage = {
      routine: msg.routine,
      handoff: msg.handoff,
      topic: msg.topic,
      channelId: msg.channelId,
      recipientId: msg.senderId,
      text: replyText,
      ...(msg.replyToId ? { replyToId: msg.replyToId } : {}),
    }
    try {
      await channel.send(reply)
    } catch (error) {
      publishChannelEvent(session, {
        type: 'channel_error',
        channel: channelName,
        senderId: msg.senderId,
        error,
        aborted: false,
      })
      this.logger.error(`[${channelName}] Reply failed: ${errorMessage(error)}`)
      return false
    }
    publishChannelEvent(session, {
      type: 'channel_reply',
      channel: channelName,
      recipientId: msg.senderId,
      text: replyText,
    })
    return true
  }
}
