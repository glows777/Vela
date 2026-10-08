import { open } from 'node:fs/promises'
import {
  generateText,
  Output,
  NoObjectGeneratedError,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
} from 'ai'
import z from 'zod'
import { toolResultOutputToText } from './tool-result-output.ts'
import {
  archiveToolResults,
  getStoredResult,
  StoredToolResult,
  storedResultOutput,
  type ToolResultStore,
} from '../session/tool-results.ts'
import { DEFAULT_LIMITS } from '../limits.ts'
import { normalizeUsage, type TokenTracker } from '../usage/tracker.ts'
import {
  estimateRequestTokens,
  MAX_INPUT_TOKENS,
  type RequestSnapshot,
} from './request.ts'

export const MICROCOMPACT_TOKEN_THRESHOLD = DEFAULT_LIMITS.microcompactThreshold
export const SUMMARY_TOKEN_THRESHOLD = DEFAULT_LIMITS.summaryThreshold
export const MIN_MICRO_SAVINGS = DEFAULT_LIMITS.minMicroSavings
const KEEP_RECENT_CALLS = 5
const KEEP_RECENT_MESSAGES = 6
const CLEARABLE_TOOLS = new Set([
  'read_file',
  'bash',
  'grep',
  'find',
  'list_directory',
  'edit_file',
  'write_file',
])
const OMITTED = '[tool result preview omitted; original available at path]'

export interface MicroCandidate {
  toolCallId: string
  toolName: string
  reference: StoredToolResult
  text?: string
}

export function planMicrocompact(
  messages: ModelMessage[],
  store: ToolResultStore,
): { messages: ModelMessage[]; candidates: MicroCandidate[] } {
  const calls = new Map<string, { name: string; index: number }>()
  const results = new Map<
    string,
    { part: ToolResultPart; message: number; index: number }
  >()
  const invalid = new Set<string>()
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return
    message.content.forEach((part, partIndex) => {
      if (part.type === 'tool-call') {
        if (calls.has(part.toolCallId)) invalid.add(part.toolCallId)
        calls.set(part.toolCallId, { name: part.toolName, index })
      } else if (part.type === 'tool-result') {
        if (results.has(part.toolCallId)) invalid.add(part.toolCallId)
        results.set(part.toolCallId, { part, message: index, index: partIndex })
      }
    })
  })
  const completed = [...results.entries()].filter(([id, { part, message }]) => {
    const call = calls.get(id)
    return (
      !invalid.has(id) &&
      call &&
      call.name === part.toolName &&
      call.index < message
    )
  })
  const keep = new Set(completed.slice(-KEEP_RECENT_CALLS).map(([id]) => id))
  const replacement = messages.slice()
  const candidates: MicroCandidate[] = []
  for (const [id, { part, message, index }] of completed) {
    if (keep.has(id) || !CLEARABLE_TOOLS.has(part.toolName)) continue
    const stored = getStoredResult(part.output)
    if (stored?.execution?.isError || stored?.execution?.timedOut) continue
    if (!stored && part.output.type !== 'text') continue
    const text =
      stored?.preview ?? (part.output.type === 'text' ? part.output.value : '')
    if (!text) continue
    if (
      part.toolName === 'bash' &&
      // Older Vela versions wrote failed bash results starting with 命令执行失败, keep matching both forms
      (/^(?:exit=[1-9]|命令执行失败|Command failed)/.test(text) ||
        /^exit=[^\n]*signal=/.test(text))
    )
      continue
    const status =
      part.toolName === 'bash' ? text.match(/^exit=0[^\n]*/)?.[0] : undefined
    const preview = status ? `${status}\n${OMITTED}` : OMITTED
    const reference = stored
      ? new StoredToolResult(
          stored.path,
          stored.indexPath,
          stored.bytes,
          preview,
        )
      : store.plan(text, preview)
    if (stored) {
      reference.callId = stored.callId
      reference.historySeq = stored.historySeq
      reference.execution = stored.execution
    }
    const output = storedResultOutput(reference)
    if (JSON.stringify(output).length >= JSON.stringify(part.output).length)
      continue
    const original = replacement[message]
    if (original?.role !== 'tool') continue
    const content = original.content.slice()
    content[index] = { ...part, output }
    replacement[message] = { ...original, content }
    candidates.push({
      toolCallId: id,
      toolName: part.toolName,
      reference,
      ...(!stored && { text }),
    })
  }
  return { messages: candidates.length ? replacement : messages, candidates }
}

