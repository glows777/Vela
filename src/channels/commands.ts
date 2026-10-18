import type { VelaSession } from '../vela-session.ts'
import type { TopicAdmission } from './admission.ts'
import type { ChannelDirectory } from './directory.ts'
import type { RunFeedback } from './feedback.ts'
import type { ChannelDefinition, IncomingMessage } from './types.ts'
import type { ChannelUsage } from './usage.ts'

type TopicCommand = 'stop' | 'restart' | 'status'

/** Match only a complete normalized topic message, before history or sender decoration. */
function topicCommand(msg: IncomingMessage): TopicCommand | undefined {
  if (!msg.topic) return
  const text = msg.text.trim()
  if (text === '!stop') return 'stop'
  if (text === '!restart') return 'restart'
  if (text === '!status') return 'status'
}

interface CommandOptions {
  directory: ChannelDirectory
  feedback: RunFeedback
  admission: TopicAdmission
  usage: ChannelUsage
  stopped: () => boolean
  channel: (name: string) => ChannelDefinition | undefined
  find: (key: string) => VelaSession | undefined
  closing: (key: string) => Promise<void> | undefined
}

/** Topic command barriers and preparation cancellation; the gateway owns normal message queues. */
export class TopicCommands {
  private commands = new Map<string, Promise<void>>()
  private processing = new Map<string, { stopped: boolean }>()
  readonly active = new Set<Promise<void>>()

  constructor(private options: CommandOptions) {}

  begin(key: string): { stopped: boolean } {
    const state = { stopped: false }
    this.processing.set(key, state)
    return state
  }

  end(key: string, state: { stopped: boolean }): void {
    if (this.processing.get(key) === state) this.processing.delete(key)
  }

  receive(
    key: string,
    name: string,
    msg: IncomingMessage,
    admit: () => Promise<boolean>,
    previous: Promise<void>,
  ) {
    const command = topicCommand(msg)
    const barrier = this.commands.get(key)
    // Only Stop/Restart cancel preparation; Status must leave the live run alone.
    const processing =
      !barrier && command && command !== 'status' && this.processing.get(key)
    if (processing && !this.options.stopped()) processing.stopped = true
    const stopping = processing ? this.options.feedback.stop(key) : undefined
    void stopping?.catch(() => {})
    const admitted = admit()
    if (command) {
      const next = this.handleCommand(
        key,
        name,
        msg,
        command,
        admitted,
        previous,
        barrier,
        stopping,
      )
      const blocks = command !== 'status'
      this.commands.set(key, next)
      this.active.add(next)
      void next.then(() => {
        this.active.delete(next)
        if (this.commands.get(key) === next) this.commands.delete(key)
      })
      return { command: next, blocks, blocked: !!barrier, available: admitted }
    }
    // Later messages must not steer the generation being archived.
    const available = barrier
      ? admitted.then(async (accepted) => {
          await barrier
          return accepted
        })
      : admitted
    return { blocked: !!barrier, available }
  }

  private async handleCommand(
    key: string,
    name: string,
    msg: IncomingMessage,
    command: TopicCommand,
    admitted: Promise<boolean>,
    previous: Promise<void>,
    barrier?: Promise<void>,
    stopping?: Promise<boolean>,
  ): Promise<void> {
    const o = this.options
    try {
      if (!(await admitted)) return
      await barrier
      if (o.stopped()) return
      let stopped = false
      if (command !== 'status') {
        const processing = this.processing.get(key)
        if (processing) processing.stopped = true
        stopped = (await (stopping ?? o.feedback.stop(key))) || !!processing
        await previous
      }
      await o.closing(key)
      if (o.stopped()) return
      const channel = o.channel(name)
      if (!channel) return
      const session =
        command === 'status'
          ? (o.find(key) ?? (await o.admission.admit(key, channel, msg)))
          : o.find(key)
      await this.finish(command, key, channel, msg, stopped, session)
    } catch (error) {
      await o.feedback.feedbackError(name, msg, error)
    }
  }

  /** Stop/Restart arrive after the old run's normal delivery and finish path has drained. */
  private async finish(
    command: TopicCommand,
    key: string,
    channel: ChannelDefinition,
    msg: IncomingMessage,
    stopped: boolean,
    session?: VelaSession,
  ): Promise<void> {
    const { directory, feedback, usage } = this.options
    const inputs = feedback.acknowledge(channel, msg)
    let outcome: 'done' | 'failed' = 'failed'
    try {
      await Promise.all(inputs.map((input) => input.ready))
      let text = stopped ? '' : 'No run is currently active.'
      if (command === 'restart') {
        // Save before closing: a save failure must retain the old live session.
        await session?.save()
        await session?.close()
        directory.observe(key, channel.name, msg)
        await directory.restart(key)
        text = 'Restarted with a fresh session'
      } else if (command === 'status' && session) {
        text = usage.status(key, channel.name, msg.channelId, session)
      }
      if (text) await channel.send({ ...msg, recipientId: msg.senderId, text })
      await directory.forget(key, msg.replyToId ? [msg.replyToId] : [])
      outcome = 'done'
    } finally {
      await Promise.all(inputs.map((input) => input.finish(outcome)))
    }
  }
}
