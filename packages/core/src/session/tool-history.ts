import { createReadStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ToolResultOutput } from '../messages.ts'

export interface ExecutionMetadata {
  error?: string
  exitCode?: number
  signal?: string | null
  isError?: boolean
  timedOut?: boolean
  /** The executable could not start, so this tool cannot run in the current session. */
  toolUnavailable?: boolean
  /** The background job this call started, whose result arrives on its own. */
  backgroundTaskId?: string
  /** The job was a running call the user moved to the background instead of one the call declared. */
  backgroundedByUser?: boolean
  /**
   * The foreground budget that expired and moved this call to the background, in milliseconds: how a
   * timed-out call is told apart from a declared one or one the user moved.
   */
  timedOutAfterMs?: number
}

export interface CallRecord {
  version: 1
  type: 'tool_call'
  seq: number
  timestamp: string
  callId: string
  toolCallId: string | null
  toolName: string
  input: unknown
  /** Reserved before execution; the file may be absent or incomplete without a result record. */
  replay?: 'safe' | 'unsafe'
  location?: { environment: string; cwd: string }
  interruption?: number
  plannedOutputPath?: string
}

export interface ResponseRecord {
  version: 1
  type: 'tool_response'
  seq: number
  timestamp: string
  callId: string
  output: ToolResultOutput
}

export interface ResultRecord extends ExecutionMetadata {
  modelOutput?: ToolResultOutput
  version: 1
  type: 'tool_result'
  seq: number
  timestamp: string
  callId: string
  status: 'completed' | 'failed' | 'cancelled' | 'rejected'
  durationMs: number
  output?: unknown
  outputPath?: string
  /** Separate full caption for multimodal results; native details remain in output. */
  modelTextPath?: string
  modelTextBytes?: number
  format?: 'text' | 'json'
  bytes?: number
  error?: string
}

export interface LegacyResultRecord {
  version: 1
  type: 'legacy_result'
  seq: number
  timestamp: string
  toolCallId?: string
  toolName: string
  outputPath: string
  bytes: number
  note: string
}

export type HistoryRecord =
  | CallRecord
  | ResultRecord
  | LegacyResultRecord
  | ResponseRecord
type NewRecord<T> = T extends HistoryRecord
  ? Omit<T, 'version' | 'seq' | 'timestamp'>
  : never

/** One writer per live session. Append failures poison this writer: do not run more tools. */
export class ToolHistoryStore {
  readonly path: string
  private queue: Promise<unknown> = Promise.resolve()
  private loaded = false
  private sequence = 0
  private byteLength = 0
  private readonly byteOffsets = new Map<number, number>()
  private failure: Error | undefined
  private readonly calls = new Map<string, CallRecord>()
  private readonly results = new Map<string, ResultRecord>()
  private readonly legacy = new Set<string>()

  constructor(path: string) {
    this.path = resolve(path)
  }

  get throughSequence(): number {
    return this.sequence
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure
  }

  async load(): Promise<void> {
    if (this.loaded) return
    if ((await fileSize(this.path)) !== undefined) {
      const consume = (line: string) => {
        this.byteLength += Buffer.byteLength(line) + 1
        if (!line.trim()) return
        // Never append onto an unparseable/torn record or silently discard evidence.
        const record = JSON.parse(line) as HistoryRecord
        if (
          record.version !== 1 ||
          !Number.isSafeInteger(record.seq) ||
          record.seq <= this.sequence
        )
          throw new Error(
            'Tool history has a corrupt format or order; keeping the original file and stopping writes',
          )
        this.remember(record)
        this.byteOffsets.set(record.seq, this.byteLength)
      }
      const decoder = new TextDecoder()
      let pending = ''
      for await (const bytes of createReadStream(this.path)) {
        pending += decoder.decode(bytes, { stream: true })
        let end = pending.indexOf('\n')
        while (end >= 0) {
          consume(pending.slice(0, end))
          pending = pending.slice(end + 1)
          end = pending.indexOf('\n')
        }
      }
      pending += decoder.decode()
      if (pending)
        throw new Error(
          'Tool history ends with an incomplete line; keeping the original file and stopping writes',
        )
    }
    this.loaded = true
  }

