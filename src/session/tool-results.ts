import { mkdir, open, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ModelMessage, ToolResultPart } from 'ai'
import {
  type ExecutionMetadata,
  type LegacyResultRecord,
  ToolHistoryStore,
} from './tool-history.ts'

export class StoredToolResult {
  readonly kind = 'vela-tool-result' as const
  callId?: string
  historySeq?: number
  execution?: ExecutionMetadata
  constructor(
    readonly path: string,
    readonly indexPath: string,
    readonly bytes: number,
    readonly preview: string,
    readonly read = 'Only a preview is shown. Use read_file with path, offset (1-based line), limit and column (0-based UTF-16 offset within a long line) to read more.',
  ) {}
}

export function getStoredResult(
  output: ToolResultPart['output'],
): StoredToolResult | undefined {
  if (
    output.type !== 'json' ||
    !output.value ||
    typeof output.value !== 'object' ||
    Array.isArray(output.value)
  )
    return
  // Array.isArray doesn't narrow readonly arrays; arrays are already excluded here
  const value = output.value as Readonly<Record<string, unknown>>
  if (
    value.kind === 'vela-tool-result' &&
    typeof value.path === 'string' &&
    typeof value.indexPath === 'string' &&
    typeof value.bytes === 'number' &&
    typeof value.preview === 'string' &&
    typeof value.read === 'string'
  ) {
    return value as unknown as StoredToolResult
  }
}

export function storedResultOutput(
  result: StoredToolResult,
): ToolResultPart['output'] {
  return { type: 'json', value: JSON.parse(JSON.stringify(result)) }
}

export class ToolResultStore {
  readonly dir: string
  history: ToolHistoryStore
  historyId: string
  historyViewSequence?: number
  // Keep existing references/readers compatible; this now points at the call history.
  get indexPath(): string {
    return this.history.path
  }

  constructor(dir = 'sessions/default/tool-results') {
    this.dir = resolve(dir)
    this.historyId = crypto.randomUUID()
    this.history = this.makeHistory(this.historyId)
  }

  private makeHistory(id: string): ToolHistoryStore {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))
      throw new Error('Invalid tool history id')
    return new ToolHistoryStore(
      join(dirname(this.dir), id, 'tool-history.jsonl'),
    )
  }

  async resumeHistory(
    id: string,
    minimumSequence = 0,
    viewSequence?: number,
  ): Promise<void> {
    const history = this.makeHistory(id)
    await history.load()
    if (history.throughSequence < minimumSequence)
      throw new Error('Tool history is missing, so the session cannot be safely restored; the original checkpoint was not overwritten')
    if (viewSequence !== undefined)
      await history.snapshot(undefined, viewSequence)
    this.historyId = id
    this.history = history
    this.historyViewSequence = viewSequence
  }

  readingGuide(): string {
    if (this.historyViewSequence === undefined)
      return this.history.readingGuide()
    const guide = this.history.readingGuide(
      this.historyViewSequence,
      this.history.snapshotPath(this.historyViewSequence),
    )
    return (
      guide +
      `\nUse the live log only to query new calls made after the summary: ${this.history.path} (seq > ${this.historyViewSequence}). For anything before the summary, always use the fixed snapshot above.`
    )
  }

  private outputPath(callId: string = crypto.randomUUID()): string {
    if (
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(callId)
    )
      throw new Error('Invalid tool call id')
    return join(this.dir, `${callId}.txt`)
  }

  async createFile(callId?: string) {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      const path = this.outputPath(callId)
      const file = await open(path, 'wx', 0o600)
      return { path, file }
    } catch (error) {
      throw new Error(`Failed to save tool result; no readable reference was created: ${error}`)
    }
  }

  async reference(
    path: string,
    toolName: string,
    preview: string,
    toolCallId?: string,
    execution?: ExecutionMetadata,
    callId?: string,
  ): Promise<StoredToolResult> {
    const { size } = await stat(path)
    const reference = new StoredToolResult(
      path,
      this.indexPath,
      size,
      preview,
    )
    reference.execution = execution
    reference.callId = callId
    return reference
  }

  async save(
    text: string,
    toolName: string,
    preview: string,
    toolCallId?: string,
    callId?: string,
  ): Promise<StoredToolResult> {
    return this.savePlanned(
      this.plan(text, preview, callId),
      text,
      toolName,
      toolCallId,
      callId,
    )
  }

  plan(text: string, preview: string, callId?: string): StoredToolResult {
    return new StoredToolResult(
      this.outputPath(callId),
      this.indexPath,
      Buffer.byteLength(text),
      preview,
    )
  }

  async savePlanned(
    result: StoredToolResult,
    text: string,
    toolName: string,
    toolCallId?: string,
    callId?: string,
  ): Promise<StoredToolResult> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      const file = await open(result.path, 'wx', 0o600)
      try {
        await file.writeFile(text, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
    } catch (error) {
      throw new Error(`Failed to save tool result; no readable reference was created: ${error}`)
    }
    const recorded = toolCallId
      ? await this.history.completed(toolCallId)
      : undefined
    if (
      !callId &&
      !recorded &&
      !this.history.hasLegacy(toolCallId, result.path)
    ) {
      await this.history.append<LegacyResultRecord>({
        type: 'legacy_result',
        toolCallId,
        toolName,
        outputPath: result.path,
        bytes: result.bytes,
        note: 'Archived from old context; the original call arguments/execution time were not recorded at call time, so do not replay from this.',
      })
    }
    return this.reference(
      result.path,
      toolName,
      result.preview,
      toolCallId,
      undefined,
      callId ?? recorded?.callId,
    )
  }
}

function outputText(output: ToolResultPart['output']): string {
  const stored = getStoredResult(output)
  if (stored) return stored.preview
  if (output.type === 'text' || output.type === 'error-text')
    return output.value
  // Preserve structured/media content as JSON rather than dropping non-text blocks.
  return JSON.stringify('value' in output ? output.value : output)
}

export async function archiveToolResults(
  messages: ModelMessage[],
  store: ToolResultStore,
): Promise<void> {
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue
      const stored = getStoredResult(part.output)
      if (stored) {
        await stat(stored.path)
        if (
          !(await store.history.completed(part.toolCallId)) &&
          !store.history.hasLegacy(part.toolCallId, stored.path)
        ) {
          await store.history.append<LegacyResultRecord>({
            type: 'legacy_result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            outputPath: stored.path,
            bytes: stored.bytes,
            note: 'Old result reference; the call arguments/execution time were not recorded at call time, so do not replay from this.',
          })
        }
      } else if (await store.history.completed(part.toolCallId)) {
        // Original small output is already in the immutable tool_result record.
        continue
      } else {
        await store.save(
          outputText(part.output),
          part.toolName,
          '',
          part.toolCallId,
        )
      }
    }
  }
}