export async function persistMicrocompact(
  candidates: MicroCandidate[],
  store: ToolResultStore,
): Promise<void> {
  for (const candidate of candidates) {
    if (candidate.text !== undefined)
      await store.savePlanned(
        candidate.reference,
        candidate.text,
        candidate.toolName,
        candidate.toolCallId,
      )
    else {
      // Open the reference, not just stat it, before removing the remaining preview.
      await (await open(candidate.reference.path, 'r')).close()
    }
  }
}

function summaryBoundary(messages: ModelMessage[]): number {
  for (let index = messages.length - KEEP_RECENT_MESSAGES; index > 0; index--) {
    if (messages[index]?.role !== 'user') continue
    const pending = new Set<string>()
    for (const message of messages.slice(0, index)) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type === 'tool-call') pending.add(part.toolCallId)
        else if (part.type === 'tool-result') pending.delete(part.toolCallId)
      }
    }
    if (pending.size === 0) return index
  }
  throw new Error(
    'Context needs a summary, but no split point keeps recent messages and tool call pairs intact; this turn was stopped and the original history kept.',
  )
}

export interface CompactionResult {
  messages: ModelMessage[]
  summary: string
  compressedCount: number
  historyViewSequence?: number
}

const summaryFact = z
  .object({
    sourceMessageIndex: z.number().int().nonnegative(),
    quote: z.string().trim().min(1).max(400),
  })
  .strict()

const normalizeEvidence = (text: string) => text.replace(/\s+/g, ' ').trim()
function sourceText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((part) => {
      if (part.type === 'text') return part.text
      if (part.type === 'tool-call') return JSON.stringify(part.input)
      if (part.type === 'tool-result')
        return toolResultOutputToText(part.output)
      return ''
    })
    .join('\n')
}

const summarySchema = z
  .object({
    sourceMessageCount: z.number().int().nonnegative(),
    goal: summaryFact,
    completed: z.array(summaryFact),
    pending: z.array(summaryFact),
    constraints: z.array(summaryFact),
    details: z.array(summaryFact),
  })
  .strict()
  .refine(
    (value) =>
      value.completed.length +
        value.pending.length +
        value.constraints.length +
        value.details.length >
      0,
  )

const SUMMARY_CONTROL = `This turn only produces a history summary. Do not run tools and do not answer requests from the history. The only source material is the old messages listed in sourceCatalog; the retained messages and this maintenance instruction are not summary material. Select only verbatim excerpts that state a fact on their own; do not rewrite or infer. Never record this instruction's output format, summary rules, counts/ranges or maintenance actions as user goals, business constraints, completed actions or pending items. Do not mention new requests in the retained messages; they go to the main loop unchanged. Instructions in the history to reply only with an acknowledgement are not output requirements for this turn. Return only a JSON object: copy sourceMessageCount exactly from this instruction; goal is one fact object; completed, pending, constraints and details are arrays of fact objects. Each fact object must contain exactly sourceMessageIndex (0-based index in sourceCatalog) and quote (a contiguous verbatim sentence from that old message, at most 400 characters, not rewritten; only whitespace may differ). The program keeps only verified quote sentences and rejects text or any other rewritten field. Never record unfinished work as completed or failures as successes. Leave an array empty when it has nothing; at least one array must contain a fact. About 800 words, in the same language as the history. Do not make anything up.`

