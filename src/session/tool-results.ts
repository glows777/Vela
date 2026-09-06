import { mkdir, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { ModelMessage, ToolResultPart } from 'ai'
import {
  type ExecutionMetadata,
  type LegacyResultRecord,
  ToolHistoryStore,
} from './tool-history'

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
  const value = output.value
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

  constructor(dir = '.sessions/default/tool-results') {
    this.dir = resolve(dir)
    this.historyId = crypto.randomUUID()
    this.history = this.makeHistory(this.historyId)
  }

  private makeHistory(id: string): ToolHistoryStore {
    if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))
      throw new Error('无效的工具历史标识')
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
      throw new Error('工具历史缺失，无法安全恢复；未覆盖原 checkpoint')
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
      `\n只有查询摘要之后的新调用时才使用实时日志：${this.history.path}（seq > ${this.historyViewSequence}）。查询摘要前的操作一律使用上面的固定快照。`
    )
  }

  private outputPath(callId: string = crypto.randomUUID()): string {
    if (
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(callId)
    )
      throw new Error('无效的工具调用标识')
    return join(this.dir, `${callId}.txt`)
  }

  async createFile(callId?: string) {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      const path = this.outputPath(callId)
      const file = await open(path, 'wx', 0o600)
      return { path, file }
    } catch (error) {
      throw new Error(`保存工具结果失败，未生成可读取引用: ${error}`)
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
    await Bun.file(path).slice(0, 1).arrayBuffer()
    const reference = new StoredToolResult(
      path,
      this.indexPath,
      Bun.file(path).size,
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
      throw new Error(`保存工具结果失败，未生成可读取引用: ${error}`)
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
        note: '旧上下文归档；原始调用参数/执行时间未在调用时记录，不据此重放。',
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
        await Bun.file(stored.path).slice(0, 1).arrayBuffer()
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
            note: '旧结果引用；调用参数/执行时间未在调用时记录，不据此重放。',
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
