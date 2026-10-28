import type { ToolContent } from '../messages.ts'
import type { CallRecord, ResultRecord } from '../session/tool-history.ts'
import {
  StoredToolResult,
  type ToolResultStore,
} from '../session/tool-results.ts'
import { ToolExecutionResult } from './types.ts'

const DEFAULT_MAX_RESULT_CHARS = 50 * 1024 // Beyond this, the full result is saved and only a preview returned

/** Persist a completed call and build the model-facing preview before post hooks. */
export async function prepareCallResult({
  raw,
  name,
  results,
  call,
  started,
  signal,
  toolCallId,
  maxResultChars,
  onPersistenceFailure,
}: {
  raw: unknown
  name: string
  results: ToolResultStore
  call: CallRecord
  started: number
  signal?: AbortSignal
  toolCallId?: string
  maxResultChars?: number
  onPersistenceFailure: (error: Error) => void
}) {
  const history = results.history
  // Persist native results before formatting/truncating the model response.
  const value = raw instanceof ToolExecutionResult ? raw.value : raw
  const execution =
    raw instanceof ToolExecutionResult || raw instanceof StoredToolResult
      ? (raw.execution ?? {})
      : {}
  const maxChars = maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  let stored = raw instanceof StoredToolResult ? raw : undefined
  let text: string
  try {
    text =
      raw instanceof ToolExecutionResult
        ? raw.text
        : typeof raw === 'string'
          ? raw
          : (JSON.stringify(raw, null, 2) ?? String(raw))
    // Only what the model gets decides: a string is the text itself (its JSON escaping
    // doesn't count), and a ToolExecutionResult's value is structured data for the
    // history (e.g. edit_file's diff)
    if (
      !stored &&
      (text.length > maxChars ||
        (typeof value !== 'string' &&
          !(raw instanceof ToolExecutionResult) &&
          JSON.stringify(value)?.length > maxChars))
    ) {
      stored = await results.save(
        raw instanceof ToolExecutionResult && raw.content
          ? text
          : typeof value === 'string'
            ? value
            : (JSON.stringify(value, null, 2) ?? String(value)),
        name,
        truncateResult(text, maxChars),
        toolCallId,
        call.callId,
      )
    }
    const record = await history.append<ResultRecord>({
      type: 'tool_result',
      callId: call.callId,
      status: signal?.aborted
        ? 'cancelled'
        : execution.isError
          ? 'failed'
          : 'completed',
      durationMs: performance.now() - started,
      ...execution,
      ...(stored && raw instanceof ToolExecutionResult && raw.content
        ? {
            output: value ?? null,
            modelTextPath: stored.path,
            modelTextBytes: stored.bytes,
          }
        : stored
          ? {
              outputPath: stored.path,
              bytes: stored.bytes,
              format:
                raw instanceof StoredToolResult ||
                typeof value === 'string' ||
                (raw instanceof ToolExecutionResult &&
                  raw.content !== undefined)
                  ? ('text' as const)
                  : ('json' as const),
            }
          : { output: value ?? null }),
    })
    if (stored) {
      stored.callId = call.callId
      stored.historySeq = record.seq
      stored.execution = execution
    }
  } catch (error) {
    // Do not invent a terminal result when the result could not be recorded.
    const location = stored
      ? raw instanceof ToolExecutionResult && raw.content
        ? `full model text saved at: ${stored.path}; native result details remain unconfirmed`
        : `full output saved at: ${stored.path}`
      : `planned output path: ${call.plannedOutputPath} (may be missing or incomplete)`
    const status =
      execution.exitCode === undefined ? '' : ` exitCode=${execution.exitCode}`
    const failure = new Error(
      `Tool ${name} ran, but saving its result failed. The result is unconfirmed; do not rerun it automatically. callId=${call.callId}${status}; ${location}. The output location is also recorded in tool_call.plannedOutputPath; verify it is complete, and do not treat the call as successful because of it. ${error}`,
    )
    onPersistenceFailure(failure)
    throw failure
  }
  const output: string | ToolContent =
    raw instanceof ToolExecutionResult && raw.content
      ? stored
        ? previewToolContent(raw.content, maxChars, stored)
        : raw.content
      : stored
        ? raw instanceof StoredToolResult
          ? stored.preview
          : `${stored.preview}\n\n${truncationNote(stored)}`
        : text
  return { output, execution, stored }
}

function previewToolContent(
  content: ToolContent,
  maxChars: number,
  stored: StoredToolResult,
): ToolContent {
  // Share the text budget without moving captions away from their images.
  const captions = content.filter((part) => part.type === 'text').length
  const captionChars = Math.floor(maxChars / Math.max(1, captions))
  return [
    ...content.map((part) =>
      part.type === 'text'
        ? { ...part, text: truncateResult(part.text, captionChars, true) }
        : part,
    ),
    {
      type: 'text',
      text: truncationNote(stored),
    },
  ]
}

function truncationNote(stored: StoredToolResult): string {
  return `[Full output: ${stored.path}; use read_file with offset to read the rest.]`
}

function truncateResult(text: string, maxChars: number, compact = false) {
  if (text.length <= maxChars) return text

  const previewChars = compact ? Math.max(0, maxChars - 1) : maxChars
  let headSize = previewChars
  if (
    text.charCodeAt(headSize - 1) >= 0xd800 &&
    text.charCodeAt(headSize - 1) <= 0xdbff
  )
    headSize--
  const head = text.slice(0, headSize)
  return compact && maxChars > 0 ? `${head}…` : head
}