  private remember(record: HistoryRecord): void {
    this.sequence = record.seq
    if (record.type === 'tool_call') this.calls.set(record.callId, record)
    if (record.type === 'tool_result') this.results.set(record.callId, record)
    if (record.type === 'tool_response') {
      const result = this.results.get(record.callId)
      if (!result) throw new Error('Tool response without a terminal result')
      result.modelOutput = record.output
    }
    if (record.type === 'legacy_result')
      this.legacy.add(JSON.stringify([record.toolCallId, record.outputPath]))
  }

  append<T extends HistoryRecord>(event: NewRecord<T>): Promise<T> {
    const task = this.queue
      .then(async () => {
        this.assertHealthy()
        await this.load()
        const record = {
          ...event,
          version: 1,
          seq: this.sequence + 1,
          timestamp: new Date().toISOString(),
        } as unknown as T
        const line = `${JSON.stringify(record)}\n`
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        const file = await open(this.path, 'a', 0o600)
        try {
          await file.writeFile(line)
          await file.sync()
        } finally {
          await file.close()
        }
        this.remember(JSON.parse(line) as HistoryRecord)
        this.byteLength += Buffer.byteLength(line)
        this.byteOffsets.set(record.seq, this.byteLength)
        return record
      })
      .catch((error: unknown) => {
        this.failure = new Error(
          `Failed to save tool call record; stopping further tool execution. Do not rerun calls that already ran. ${error}`,
        )
        throw this.failure
      })
    this.queue = task.catch(() => {})
    return task
  }

  async begin(
    toolName: string,
    toolCallId: string | undefined,
    input: unknown,
    recovery: Pick<CallRecord, 'replay' | 'location' | 'interruption'> = {},
  ): Promise<CallRecord> {
    const callId = crypto.randomUUID()
    return this.append<CallRecord>({
      type: 'tool_call',
      callId,
      toolCallId: toolCallId ?? null,
      toolName,
      input,
      ...recovery,
    })
  }

  async legacyUnfinished(): Promise<CallRecord[]> {
    await this.queue
    this.assertHealthy()
    await this.load()
    return [...this.calls.values()].filter(
      (call) => call.replay === undefined && !this.results.has(call.callId),
    )
  }

  async attempts(
    toolCallId: string,
  ): Promise<{ call: CallRecord; result?: ResultRecord }[]> {
    await this.queue
    this.assertHealthy()
    await this.load()
    return [...this.calls.values()]
      .filter((call) => call.toolCallId === toolCallId)
      .map((call) => ({ call, result: this.results.get(call.callId) }))
  }

  async completed(toolCallId: string): Promise<ResultRecord | undefined> {
    await this.queue
    await this.load()
    const matching = [...this.calls.values()].filter(
      (call) => call.toolCallId === toolCallId,
    )
    return matching.length === 1
      ? this.results.get(matching[0]!.callId)
      : undefined
  }

  hasAttempt(toolCallId: string): boolean {
    return [...this.calls.values()].some(
      (call) => call.toolCallId === toolCallId,
    )
  }

  hasLegacy(toolCallId: string | undefined, path: string): boolean {
    return this.legacy.has(JSON.stringify([toolCallId, path]))
  }

  snapshotPath(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence < 0)
      throw new Error('Invalid history snapshot boundary')
    return join(dirname(this.path), 'snapshots', `through-${sequence}.jsonl`)
  }

  async snapshot(
    abortSignal?: AbortSignal,
    through?: number,
  ): Promise<{ path: string; sequence: number }> {
    const task = this.queue.then(async () => {
      abortSignal?.throwIfAborted()
      this.assertHealthy()
      await this.load()
      const sequence = through ?? this.sequence
      const path = this.snapshotPath(sequence)
      const end = sequence === 0 ? 0 : this.byteOffsets.get(sequence)
      if (end === undefined)
        throw new Error('History snapshot boundary does not exist')
      const existing = await fileSize(path)
      if (existing !== undefined) {
        if (existing !== end)
          throw new Error(
            'History snapshot is corrupt; the existing file was not overwritten',
          )
        return { path, sequence }
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${crypto.randomUUID()}.tmp`
      try {
        const file = await open(temporary, 'wx', 0o600)
        try {
          if (end > 0)
            for await (const bytes of createReadStream(this.path, {
              end: end - 1,
            })) {
              abortSignal?.throwIfAborted()
              await file.writeFile(bytes)
            }
          abortSignal?.throwIfAborted()
          await file.chmod(0o400)
          await file.sync()
        } finally {
          await file.close()
        }
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
      return { path, sequence }
    })
    this.queue = task.catch(() => {})
    return task
  }
}

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
