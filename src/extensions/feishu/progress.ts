import type { VelaEvent } from '../../agent/events.ts'
import type {
  ChannelOutcome,
  ChannelRunFeedback,
} from '../../channels/types.ts'
import type { FeishuCard } from './cards.ts'
import type { FeishuTransport } from './transport.ts'

/** One ordered writer for one shared card. Event listeners never await network I/O. */
export class FeishuProgress implements ChannelRunFeedback {
  private rows = new Map<string, string>()
  private stage = 'Working'
  private pending = false
  private closed = false
  private failure?: unknown
  private writing: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private lastWrite = Date.now()
  private heartbeat: ReturnType<typeof setInterval>
  constructor(
    private transport: FeishuTransport,
    private messageId: string,
    private card: FeishuCard,
    private report: (error: unknown) => Promise<void>,
  ) {
    this.heartbeat = setInterval(() => this.schedule(), 15_000)
  }

  event(event: VelaEvent): void {
    if (this.closed || this.failure) return
    if (
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update' ||
      event.type === 'tool_execution_end'
    ) {
      const state =
        event.type === 'tool_execution_end'
          ? event.isError
            ? 'Failed'
            : 'Finished'
          : 'Running'
      this.stage = state === 'Running' ? 'Using tools' : 'Working'
      this.rows.set(
        event.toolCallId,
        `${state}: ${event.toolName.slice(0, 80).replace(/[<>[\]`*_]/g, '')}`,
      )
      if (this.rows.size > 8) this.rows.delete(this.rows.keys().next().value!)
      this.schedule()
    } else if (
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta'
    ) {
      this.stage = 'Preparing a response'
      this.schedule()
    }
  }

  private snapshot(terminal = false): FeishuCard {
    return {
      ...this.card,
      config: { update_multi: true },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: `${this.stage}\n${[...this.rows.values()].join('\n')}`,
          },
          ...(terminal ? [] : this.card.body.elements.slice(1)),
        ],
      },
    }
  }

  private schedule(): void {
    if (this.closed || this.failure) return
    this.pending = true
    if (this.timer) return
    this.timer = setTimeout(
      () => {
        this.writing = this.writing
          .then(async () => {
            if (!this.pending || this.closed || this.failure) return
            this.pending = false
            this.lastWrite = Date.now()
            try {
              await this.transport.patchCard(this.messageId, this.snapshot())
            } catch (error) {
              this.failure = error
              clearInterval(this.heartbeat)
              await this.report(error)
            }
          })
          .finally(() => {
            this.timer = undefined
            if (this.pending) this.schedule()
          })
      },
      Math.max(0, 250 - (Date.now() - this.lastWrite)),
    )
  }

  async finish(outcome: ChannelOutcome): Promise<void> {
    this.closed = true
    clearInterval(this.heartbeat)
    clearTimeout(this.timer)
    await this.writing
    if (this.failure) throw this.failure
    this.stage = { done: 'Finished', failed: 'Failed', stopped: 'Stopped' }[
      outcome
    ]
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 250 - (Date.now() - this.lastWrite))),
    )
    await this.transport.patchCard(this.messageId, this.snapshot(true))
  }
}
