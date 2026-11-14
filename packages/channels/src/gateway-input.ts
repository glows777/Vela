import type { VelaLogger } from '@glows777/vela-core/extension-api'
import type { TopicAdmission } from './admission.ts'
import type { TopicCommands } from './commands.ts'
import type { ChannelDirectory } from './directory.ts'
import type { RunFeedback } from './feedback.ts'
import type { GatewayIdle } from './gateway-idle.ts'
import { errorMessage } from './log.ts'
import { channelSessionId } from './session-id.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'

/** Passive inputs waiting behind a run share one queue slot so their evaluation happens once. */
interface PassiveBatch {
  /** Directory admission is part of the queue's ordering and completes before evaluation. */
  readonly messages: { message: IncomingMessage; ready: Promise<boolean> }[]
  started: boolean
  next: Promise<void>
}

/** Serialized durable admission and per-logical-session input queues. */
export class GatewayInput {
  readonly admitting = new Map<string, Promise<void>>()
  /** The next message in a chat waits for the previous reply. */
  readonly queues = new Map<string, Promise<void>>()
  /** Group discussion queues into this run's slot instead of one slot per message. */
  private readonly batches = new Map<string, PassiveBatch>()

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
      msgs: IncomingMessage[],
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
    // Only discussion queued behind a working run is merged; a barrier or an
    // explicit message keeps its own slot, and idle input starts its own evaluation.
    const merge =
      msg.passive &&
      !msg.topic &&
      !incoming.blocked &&
      this.commands.controllable(id) !== undefined
    const batch = merge ? this.batches.get(id) : undefined
    if (batch && !batch.started && this.queues.get(id) === batch.next) {
      batch.messages.push({
        message: msg,
        ready: incoming.admitted.catch(async (error) => {
          await this.feedback.feedbackError(channelName, msg, error)
          return false
        }),
      })
      return { admitted: incoming.admitted, completed: batch.next }
    }
    const created: PassiveBatch | undefined = merge
      ? {
          messages: [
            { message: msg, ready: incoming.admitted.catch(() => false) },
          ],
          started: false,
          next: Promise.resolve(),
        }
      : undefined
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
        if (created) {
          created.started = true
          if (this.batches.get(id) === created) this.batches.delete(id)
        }
        const inputs = created
          ? (
              await Promise.all(created.messages.map((item) => item.ready))
            ).flatMap((accepted, index) =>
              accepted ? [created.messages[index]!.message] : [],
            )
          : [msg]
        if (inputs.length && !(await (await consumed)()))
          await this.process(id, channelName, inputs)
      })
      .catch((error) =>
        this.logger.error(
          `[${channelName}] Failed to handle message: ${errorMessage(error)}`,
        ),
      )
    if (created) created.next = next
    this.queues.set(id, next)
    if (created) this.batches.set(id, created)
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
