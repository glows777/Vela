import type { VelaLogger } from '@glows777/vela-core/extension-api'
import type { TopicAdmission } from './admission.ts'
import type { TopicCommands } from './commands.ts'
import type { ChannelDirectory } from './directory.ts'
import type { RunFeedback } from './feedback.ts'
import type { GatewayIdle } from './gateway-idle.ts'
import { errorMessage } from './log.ts'
import { channelSessionId } from './session-id.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

/** Serialized durable admission and per-logical-session input queues. */
export class GatewayInput {
  readonly admitting = new Map<string, Promise<void>>()
  /** The next message in a chat waits for the previous reply. */
  readonly queues = new Map<string, Promise<void>>()

  constructor(
    private directory: ChannelDirectory,
    private admission: TopicAdmission,
    private commands: TopicCommands,
    private feedback: RunFeedback,
    private idle: GatewayIdle,
    private channel: (name: string) => ChannelDefinition | undefined,
    private process: (
      id: string,
      name: string,
      msg: IncomingMessage,
    ) => Promise<void>,
    private changed: (id: string) => void,
    private stopped: () => boolean,
    private logger: VelaLogger,
  ) {}

  enqueue(
    channelName: string,
    msg: IncomingMessage,
  ): { admitted: Promise<boolean>; completed: Promise<void> } {
    const id = channelSessionId(channelName, msg.channelId, msg.topic?.rootId)
    this.idle.cancel(id)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const incoming = this.commands.receive(
      id,
      channelName,
      msg,
      () => this.admit(id, channelName, msg),
      previous,
    )
    if (incoming.command) {
      if (incoming.blocks) {
        this.queues.set(id, incoming.command)
        this.release(id, incoming.command)
      } else void incoming.command.then(() => this.idle.schedule(id))
      return { admitted: incoming.admitted, completed: incoming.command }
    }
    const available = incoming.available
    // Keep live controls immediate. Steer waits for its admitted ID before submitting input.
    const ready = available.then(() => {})
    void ready.catch(() => {})
    const receive =
      !incoming.blocked &&
      (!msg.requireExistingSession ||
        this.directory.get(id) ||
        this.feedback.runs.has(id))
        ? this.feedback.receive(id, channelName, msg, ready)
        : undefined
    const consumed = available
      .then((accepted) =>
        accepted
          ? (receive ?? this.feedback.receive(id, channelName, msg))
          : () => Promise.resolve(true),
      )
      .catch(async (error) => {
        await this.feedback.feedbackError(channelName, msg, error)
        return () => Promise.resolve(true)
      })
    const next = previous
      .then(async () => {
        this.logger.debug(
          `[${channelName}] input ${msg.replyToId ?? '-'} dequeued at=${new Date().toISOString()}`,
        )
        if (!(await (await consumed)()))
          await this.process(id, channelName, msg)
      })
      .catch((error) =>
        this.logger.error(
          `[${channelName}] Failed to handle message: ${errorMessage(error)}`,
        ),
      )
    this.queues.set(id, next)
    this.release(id, next)
    return { admitted: incoming.admitted, completed: next }
  }

  private admit(
    id: string,
    channelName: string,
    msg: IncomingMessage,
  ): Promise<boolean> {
    const admitted = (this.admitting.get(id) ?? this.directory.load()).then(
      async () => {
        if (this.stopped()) return false
        const channel = this.channel(channelName)
        if (msg.requireExistingSession && !this.directory.get(id)) {
          await this.idle.closing.get(id)
          if (!(await this.admission.admit(id, channel, msg))) return false
        }
        await this.directory.admit(id, channelName, msg)
        this.changed(id)
        this.logger.debug(
          `[${channelName}] input ${msg.replyToId ?? '-'} admitted at=${new Date().toISOString()}`,
        )
        return true
      },
    )
    const admission = admitted.then(
      () => {},
      () => {},
    )
    this.admitting.set(id, admission)
    void admission.then(() => {
      if (this.admitting.get(id) === admission) this.admitting.delete(id)
    })
    return admitted
  }

  release(id: string, next: Promise<void>): void {
    void next.then(() => {
      if (this.queues.get(id) !== next) return
      this.queues.delete(id)
      this.changed(id)
      this.idle.schedule(id)
    })
  }
}
