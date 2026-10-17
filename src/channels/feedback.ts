import type {
  ChannelAcknowledgement,
  ChannelDefinition,
  ChannelOutcome,
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
