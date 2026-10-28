import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const formatUsd = (amount: number): string => `$${amount.toFixed(4)}`

import type {
  StepUsage,
  UsageTotals,
  VelaSession,
} from '@glows777/vela-core/extension-api'
import type { ChannelDirectory } from './directory.ts'

const count = z.number().finite().nonnegative()
const rowSchema = z.object({
  key: z.string(),
  chatId: z.string(),
  model: z.string(),
  ts: count,
  tokens: z.object({
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
  }),
  cost: count.optional(),
})
type UsageRow = z.infer<typeof rowSchema>

/** Channel-owned requests only; append rows, never rewrite totals or session history. */
export class ChannelUsage {
  private readonly path?: string
  private rows: UsageRow[] = []
  private loaded = false
  private subscribed = new WeakSet<VelaSession>()

  constructor(
    dataDir: string | undefined,
    private directory: ChannelDirectory,
  ) {
    this.path = dataDir ? join(dataDir, 'channels', 'usage.jsonl') : undefined
  }

  load(): void {
    if (this.loaded) return
    if (this.path) {
      let text: string
      try {
        text = readFileSync(this.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        text = ''
      }
      this.rows = text.split('\n').flatMap((line, index) => {
        if (!line.trim()) return []
        try {
          return [rowSchema.parse(JSON.parse(line))]
        } catch (error) {
          throw new Error(
            `Invalid channel usage ledger ${this.path}, line ${index + 1}`,
            { cause: error },
          )
        }
      })
    }
    this.loaded = true
  }

  track(key: string, chatId: string, session: VelaSession): void {
    if (this.subscribed.has(session)) return
    this.subscribed.add(session)
    let before: UsageTotals | undefined
    session.subscribe((event) => {
      if (event.type === 'usage') {
        this.append({
          key,
          chatId,
          model: event.modelId,
          ts: event.record?.ts ?? Date.now(),
          tokens: event.usage,
          cost: event.record?.cost,
        })
      } else if (event.type === 'compaction_start') {
        before = session.usage.totals
      } else if (event.type === 'compaction_end' && before) {
        const after = session.usage.totals
        const start = before
        before = undefined
        if (after.steps === start.steps) return
        // A priced subtotal alone cannot distinguish an unpriced summary from a free one.
        const summary = session.usage.lastRecord!
        const tokens: StepUsage = {
          inputTokens: after.inputTokens - start.inputTokens,
          outputTokens: after.outputTokens - start.outputTokens,
          cacheReadTokens: after.cacheReadTokens - start.cacheReadTokens,
          cacheWriteTokens: after.cacheWriteTokens - start.cacheWriteTokens,
        }
        this.append({
          key,
          chatId,
          model: summary.model,
          ts: summary.ts,
          tokens,
          cost:
            summary.cost === undefined
              ? undefined
              : (after.cost ?? 0) - (start.cost ?? 0),
        })
      }
    })
  }

  private append(row: UsageRow): void {
    this.load()
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      appendFileSync(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    }
    this.rows.push(row)
  }

  status(
    key: string,
    channel: string,
    chatId: string,
    session: VelaSession,
  ): string {
    this.load()
    const info = session.modelInfo
    const usage = session.usage
    const topic = this.rows.filter((row) => row.key === key)
    const group = this.rows.filter(
      (row) =>
        row.chatId === chatId &&
        this.directory.get(row.key)?.channel === channel,
    )
    const first = this.rows[0]
    return [
      `Model: ${info.ref}`,
      `Context: ${usage.tokens} estimated tokens (${usage.percent}% of ${info.contextWindow ?? session.usage.contextWindow})`,
      this.total('Topic', topic),
      this.total('Group', group),
      first
        ? `Recorded since ${new Date(first.ts).toISOString()}. Earlier usage is not included.`
        : 'No usage recorded yet. Earlier usage is not included.',
      this.path
        ? 'Counts completed usage reports; an interrupted request without a usage report is not included.'
        : 'In-memory accounting only; totals are not saved across process restarts.',
    ].join('\n')
  }

  private total(label: string, rows: UsageRow[]): string {
    let tokens = 0,
      cost = 0,
      priced = 0
    for (const row of rows) {
      tokens +=
        row.tokens.inputTokens +
        row.tokens.outputTokens +
        row.tokens.cacheReadTokens +
        row.tokens.cacheWriteTokens
      if (row.cost !== undefined) {
        cost += row.cost
        priced++
      }
    }
    const missing = rows.length - priced
    const price = priced
      ? `${missing ? 'known cost' : 'cost'} ${formatUsd(cost)}`
      : 'cost unavailable'
    return `${label}: ${tokens} tokens; ${price}${missing ? ` (${missing} unpriced request${missing === 1 ? '' : 's'})` : ''}`
  }
}
