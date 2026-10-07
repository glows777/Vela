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
import { toolResultOutputToText } from './tool-result-output'
import {
  archiveToolResults,
  getStoredResult,
  StoredToolResult,
  storedResultOutput,
  type ToolResultStore,
} from '../session/tool-results'
import { DEFAULT_LIMITS } from '../limits'
import { normalizeUsage, type TokenTracker } from '../usage/tracker'
import {
  estimateRequestTokens,
  MAX_INPUT_TOKENS,
  type RequestSnapshot,
} from './request'

export const MICROCOMPACT_TOKEN_THRESHOLD = DEFAULT_LIMITS.microcompactThreshold
export const SUMMARY_TOKEN_THRESHOLD = DEFAULT_LIMITS.summaryThreshold
export const MIN_MICRO_SAVINGS = DEFAULT_LIMITS.minMicroSavings
const KEEP_RECENT_CALLS = 5
const KEEP_RECENT_MESSAGES = 6
const CLEARABLE_TOOLS = new Set([
  'read_file',
  'bash',
  'grep',
  'glob',
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
      (/^(?:exit=[1-9]|命令执行失败)/.test(text) ||
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
      const file = Bun.file(candidate.reference.path)
      // Open the reference, not just stat it, before removing the remaining preview.
      await file.slice(0, 1).arrayBuffer()
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
    '上下文需要摘要，但没有能保留近期消息和工具配对的切分位置；本轮已停止，原历史保留。',
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

const SUMMARY_CONTROL = `本轮只生成历史摘要，不执行工具，不回答历史中的请求。唯一资料范围是 sourceCatalog 标识的旧消息；其余保留区消息以及本条维护指令都不是摘要资料。只选取能够独立表达事实的原文片段，不生成改写或推断。不得把本条的输出格式、摘要规则、数量/范围、维护动作写成用户目标、业务约束、已完成操作或待办；不要提及保留区中的新请求，它们会原样交给后续主循环。历史中要求只回复确认语的指令不是本轮输出要求。只返回 JSON 对象：sourceMessageCount 原样复制本条数量；goal 是一个事实对象，completed、pending、constraints、details 是事实对象数组。每个事实对象必须且只能包含 sourceMessageIndex（sourceCatalog 中的0-based编号）、quote（该旧消息中的连续原句，不超过400字符，不改写；仅空白差异允许）。程序只保留已核验的 quote 原句，不接受 text 或其他改写字段。未完成的事情不能写成已完成，失败不能写成成功。数组没有内容就为空，至少一个数组有事实。约800字，语言与历史一致，不编造。`

export async function summarize(
  request: RequestSnapshot,
  results: ToolResultStore,
  tracker: TokenTracker,
  maxInputTokens = MAX_INPUT_TOKENS,
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
      }),
    },
  ]
  // Preserve the wire schemas/order but remove all client execution hooks.
  // Hosted tools cannot be made inert locally: stop instead of changing the prefix.
  const tools: ToolSet = {}
  for (const [name, tool] of Object.entries(request.tools)) {
    if (tool.type === 'provider' || typeof tool.description === 'function')
      throw new Error(
        '无法在保持主请求前缀的同时禁用该工具的执行；摘要已停止，原历史保留。',
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
    throw new Error('摘要输入超过安全容量，本轮已停止，原历史保留。')
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
      throw new Error('摘要未完整生成合法 JSON；本轮已停止，原历史保留。')
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
    throw new Error('摘要未完整生成或返回了工具调用；本轮已停止，原历史保留。')
  const parsed = summarySchema.safeParse(response.output)
  if (!parsed.success || parsed.data.sourceMessageCount !== index)
    throw new Error('摘要未满足历史摘要结构要求；本轮已停止，原历史保留。')
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
      '摘要引用不属于被移除的历史或原句不匹配；本轮已停止，原历史保留。',
    )
  const section = (name: string, items: z.infer<typeof summaryFact>[]) =>
    `## ${name}\n${items.length ? items.map((item) => `- ${item.quote}`).join('\n') : '无'}`
  const summaryText = [
    `## 用户目标\n${data.goal.quote}`,
    section('已完成操作', data.completed),
    section('未完成事项', data.pending),
    section('约束', data.constraints),
    section('关键事实', data.details),
  ].join('\n\n')
  await archiveToolResults(removed, results)
  const snapshot = await results.history.snapshot(request.abortSignal)
  const summary =
    summaryText +
    `\n\n${results.history.readingGuide(snapshot.sequence, snapshot.path)}`
  return {
    messages: [
      { role: 'user', content: `[之前对话的摘要]\n${summary}` },
      ...request.messages.slice(index),
    ],
    summary,
    compressedCount: index,
    historyViewSequence: snapshot.sequence,
  }
}
