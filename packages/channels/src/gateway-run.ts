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
    msg: IncomingMessage,
    recovered = false,
  ): Promise<void> {
    const processing = this.commands.begin(id)
    this.changed(id, { type: 'started', runId: processing.runId })
    let outcome: ChannelOutcome | undefined = 'failed'
    try {
      outcome = await this.processRun(
        id,
        channelName,
        msg,
        processing,
        recovered,
      )
    } catch (error) {
      await this.feedback.feedbackError(channelName, msg, error)
    } finally {
      this.commands.end(id, processing)
      this.changed(id, {
        type: 'finished',
        runId: processing.runId,
        outcome: outcome ?? 'done',
      })
      if (outcome)
        await Promise.all(
          (this.feedback.acknowledgements.get(msg) ?? []).map((input) =>
            input.finish(outcome!),
          ),
        )
    }
  }

  private async processRun(
    id: string,
    channelName: string,
    msg: IncomingMessage,
    processing: { stopped: boolean; preparing: boolean },
    recovered = false,
  ): Promise<ChannelOutcome | undefined> {
    if (this.stopped()) return 'stopped'
    this.logger.debug(
      `[${channelName}] input ${msg.replyToId ?? '-'} preparing at=${new Date().toISOString()}`,
    )
    await this.idle.closing.get(id)
    const channel = this.channel(channelName)
    if (msg.externalEvent) {
      const record = this.directory.get(id)
      if (!record || channel?.canRecover?.(msg, record.chatKind) === false)
        return 'done'
    }
    const topicSession =
      msg.topic || msg.passive
        ? await this.admission.admit(id, channel, msg)
        : undefined
    if (msg.topic && !topicSession) return 'failed'
    if (
      msg.passive &&
      msg.replyToId &&
      topicSession &&
      this.recovery.hasInput(topicSession, msg.replyToId)
    ) {
      await this.directory.forget(id, [msg.replyToId])
      return 'done'
    }
    const inputs = channel
      ? this.feedback.acknowledge(channel, msg, !recovered)
      : []
    await Promise.all(inputs.map((input) => input.ready))
    this.logger.debug(
      `[${channelName}] input ${msg.replyToId ?? '-'} acknowledged at=${new Date().toISOString()}`,
    )
    const input = msg
    const task = msg.text
    const prepared =
      !processing.stopped && !recovered && channel?.prepareMessage
        ? await channel.prepareMessage(msg)
        : msg
    this.logger.debug(
      `[${channelName}] input ${msg.replyToId ?? '-'} prepared at=${new Date().toISOString()}`,
    )
    const stopped = async (
      session = topicSession ?? this.sessions.open(id, channelName, msg),
    ): Promise<ChannelOutcome> => {
      await this.directory.forget(id, msg.replyToId ? [msg.replyToId] : [])
      await this.directory.finish(id, 'stopped')
      await this.sendReply(
        session,
        channelName,
        msg,
        'Stopped the current run.',
      )
      return 'stopped'
    }
    if (processing.stopped) return stopped()
    if (!prepared) {
      // Undefined means the adapter handled the input without a model prompt.
      await this.directory.forget(id, msg.replyToId ? [msg.replyToId] : [])
      return 'failed'
    }
    if (this.stopped()) return 'failed'
    msg = prepared
    const session = topicSession ?? this.sessions.open(id, channelName, msg)
    this.admission.observe(id, channelName, msg, task)
    this.usage.track(id, msg.channelId, session)
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
      msg.routine &&
      !recovered &&
      !(await this.routines.shouldRun(msg, session))
    )
      return 'done'
    publishChannelEvent(session, {
      type: 'channel_message',
      channel: channelName,
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
    })

    if ((this.saveFailures.get(id) ?? 0) >= MAX_SAVE_FAILURES) {
      if (msg.passive) {
        this.logger.error(
          `[${channelName}] Passive evaluation paused: session ${session.id} cannot be saved`,
        )
        return 'failed'
      }
      await this.sendReply(
        session,
        channelName,
        msg,
        "This session can't be saved. New prompts are paused after 3 consecutive save failures. Please ask the operator to restore session storage.",
      )
      return 'failed'
    }

    await this.handoff.beforeRun(id, session, msg)
    if (processing.stopped) return stopped(session)
    processing.preparing = false
    return this.feedback.prompt(
      id,
      channelName,
      channel,
      msg,
      session,
      inputs,
      input,
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
