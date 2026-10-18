import { errorMessage, type VelaLogger } from '../logger.ts'
import type { ModelMessage } from '../messages.ts'
import type { VelaSession } from '../vela-session.ts'
import type { ChannelDirectory } from './directory.ts'
import type { ChannelRecovery } from './recovery.ts'
import { channelSessionId } from './session-id.ts'
import type {
  ChannelDefinition,
  ChannelFeedbackUpdate,
  ChannelOutcome,
  ChannelRunFeedback,
  IncomingMessage,
} from './types.ts'

/** An admitted input keeps its acknowledgement across asynchronous task handoff. */
export class MessageFeedback {
  readonly ready: Promise<void>
  private feedback?: ChannelRunFeedback
  private finished?: Promise<void>
  private startPresentation?: () => Promise<void>
  private failed = false
  constructor(
    channel: ChannelDefinition,
    readonly message: IncomingMessage,
    private report: (error: unknown) => Promise<void>,
    acknowledge = true,
  ) {
    this.ready = Promise.resolve()
      .then(() => channel.startRun?.(message, { acknowledge }))
      .then((value) => {
        this.feedback = value || undefined
      })
      .catch(async (error) => {
        await this.report(error)
        // A failed initial reaction must not remove the run's Stop control.
        // Create presentation only; never retry the acknowledgement.
        this.startPresentation = async () => {
          if (!acknowledge) throw error
          this.feedback =
            (await channel.startRun?.(message, { acknowledge: false })) ||
            undefined
        }
      })
  }

  fail(): void {
    this.failed = true
  }

  event(update: ChannelFeedbackUpdate): void | Promise<void> {
    if (this.startPresentation) {
      const start = this.startPresentation
      this.startPresentation = undefined
      return start().then(() => this.event(update))
    }
    return this.feedback?.event(update)
  }

  finish(outcome: ChannelOutcome): Promise<void> {
    this.finished ??= this.complete(outcome)
    return this.finished
  }

  private async complete(outcome: ChannelOutcome): Promise<void> {
    await this.ready
    try {
      await this.feedback?.finish(this.failed ? 'failed' : outcome)
    } catch (error) {
      await this.report(error)
    }
  }
}

interface ChannelRun {
  key: string
  session: VelaSession
  trigger: IncomingMessage
  lifetime: AbortController
  stopped: boolean
  inputs: MessageFeedback[]
  handedOff?: boolean
  steering?: Promise<void>
}