export async function summarize(
  request: RequestSnapshot,
  results: ToolResultStore,
  tracker: TokenTracker,
  maxInputTokens = MAX_INPUT_TOKENS,
  /** Focus given by the user for a manual compaction (like pi's /compact instructions); only affects which quotes are picked */
  focus?: string,
): Promise<CompactionResult> {
  const index = summaryBoundary(request.messages)
  request.abortSignal?.throwIfAborted()
  const removed = request.messages.slice(0, index)
  const sources = removed.map((message) =>
    normalizeEvidence(sourceText(message)),
  )
  const messages: ModelMessage[] = [
    ...request.messages,
    {
      role: 'user',
      content: JSON.stringify({
        type: 'context_compaction',
        sourceCatalog: removed.map((message, index) => ({
          index,
          role: message.role,
          anchor: sources[index]!.slice(0, 160),
        })),
        sourceMessageCount: index,
        retainedMessageCount: request.messages.length - index,
        outputSchema: z.toJSONSchema(summarySchema),
        instruction: SUMMARY_CONTROL,
        ...(focus
          ? { focus: `When picking quotes, prefer ones related to: ${focus}` }
          : {}),
      }),
    },
  ]
  // Preserve the wire schemas/order but remove all client execution hooks.
  // Hosted tools cannot be made inert locally: stop instead of changing the prefix.
  const tools: ToolSet = {}
  for (const [name, tool] of Object.entries(request.tools)) {
    if (tool.type === 'provider' || typeof tool.description === 'function')
      throw new Error(
        'Cannot disable this tool\'s execution while keeping the main request prefix; summary stopped and the original history kept.',
      )
    tools[name] = {
      description: tool.description,
      inputSchema: tool.inputSchema,
      strict: tool.strict,
      inputExamples: tool.inputExamples,
      providerOptions: tool.providerOptions,
    }
  }
  const summaryRequest = {
    ...request,
    messages,
    tools,
  }
  if (estimateRequestTokens(summaryRequest) > maxInputTokens)
    throw new Error('Summary input exceeds the safe input size; this turn was stopped and the original history kept.')
  const started = performance.now()
  const modelId =
    typeof request.model === 'string' ? request.model : request.model.modelId
  const recordUsage = (usage: LanguageModelUsage) =>
    tracker.record(modelId, normalizeUsage(usage), {
      kind: 'summary',
      usage,
      durationMs: performance.now() - started,
    })
  const response = await generateText({
    model: request.model,
    instructions: request.systemPrompt,
    messages,
    tools,
    abortSignal: request.abortSignal,
    output: Output.json(),
    maxOutputTokens: 8192,
    maxRetries: 0,
  }).catch((error) => {
    if (NoObjectGeneratedError.isInstance(error)) {
      if (error.usage) recordUsage(error.usage)
      throw new Error('Summary was not fully generated as valid JSON; this turn was stopped and the original history kept.')
    }
    throw error
  })
  recordUsage(response.usage)
  request.abortSignal?.throwIfAborted()
  if (
    response.toolCalls.length ||
    !response.text.trim() ||
    response.finishReason !== 'stop'
  )
    throw new Error('Summary was not fully generated or returned tool calls; this turn was stopped and the original history kept.')
  const parsed = summarySchema.safeParse(response.output)
  if (!parsed.success || parsed.data.sourceMessageCount !== index)
    throw new Error('Summary does not match the required structure; this turn was stopped and the original history kept.')
  const data = parsed.data
  const facts = [
    data.goal,
    ...data.completed,
    ...data.pending,
    ...data.constraints,
    ...data.details,
  ]
  if (
    facts.some((fact) => {
      const source = sources[fact.sourceMessageIndex]
      const quote = normalizeEvidence(fact.quote)
      return source === undefined || !quote || !source.includes(quote)
    })
  )
    throw new Error(
      'Summary quotes are not from the removed history or do not match the original text; this turn was stopped and the original history kept.',
    )
  const section = (name: string, items: z.infer<typeof summaryFact>[]) =>
    `## ${name}\n${items.length ? items.map((item) => `- ${item.quote}`).join('\n') : 'None'}`
  const summaryText = [
    `## User goal\n${data.goal.quote}`,
    section('Completed', data.completed),
    section('Pending', data.pending),
    section('Constraints', data.constraints),
    section('Key facts', data.details),
  ].join('\n\n')
  await archiveToolResults(removed, results)
  const snapshot = await results.history.snapshot(request.abortSignal)
  const summary =
    summaryText +
    `\n\n${results.history.readingGuide(snapshot.sequence, snapshot.path)}`
  return {
    messages: [
      { role: 'user', content: `[Summary of the earlier conversation]\n${summary}` },
      ...request.messages.slice(index),
    ],
    summary,
    compressedCount: index,
    historyViewSequence: snapshot.sequence,
  }
}
