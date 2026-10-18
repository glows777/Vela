import { errorMessage, type VelaLogger } from '../logger.ts'
import type { ModelMessage } from '../messages.ts'
import type { VelaSession } from '../vela-session.ts'
import { channelSessionId } from './session-id.ts'
import type {
  ChannelAcknowledgement,
  ChannelDefinition,
  ChannelOutcome,
  ChannelRunFeedback,
  IncomingMessage,
} from './types.ts'

/** An admitted input keeps its acknowledgement across asynchronous task handoff. */
export class MessageFeedback {
  readonly ready: Promise<void>
  private acknowledgement?: ChannelAcknowledgement
  private failed = false
  constructor(
    channel: ChannelDefinition,
    message: IncomingMessage,
    private report: (error: unknown) => Promise<void>,
  ) {
    this.ready = Promise.resolve()
      .then(() => channel.acknowledge?.(message))
      .then((value) => {
        this.acknowledgement = value || undefined
      })
      .catch(async (error) => {
        this.failed = true
        await this.report(error)
      })
  }

  fail(): void {
    this.failed = true
  }

  async finish(outcome: ChannelOutcome): Promise<void> {
    await this.ready
    try {
      await this.acknowledgement?.finish(this.failed ? 'failed' : outcome)
    } catch (error) {
      await this.report(error)
    }
  }
}

interface ChannelRun {
  session: VelaSession
  trigger: IncomingMessage
  lifetime: AbortController
  stopped: boolean
  inputs: MessageFeedback[]
  handedOff?: boolean
  steering?: Promise<void>
}

interface FeedbackOptions {
  stopped: () => boolean
  channel: (name: string) => ChannelDefinition | undefined
  find: (id: string) => VelaSession | undefined
  reply: (
    session: VelaSession,
    channel: string,
    message: IncomingMessage,
    text: string,
  ) => Promise<boolean>
  logger: VelaLogger
}

/** Coordinates admitted inputs and controls without owning the gateway's queues. */
export class RunFeedback {
  readonly active = new Set<VelaSession>()
  readonly runs = new Map<string, ChannelRun>()
  readonly acknowledgements = new WeakMap<IncomingMessage, MessageFeedback[]>()

  constructor(private options: FeedbackOptions) {}

  receive(
    id: string,
    channelName: string,
    msg: IncomingMessage,
  ): () => Promise<boolean> {
    const channel = this.options.channel(channelName)
    const run = this.runs.get(id)
    if (
      channel &&
      (!msg.requireExistingSession || (run && this.runIsLive(run)))
    )
      this.acknowledge(channel, msg)
    let consumed = false
    let chosen = false
    let decision: Promise<void> | undefined
    let card: Promise<void> | undefined
    const apply = (action: 'steer' | 'stop'): Promise<void> => {
      if (!run || !channel) return Promise.resolve()
      return this.applyRunChoice(channel, msg, run, action)
        .then((handled) => {
          consumed = handled
        })
        .catch(async (error) => {
          const aborted =
            this.options.stopped() || run.stopped || isAbort(error)
          if (!aborted) await this.feedbackError(channelName, msg, error)
          else
            run.session.emit({
              type: 'channel_error',
              channel: channelName,
              senderId: msg.senderId,
              error,
              aborted: true,
            })
          await Promise.all(
            (this.acknowledgements.get(msg) ?? []).map(async (input) => {
              if (!aborted) input.fail()
              if (!run.inputs.includes(input))
                await input.finish(aborted ? 'stopped' : 'failed')
            }),
          )
          consumed = true
        })
        .finally(() => {
          if (run.stopped) consumed = true
        })
    }
    if (run && this.runIsLive(run) && channel) {
      if (msg.topic) {
        decision = (run.steering ?? Promise.resolve()).then(() =>
          apply('steer'),
        )
        run.steering = decision
      } else if (channel.showRunControls) {
        card = channel
          .showRunControls(msg, {
            signal: run.lifetime.signal,
            choose: (action) => {
              if (chosen || !this.runIsLive(run)) return false
              chosen = true
              if (action !== 'queue') decision = apply(action)
              return true
            },
          })
          .catch((error) =>
            this.options.logger.warn(
              `[${channelName}] Failed to send run controls: ${errorMessage(error)}`,
            ),
          )
      }
    }
    return async () => {
      await card
      await decision
      return consumed
    }
  }

  runIsLive(run: ChannelRun): boolean {
    return (
      !this.options.stopped() &&
      !run.stopped &&
      !run.lifetime.signal.aborted &&
      this.runs.get(run.session.id) === run &&
      run.session.isRunning
    )
  }