interface FeedbackOptions {
  directory: ChannelDirectory
  recovery: ChannelRecovery
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
    admitted: Promise<void> = Promise.resolve(),
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
      const choice =
        action === 'stop'
          ? this.applyRunChoice(channel, msg, run, action)
          : admitted.then(() => this.applyRunChoice(channel, msg, run, action))
      return choice
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
      } else if (channel.startRun) {
        const input = this.acknowledge(channel, msg)[0]!
        card = input.ready
          .then(() =>
            input.event({
              type: 'controls',
              message: msg,
              signal: run.lifetime.signal,
              choose: (action) => {
                if (chosen || !this.runIsLive(run)) return false
                chosen = true
                if (action !== 'queue') decision = apply(action)
                return true
              },
              error: (error) => this.feedbackError(channelName, msg, error),
            }),
          )
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
      this.runs.get(run.key) === run &&
      run.session.isRunning
    )
  }

  /** The same cancellation boundary is used by topic commands and card controls. */
  async stop(id: string): Promise<boolean> {
    const run = this.runs.get(id)
    if (
      !run ||
      this.options.stopped() ||
      run.stopped ||
      run.lifetime.signal.aborted
    )
      return false
    await this.stopRun(run)
    return true
  }

  private async stopRun(run: ChannelRun): Promise<void> {
    run.stopped = true
    run.lifetime.abort()
    // These inputs belong to the cancelled run; the gateway's default queue stays intact.
    run.session.clearQueue()
    await Promise.all([
      run.session.abort(),
      this.options.directory.finish(run.key, 'stopped'),
    ])
  }

  /** Apply one reserved card choice; true consumes its gateway input. */
  private async applyRunChoice(
    channel: ChannelDefinition,
    msg: IncomingMessage,
    run: ChannelRun,
    action: 'steer' | 'stop',
  ): Promise<boolean> {
    if (action === 'stop') {
      await this.stopRun(run)
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
      await this.options.directory.forget(
        run.key,
        msg.replyToId ? [msg.replyToId] : [],
      )
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
    this.options.recovery.track(run.key, run.session, prepared)
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
    acknowledge = true,
  ): MessageFeedback[] {
    let inputs = this.acknowledgements.get(msg)
    if (!inputs) {
      inputs = [
        new MessageFeedback(
          channel,
          msg,
          (error) => this.feedbackError(channel.name, msg, error),
          acknowledge,
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
    input: IncomingMessage,
  ): Promise<ChannelOutcome | undefined> {
    this.active.add(session)
    const run: ChannelRun = {
      key: id,
      session,
      trigger: msg,
      lifetime: new AbortController(),
      stopped: false,
      inputs,
    }
    this.runs.set(id, run)
    let feedbackErrorReported = false
    const report = async (error: unknown) => {
      if (feedbackErrorReported) return
      feedbackErrorReported = true
      await this.feedbackError(channelName, msg, error)
    }
    const feedback = channel
      ? (inputs.find((item) => item.message === input) ??
        new MessageFeedback(channel, msg, report, false))
      : undefined
    await feedback?.ready
    const pending: Promise<void>[] = []
    const unsubscribe = session.subscribe((event) => {
      try {
        const update = feedback?.event({ type: 'agent', event })
        if (update) pending.push(Promise.resolve(update).catch(report))
      } catch (error) {
        pending.push(report(error))
      }
      if (event.type === 'agent_settled') run.lifetime.abort()
    })
    let outcome: ChannelOutcome = 'done'
    let answer = ''
    let failureReported = false
    let promptStarted = false
    let executionFailed = false
    let interrupted = false
    // An input handler can handle the message without a run: then there is no new answer to send
    const previous = session.messages.at(-1)
    try {
      if (msg.topic && channel && feedback) {
        try {
          await feedback.event({
            type: 'controls',
            message: msg,
            signal: run.lifetime.signal,
            error: report,
            choose: (action) => {
              if (action !== 'stop' || !this.runIsLive(run)) return false
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
        } catch (error) {
          failureReported = true
          await this.options.reply(
            session,
            channelName,
            msg,
            `Couldn't show the topic Stop control: ${errorMessage(error)}. Check the bot's send permission and retry.`,
          )
          throw error
        }
      }
      if (run.stopped)
        throw new DOMException('Stopped before prompting', 'AbortError')
      await this.options.directory.begin(id, msg)
      if (run.stopped)
        throw new DOMException('Stopped before prompting', 'AbortError')
      this.options.recovery.track(id, session, msg)
      promptStarted = true
      await session.prompt(msg.text, { source: 'channel', images: msg.images })
      if (session.messages.at(-1) !== previous)
        answer = lastAssistantText(session.messages)
    } catch (error) {
      outcome =
        run.stopped || this.options.stopped() || isAbort(error)
          ? 'stopped'
          : 'failed'
      interrupted = this.options.stopped() && !run.stopped
      executionFailed = promptStarted && outcome === 'failed'
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
      await Promise.all(pending)
      this.runs.delete(id)
      this.active.delete(session)
    }
    await this.options.recovery.settled(session)
    if (run.handedOff) {
      await this.options.directory.finish(id, 'done')
      return
    }
    if (run.stopped) outcome = 'stopped'
    if (outcome === 'stopped')
      answer = msg.topic ? 'Stopped the current run.' : ''
    const delivered =
      !answer || (await this.options.reply(session, channelName, msg, answer))
    if (!delivered) outcome = 'failed'
    await feedback?.finish(outcome)
    // Shutdown is recoverable, including accepted steers not yet saved. A reported
    // execution failure is terminal; a failed delivery must remain recoverable.
    if (
      !interrupted &&
      (outcome !== 'failed' || (executionFailed && delivered))
    ) {
      await this.options.directory.forget(
        id,
        [msg, ...run.inputs.map((item) => item.message)].flatMap((item) =>
          item.replyToId ? [item.replyToId] : [],
        ),
      )
      await this.options.directory.finish(
        id,
        outcome === 'stopped' ? 'stopped' : 'done',
        outcome === 'done' && !!answer,
      )
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
