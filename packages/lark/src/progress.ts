import type { ChannelOutcome } from '@glows777/vela-channels'
import type { VelaEvent } from '@glows777/vela-core/extension-api'
import type { LarkCard } from './cards.ts'
import type { LarkTransport } from './transport.ts'

function plain(value: string, limit: number): string {
  return value
    .replace(/[<>[\]`*_]/g, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
    .slice(0, limit)
}

function inputSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return ''
  const values = args as Record<string, unknown>
  const value = ['command', 'path', 'query', 'pattern']
    .map((key) => values[key])
    .find((item) => typeof item === 'string')
  if (typeof value !== 'string') return ''
  // Do not put credential-bearing inputs on a shared card, even in truncated form.
  if (
    /\b(password|passwd|secret|token|authorization|api[_-]?key|bearer)\b|\b[A-Za-z_]\w*=|:\/\/[^/\s]+@|(?:^|\s)(?:-u|--user)(?:\s|=)|\b(?:sk-|ghp_|github_pat_)/i.test(
      value,
    )
  )
    return ''
  return plain(value, 60)
}

/** One ordered writer for one shared card. Event listeners never await network I/O. */
export class LarkProgress {
  private rows = new Map<string, { state: string; label: string }>()
  private readonly startedAt = Date.now()
  private stage = 'Working'
  private pending = false
  private closed = false
  private failure?: unknown
  private writing: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private lastWrite = Date.now()
  private heartbeat: ReturnType<typeof setInterval>
  constructor(
    private transport: LarkTransport,
    private messageId: string,
    private card: LarkCard,
    private report: (error: unknown) => Promise<void>,
  ) {
    this.heartbeat = setInterval(() => this.schedule(), 15_000)
  }

  event(event: VelaEvent): void | Promise<void> {
    if (event.type === 'agent_settled') return this.drain()
    if (this.closed || this.failure) return
    if (
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update' ||
      event.type === 'tool_execution_end'
    ) {
      if (event.parentToolCallId) return
      const state =
        event.type === 'tool_execution_end'
          ? event.isError
            ? 'Failed'
            : 'Finished'
          : 'Running'
      this.stage = state === 'Running' ? 'Using tools' : 'Working'
      const summary =
        event.type === 'tool_execution_end' ? '' : inputSummary(event.args)
      const label =
        event.type === 'tool_execution_end'
          ? (this.rows.get(event.toolCallId)?.label ??
            plain(event.toolName, 80))
          : `${plain(event.toolName, 80)}${summary ? ` — ${summary}` : ''}`
      this.rows.set(event.toolCallId, { state, label })
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

  private snapshot(terminal = false): LarkCard {
    const seconds = Math.max(
      0,
      Math.floor((Date.now() - this.startedAt) / 1000),
    )
    const elapsed = `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    return {
      ...this.card,
      header: terminal
        ? { title: { tag: 'plain_text', content: this.stage } }
        : this.card.header,
      config: { update_multi: true },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: `${this.stage} · ${elapsed}\n${[...this.rows.values()].map(({ state, label }) => `${state}: ${label}`).join('\n')}`,
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

  private async drain(): Promise<void> {
    this.closed = true
    clearInterval(this.heartbeat)
    clearTimeout(this.timer)
    await this.writing
    // Reserve the terminal PATCH slot before the reply, so finish can publish immediately after delivery.
    const delay = Math.max(0, 250 - (Date.now() - this.lastWrite))
    if (!this.failure && delay)
      await new Promise((resolve) => setTimeout(resolve, delay))
  }

  async finish(outcome: Exclude<ChannelOutcome, 'silent'>): Promise<void> {
    await this.drain()
    if (this.failure) throw this.failure
    this.stage = { done: 'Finished', failed: 'Failed', stopped: 'Stopped' }[
      outcome
    ]
    this.lastWrite = Date.now()
    try {
      await this.transport.patchCard(this.messageId, this.snapshot(true))
    } catch (error) {
      this.failure = error
      throw error
    }
  }
}