  /** Apply one reserved card choice; true consumes its gateway input. */
  private async applyRunChoice(
    channel: ChannelDefinition,
    msg: IncomingMessage,
    run: ChannelRun,
    action: 'steer' | 'stop',
  ): Promise<boolean> {
    if (action === 'stop') {
      run.stopped = true
      run.lifetime.abort()
      // These inputs belong to the cancelled run; the gateway's default queue stays intact.
      run.session.clearQueue()
      await run.session.abort()
      if (!msg.topic)
        await this.options.reply(
          run.session,
          channel.name,
          msg,
          'Stopped the current run.',
        )
      await Promise.all(
        (this.acknowledgements.get(msg) ?? [])
          .filter((input) => !run.inputs.includes(input))
          .map((input) => input.finish('stopped')),
      )
      return true
    }
    const inputs = this.acknowledge(channel, msg)
    await Promise.all(inputs.map((input) => input.ready))
    if (msg.topic) msg.isNewTopic = false
    const prepared = channel.prepareMessage
      ? await channel.prepareMessage(msg, run.trigger)
      : msg
    // History/name lookups can outlast the run. Leave the default queue intact.
    if (!prepared) {
      await Promise.all(inputs.map((input) => input.finish('failed')))
      return true
    }
    if (!this.runIsLive(run)) {
      if (!run.stopped) return false
      await Promise.all(inputs.map((input) => input.finish('stopped')))
      return true
    }
    run.inputs.push(...inputs)
    run.session.emit({
      type: 'channel_message',
      channel: channel.name,
      senderId: prepared.senderId,
      senderName: prepared.senderName,
      text: prepared.text,
    })
    await run.session.prompt(prepared.text, {
      source: 'channel',
      streamingBehavior: 'steer',
      images: prepared.images,
      signal: run.lifetime.signal,
    })
    return true
  }

  acknowledge(
    channel: ChannelDefinition,
    msg: IncomingMessage,
  ): MessageFeedback[] {
    let inputs = this.acknowledgements.get(msg)
    if (!inputs) {
      inputs = [
        new MessageFeedback(channel, msg, (error) =>
          this.feedbackError(channel.name, msg, error),
        ),
      ]
      this.acknowledgements.set(msg, inputs)
    }
    return inputs
  }

  async feedbackError(
    channelName: string,
    msg: IncomingMessage,
    error: unknown,
  ): Promise<void> {
    const session = this.options.find(
      channelSessionId(channelName, msg.channelId, msg.topic?.rootId),
    )
    session?.emit({
      type: 'channel_error',
      channel: channelName,
      senderId: msg.senderId,
      error,
      aborted: false,
    })
    this.options.logger.error(
      `[${channelName}] Feedback failed: ${errorMessage(error)}`,
    )
    try {
      await this.options.channel(channelName)?.send({
        ...msg,
        recipientId: msg.senderId,
        text: `Couldn't update task feedback: ${errorMessage(error)}. Check the bot's permissions and connection.`,
      })
    } catch (sendError) {
      this.options.logger.error(
        `[${channelName}] Could not deliver feedback error: ${errorMessage(sendError)}`,
      )
    }
  }

  async prompt(
    id: string,
    channelName: string,
    channel: ChannelDefinition | undefined,
    msg: IncomingMessage,
    session: VelaSession,
    inputs: MessageFeedback[],
  ): Promise<ChannelOutcome | undefined> {
    this.active.add(session)
    const run: ChannelRun = {
      session,
      trigger: msg,
      lifetime: new AbortController(),
      stopped: false,
      inputs,
    }
    this.runs.set(id, run)
    let feedback: ChannelRunFeedback | undefined
    let feedbackErrorReported = false
    const report = async (error: unknown) => {
      if (feedbackErrorReported) return
      feedbackErrorReported = true
      await this.feedbackError(channelName, msg, error)
    }
    const unsubscribe = session.subscribe((event) => {
      feedback?.event(event)
      if (event.type === 'agent_settled') run.lifetime.abort()
    })
    let outcome: ChannelOutcome = 'done'
    let answer = ''
    let failureReported = false
    // An input handler can handle the message without a run: then there is no new answer to send
    const previous = session.messages.at(-1)
    try {
      if (msg.topic && channel?.showTopicControls) {
        feedback = await channel
          .showTopicControls(msg, {
            signal: run.lifetime.signal,
            error: report,
            stop: () => {
              if (!this.runIsLive(run)) return false
              void this.applyRunChoice(channel, msg, run, 'stop').catch(
                (error) =>
                  session.emit({
                    type: 'channel_error',
                    channel: channelName,
                    senderId: msg.senderId,
                    error,
                    aborted: this.options.stopped() || isAbort(error),
                  }),
              )
              return true
            },
          })
          .catch(async (error) => {
            failureReported = true
            await this.options.reply(
              session,
              channelName,
              msg,
              `Couldn't show the topic Stop control: ${errorMessage(error)}. Check the bot's send permission and retry.`,
            )
            throw error
          })
          .then((value) => value || undefined)
      }
      await session.prompt(msg.text, { source: 'channel', images: msg.images })
      if (session.messages.at(-1) !== previous)
        answer = lastAssistantText(session.messages)
    } catch (error) {
      outcome =
        run.stopped || this.options.stopped() || isAbort(error)
          ? 'stopped'
          : 'failed'
      if (outcome === 'failed' && !failureReported)
        answer = `Task failed: ${errorMessage(error)}`
      session.emit({
        type: 'channel_error',
        channel: channelName,
        senderId: msg.senderId,
        error,
        aborted: outcome === 'stopped',
      })
    } finally {
      unsubscribe()
      run.lifetime.abort()
      await run.steering
      try {
        await feedback?.finish(outcome)
      } catch (error) {
        await report(error)
      }
      this.runs.delete(id)
      this.active.delete(session)
    }
    if (run.handedOff) return
    if (outcome === 'stopped')
      answer = msg.topic ? 'Stopped the current run.' : ''
    if (
      answer &&
      !(await this.options.reply(session, channelName, msg, answer))
    ) {
      outcome = 'failed'
      try {
        await feedback?.finish(outcome)
      } catch (error) {
        await report(error)
      }
    }
    return outcome
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** Text of the last assistant message (this turn's reply). */
function lastAssistantText(messages: ModelMessage[]): string {
  const last = messages[messages.length - 1]
  if (last?.role !== 'assistant') return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
}
