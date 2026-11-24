import { createSessionLocalExecutionEnv } from '../execution/local.ts'
import type { ExecutionEnv } from '../execution/types.ts'
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
  environment,
  resolveEnvironment,
  call,
  started,
  signal,
  maxResultChars,
  onPersistenceFailure,
}: {
  raw: unknown
  name: string
  results: ToolResultStore
  environment?: ExecutionEnv
  resolveEnvironment?: () => Promise<ExecutionEnv | undefined>
  call: CallRecord
  started: number
  signal?: AbortSignal
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
  let spillFailed = false
  let warning =
    '[The tool already ran, but its full output could not be saved. Do not automatically rerun it.]'
  let text = ''
  try {
    text =
      raw instanceof ToolExecutionResult
        ? raw.text
        : typeof raw === 'string'
          ? raw
          : (JSON.stringify(raw, null, 2) ?? String(raw))
    // Only what the model gets decides: a string is the text itself (its JSON escaping
    // doesn't count), and a ToolExecutionResult's value is structured data for the
    // history (e.g. edit's diff)
    if (
      !stored &&
      (text.length > maxChars ||
        (typeof value !== 'string' &&
          !(raw instanceof ToolExecutionResult) &&
          JSON.stringify(value)?.length > maxChars))
    ) {
      const full =
        raw instanceof ToolExecutionResult && raw.content
          ? text
          : typeof value === 'string'
            ? value
            : (JSON.stringify(value, null, 2) ?? String(value))
      const env =
        environment ??
        (await resolveEnvironment?.()) ??
        createSessionLocalExecutionEnv({
          cwd: process.cwd(),
          tempRoot: results.dir,
        })
      const temp = await env.createTempFile(
        { prefix: 'vela-result-', suffix: '.txt' },
        signal,
      )
      if (!temp.ok) spillFailed = true
      else {
        const written = await env.writeFile(temp.value, full, signal)
        if (!written.ok) {
          spillFailed = true
          // Cleanup is best effort; an incomplete file is never published.
          const removed = await env.remove(temp.value, { force: true }).then(
            (result) => result.ok,
            () => false,
          )
          if (!removed)
            warning += ' The incomplete output file could not be removed.'
        } else {
          const cut = truncateByLines(text, maxChars)
          stored = new StoredToolResult(
            temp.value,
            results.indexPath,
            Buffer.byteLength(full),
            cut.preview,
          )
        }
      }
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
          : {
              output: spillFailed
                ? `${truncateByLines(text, maxChars).preview}\n\n${warning}`
                : (value ?? null),
            }),
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
      : 'no full output file was saved'
    const status =
      execution.exitCode === undefined ? '' : ` exitCode=${execution.exitCode}`
    const recovery = stored
      ? 'The output path was allocated after the call began and was not pre-recorded.'
      : ''
    const failure = new Error(
      `Tool ${name} ran, but saving its result failed. The result is unconfirmed; do not rerun it automatically. callId=${call.callId}${status}; ${location}. ${recovery} Verify it is complete; do not treat the call as successful because of it. ${error}`,
    )
    onPersistenceFailure(failure)
    throw failure
  }
  const cut =
    stored && !(raw instanceof StoredToolResult)
      ? truncateByLines(text, maxChars)
      : undefined
  const output: string | ToolContent =
    raw instanceof ToolExecutionResult && raw.content
      ? stored || spillFailed
        ? previewToolContent(
            raw.content,
            maxChars,
            stored
              ? truncationNote(stored, cut ?? truncateByLines(text, maxChars))
              : warning,
          )
        : raw.content
      : stored
        ? raw instanceof StoredToolResult
          ? stored.preview
          : `${stored.preview}\n\n${truncationNote(stored, cut!)}`
        : spillFailed
          ? `${truncateByLines(text, maxChars).preview}\n\n${warning}`
          : text
  return { output, execution, stored }
}

function previewToolContent(
  content: ToolContent,
  maxChars: number,
  note: string,
): ToolContent {
  // Share the text budget without moving captions away from their images.
  const captions = content.filter((part) => part.type === 'text').length
  const captionChars = Math.floor(maxChars / Math.max(1, captions))
  return [
    ...content.map((part) =>
      part.type === 'text'
        ? {
            ...part,
            text: truncateByLines(part.text, captionChars, true).preview,
          }
        : part,
    ),
    {
      type: 'text',
      text: note,
    },
  ]
}

interface LineTruncation {
  preview: string
  shownLines: number
  totalLines: number
  partialLine: boolean
}

function truncationNote(stored: StoredToolResult, cut: LineTruncation): string {
  if (cut.partialLine)
    return `[Showing part of line 1 of ${cut.totalLines} lines. Full output: ${stored.path}; use read with offset=1, column=${cut.preview.length} to read the rest.]`
  return `[Showing lines 1-${cut.shownLines} of ${cut.totalLines}. Full output: ${stored.path}; use read with offset=${cut.shownLines + 1} to read the rest.]`
}

function sliceUtf16Safe(text: string, limit: number): string {
  let end = limit
  if (
    end > 0 &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff
  )
    end--
  return text.slice(0, end)
}

function truncateByLines(
  text: string,
  maxChars: number,
  compact = false,
): LineTruncation {
  const lines = text.split('\n')
  const totalLines = lines.length
  if (text.length <= maxChars)
    return {
      preview: text,
      shownLines: totalLines,
      totalLines,
      partialLine: false,
    }

  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const added = out.length > 0 ? line.length + 1 : line.length
    if (used + added > maxChars) break
    out.push(line)
    used += added
  }
  if (out.length === 0) {
    const budget = compact ? Math.max(0, maxChars - 1) : maxChars
    const head = sliceUtf16Safe(text, budget)
    return {
      preview: compact && maxChars > 0 ? `${head}…` : head,
      shownLines: 1,
      totalLines,
      partialLine: true,
    }
  }
  return {
    preview: out.join('\n'),
    shownLines: out.length,
    totalLines,
    partialLine: false,
  }
}
