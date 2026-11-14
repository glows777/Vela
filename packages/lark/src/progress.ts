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

interface TodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done'
}

const TODO_MARKERS: Record<TodoItem['status'], string> = {
  pending: '☐',
  in_progress: '◐',
  done: '☑',
}

/** Keep the shared card short; the full list stays in the session history. */
const TODO_LIMIT = 10

function todoItems(details: unknown): TodoItem[] | undefined {
  if (!details || typeof details !== 'object') return undefined
  const items = (details as { items?: unknown }).items
  if (!Array.isArray(items)) return undefined
  const valid = items.every(
    (item): item is TodoItem =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as TodoItem).text === 'string' &&
      ['pending', 'in_progress', 'done'].includes((item as TodoItem).status),
  )
  return valid ? items : undefined
}

function todoLines(items: readonly TodoItem[]): string[] {
  const shown = items.slice(0, TODO_LIMIT)
  const lines = shown.map(
    (item) => `${TODO_MARKERS[item.status]} ${plain(item.text, 80)}`,
  )
  if (items.length > shown.length)
    lines.push(`… and ${items.length - shown.length} more`)
  return lines
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

/**
 * Retry delays after a failed live card write. A transient network error must not freeze the card for
 * the rest of the run; four retries bound a permanently dead card to five attempts.
 */
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000] as const

/**
 * The answer is already delivered when the final card is written, and the outcome reaction waits for
 * it: the final write gets two retries rather than the live schedule, so `DONE` is not held for long.
 */
const FINAL_RETRY_DELAYS = [1_000, 2_000] as const

/** One ordered writer for one shared card. Event listeners never await network I/O. */
export class LarkProgress {
  private rows = new Map<string, { state: string; label: string }>()
  private todos?: TodoItem[]
  private readonly startedAt = Date.now()
  private stage = 'Working'
  private pending = false
  private closed = false
  /** Set only after the retry budget is spent; a later write cannot revive a dead card. */
  private failure?: unknown
  private failures = 0
  private retryAt = 0
  private readonly retryDelays: readonly number[]
  private readonly finalRetryDelays: readonly number[]
  private writing: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private lastWrite = Date.now()
  private heartbeat: ReturnType<typeof setInterval>
  constructor(
    private transport: LarkTransport,
    private messageId: string,
    private card: LarkCard,
    private report: (error: unknown) => Promise<void>,
    options: {
      initialTodos?: readonly TodoItem[]
      /** Delay before each live retry; the production schedule bounds a dead card to five attempts. */
      retryDelays?: readonly number[]
      /** Delay before each final retry; the answer is already delivered by then. */
      finalRetryDelays?: readonly number[]
    } = {},
  ) {
    if (options.initialTodos?.length) this.todos = [...options.initialTodos]
    this.retryDelays = options.retryDelays ?? RETRY_DELAYS
    this.finalRetryDelays = options.finalRetryDelays ?? FINAL_RETRY_DELAYS
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
      if (
        event.type === 'tool_execution_end' &&
        !event.isError &&
        event.toolName === 'todo'
      ) {
        const items = todoItems(event.details)
        if (items) this.todos = items.length ? items : undefined
      }
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
            content: `${this.stage} · ${elapsed}\n${this.todos ? `${todoLines(this.todos).join('\n')}\n` : ''}${[...this.rows.values()].map(({ state, label }) => `${state}: ${label}`).join('\n')}`,
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
              this.failures = 0
              this.retryAt = 0
            } catch (error) {
              this.failures++
              // One report per run: a retry that fails again must not repeat the message.
              if (this.failures === 1) await this.report(error)
              const delay = this.retryDelays[this.failures - 1]
              if (delay === undefined) {
                this.failure = error
                clearInterval(this.heartbeat)
              } else {
                this.retryAt = Date.now() + delay
                // Re-arm even without a new event, so a quiet run still retries on schedule.
                this.pending = true
              }
            }
          })
          .finally(() => {
            this.timer = undefined
            if (this.pending) this.schedule()
          })
      },
      Math.max(
        0,
        250 - (Date.now() - this.lastWrite),
        this.retryAt - Date.now(),
      ),
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

  /**
   * Writes the terminal card with its own retry budget and throws when it stays unwritten. The caller
   * reports that failure as final, because the answer has already been delivered: it must not claim the
   * task is still running. A live failure reported earlier already covered this card, so nothing is
   * reported here.
   */
  async finish(outcome: Exclude<ChannelOutcome, 'silent'>): Promise<void> {
    await this.drain()
    if (this.failure) throw this.failure
    this.stage = { done: 'Finished', failed: 'Failed', stopped: 'Stopped' }[
      outcome
    ]
    this.lastWrite = Date.now()
    for (let attempt = 0; ; attempt++) {
      try {
        await this.transport.patchCard(this.messageId, this.snapshot(true))
        return
      } catch (error) {
        const delay = this.finalRetryDelays[attempt]
        if (delay === undefined) {
          this.failure = error
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
}

/**
 * Publishes the outcome reaction and then the final card. The reaction comes first: it does not depend
 * on the card, so a dead card cannot hold `DONE` / `CrossMark` back while its final write is retried.
 * A failure is thrown for the gateway, which reports it as a final presentation failure.
 */
export async function finishProgress(options: {
  transport: LarkTransport | undefined
  messageId: string | undefined
  reactionId: string | undefined
  progress: LarkProgress | undefined
  outcome: ChannelOutcome
}): Promise<void> {
  const { transport, messageId, reactionId, progress, outcome } = options
  let failure: unknown
  if (transport && messageId && reactionId) {
    try {
      await transport.removeReaction(messageId, reactionId)
      if (outcome !== 'silent')
        await transport.addReaction(
          messageId,
          outcome === 'done' ? 'DONE' : 'CrossMark',
        )
    } catch (error) {
      failure = error
    }
  }
  if (outcome !== 'silent') {
    try {
      await progress?.finish(outcome)
    } catch (error) {
      // The answer is already delivered: this must never read as a still-running task.
      failure ??= error
    }
  }
  if (failure) throw failure
}
