import { readFile } from 'node:fs/promises'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider'
import { compactionSources, findConversation } from './compaction-request.ts'

/**
 * Scripted faux model (the counterpart of pi's faux provider).
 *
 * Implements the AI SDK's LanguageModelV4 and plays back preset responses in order, so
 * streamText / generateText, tool execution, retries and context compaction all run real code.
 * Every request is recorded in `calls`, so tests can assert on what the model "saw".
 * A request after the script runs out fails right away instead of hanging silently.
 *
 * A response is a JSON-serializable `FauxResponse` (the CLI replays them with
 * `VELA_MODEL=faux:<file.json>`), a `(req) => FauxResponse` function, or an array
 * (merged into one response, for parallel tool calls).
 */

export type FauxFinishReason = LanguageModelV4FinishReason['unified']

export interface FauxToolCall {
  name: string
  input: unknown
  /** Default `faux-call-<request index>-<index>` */
  id?: string
}

export interface FauxUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export interface FauxResponse {
  text?: string
  reasoning?: string
  toolCalls?: FauxToolCall[]
  /** Default: 'tool-calls' when there are tool calls, otherwise 'stop' */
  finishReason?: FauxFinishReason
  /** Overrides the default deterministic usage estimate */
  usage?: FauxUsage
  /** Fails the request outright (e.g. '429 Too Many Requests', or an APICallError from a real provider) with no output */
  error?: string | Error
  /** Streams text first, then fails mid-stream with this error */
  streamError?: string
  /** Never finishes until the request is aborted (for interruption tests) */
  hang?: boolean
}

export interface FauxRequest {
  /** 1-based request index (shared by stream and generate) */
  index: number
  kind: 'stream' | 'generate'
  system: string
  prompt: LanguageModelV4Prompt
  /** Tool names available to this request */
  tools: string[]
  /** Text of the last user message */
  lastUserText: string
  /** The latest tool results (what the previous tool step sent back to the model) */
  toolResults: {
    toolCallId: string
    toolName: string
    /** Tool result as text */
    output: string
    /** Raw tool-result output ({ type, value }) */
    raw: unknown
  }[]
  /**
   * Tokens this request would send (prompt and tool definitions), estimated like `maxRequestTokens`:
   * chars / 4. Compare requests to see which one a provider would accept.
   */
  inputTokens: number
  /** JSON output the request asks for (e.g. Output.json() for the compaction summary) */
  responseFormat?: LanguageModelV4CallOptions['responseFormat']
  /** The request's reasoning setting (mapped from the thinking level) */
  reasoning?: LanguageModelV4CallOptions['reasoning']
  /** Extra HTTP headers the request asked for */
  headers?: LanguageModelV4CallOptions['headers']
  abortSignal?: AbortSignal
}

export type FauxStep =
  | FauxResponse
  | FauxResponse[]
  | ((req: FauxRequest) => FauxResponse | FauxResponse[])

export interface FauxModelOptions {
  /** Main queue, consumed in order by streamText (and by generateText when there is no generate queue) */
  responses?: FauxStep[]
  /** Separate queue for generateText (currently the compaction summary); shares the main queue if omitted */
  generate?: FauxStep[]
  /** Characters per text chunk, default 8; <=0 emits the whole text at once */
  chunkSize?: number
  /** Delay between chunks in ms, default 0 */
  chunkDelayMs?: number
  /** Simulates prompt caching: the longest common prefix of tools + system + messages is a cacheRead, the rest a cacheWrite */
  cache?: boolean
  /**
   * A request larger than this many estimated tokens (@see FauxRequest.inputTokens) fails like a provider
   * whose context window is full. The failed request is recorded but uses no scripted response.
   */
  maxRequestTokens?: number
  modelId?: string
}

export interface FauxModel extends LanguageModelV4 {
  /** Record of every request, in order */
  readonly calls: FauxRequest[]
  /**
   * Requests larger than this many estimated tokens fail like a provider context overflow. Change it
   * mid-test to gate requests only after a size was measured from an accepted request.
   */
  maxRequestTokens?: number
  /** Appends responses to the main queue */
  push(...steps: FauxStep[]): void
  /** Appends responses to the generate queue */
  pushGenerate(...steps: FauxStep[]): void
  /** Number of unused responses (main + generate queues) */
  pending(): number
}

// --- Response helpers ---

export const fauxText = (
  text: string,
  options: Omit<FauxResponse, 'text'> = {},
): FauxResponse => ({ ...options, text })

export const fauxToolCall = (
  name: string,
  input: unknown,
  options: Omit<FauxResponse, 'toolCalls'> & { id?: string } = {},
): FauxResponse => {
  const { id, ...rest } = options
  return { ...rest, toolCalls: [{ name, input, id }] }
}

export const fauxError = (error: string | Error): FauxResponse => ({ error })

const toError = (error: string | Error) =>
  typeof error === 'string' ? new Error(error) : error

export const fauxStreamError = (
  message: string,
  partialText = '',
): FauxResponse => ({ text: partialText, streamError: message })

export const fauxHang = (partialText = ''): FauxResponse => ({
  text: partialText,
  hang: true,
})

/**
 * Builds a valid history summary JSON from a compaction request, quoting only text from the
 * removed messages, so it passes the compressor's structure and quote checks.
 * Use it in the `generate` queue.
 */
export const fauxSummary =
  (pick: { goal?: number } = {}) =>
  (req: FauxRequest): FauxResponse => {
    const control = findCompactionControl(req.prompt)
    if (!control)
      throw new Error('faux: fauxSummary used on a non-compaction request')
    const conversation = findConversation(
      req.prompt.filter((m) => m.role === 'user').map((m) => textOf(m.content)),
    )
    const sources = conversation ? compactionSources(conversation) : []
    const goal =
      sources.find((s) => s.index === pick.goal) ??
      sources.find((s) => s.role === 'user') ??
      sources[0]
    if (!goal) throw new Error('faux: compaction request has no sources')
    const fact = (s: { index: number; text: string }) => ({
      sourceMessageIndex: s.index,
      quote: s.text.trim().slice(0, 400),
    })
    const rest = sources.filter((s) => s !== goal).map(fact)
    return {
      text: JSON.stringify({
        sourceMessageCount: control.sourceMessageCount,
        goal: fact(goal),
        completed: [],
        pending: [],
        constraints: [],
        details: rest.length ? rest : [fact(goal)],
      }),
    }
  }

// --- Implementation ---

export function createFauxModel(options: FauxModelOptions = {}): FauxModel {
  const main: FauxStep[] = [...(options.responses ?? [])]
  const generate: FauxStep[] | undefined = options.generate
    ? [...options.generate]
    : undefined
  const calls: FauxRequest[] = []
  const chunkSize = options.chunkSize ?? 8
  const chunkDelayMs = options.chunkDelayMs ?? 0
  let lastPrefix: string | undefined
  let model: FauxModel

  const next = (
    kind: FauxRequest['kind'],
    opts: LanguageModelV4CallOptions,
  ) => {
    const req = describeRequest(calls.length + 1, kind, opts)
    calls.push(req)
    const limit = model.maxRequestTokens
    if (limit !== undefined && req.inputTokens > limit)
      throw new Error(
        `400 prompt is too long: ${req.inputTokens} tokens > ${limit} maximum`,
      )
    const queue = kind === 'generate' && generate ? generate : main
    const step = queue.shift()
    if (!step)
      throw new Error(
        `faux: no scripted response for request #${req.index} (${kind}); last user text: ${JSON.stringify(req.lastUserText.slice(0, 80))}`,
      )
    const resolved = typeof step === 'function' ? step(req) : step
    return {
      req,
      response: mergeResponses(resolved),
      prefix: options.cache ? cachePrefix(opts) : '',
    }
  }

  const usageFor = (
    req: FauxRequest,
    response: FauxResponse,
    prefix: string,
  ): LanguageModelV4Usage => {
    const output =
      response.usage?.output ??
      approxTokens(
        (response.text ?? '') +
          (response.reasoning ?? '') +
          (response.toolCalls ? JSON.stringify(response.toolCalls) : ''),
      )
    let input =
      response.usage?.input ?? approxTokens(JSON.stringify(req.prompt))
    let cacheRead = response.usage?.cacheRead ?? 0
    let cacheWrite = response.usage?.cacheWrite ?? 0
    if (options.cache && response.usage?.input === undefined) {
      const shared = commonPrefixLength(lastPrefix ?? '', prefix)
      cacheRead = approxTokens(prefix.slice(0, shared))
      cacheWrite = approxTokens(prefix.slice(shared))
      lastPrefix = prefix
      input = Math.max(input, cacheRead + cacheWrite)
    }
    return {
      inputTokens: {
        total: input,
        noCache: Math.max(0, input - cacheRead - cacheWrite),
        cacheRead,
        cacheWrite,
      },
      outputTokens: { total: output, text: output, reasoning: 0 },
    }
  }

  model = {
    specificationVersion: 'v4',
    provider: 'faux',
    modelId: options.modelId ?? 'faux',
    supportedUrls: {},
    maxRequestTokens: options.maxRequestTokens,
    calls,
    push: (...steps) => main.push(...steps),
    pushGenerate: (...steps) => (generate ?? main).push(...steps),
    pending: () => main.length + (generate?.length ?? 0),

    async doGenerate(opts): Promise<LanguageModelV4GenerateResult> {
      opts.abortSignal?.throwIfAborted()
      const { req, response, prefix } = next('generate', opts)
      if (response.error) throw toError(response.error)
      if (response.streamError) throw new Error(response.streamError)
      if (response.hang) await waitForAbort(opts.abortSignal)
      const content: LanguageModelV4Content[] = []
      if (response.reasoning)
        content.push({ type: 'reasoning', text: response.reasoning })
      if (response.text !== undefined)
        content.push({ type: 'text', text: response.text })
      for (const [i, call] of (response.toolCalls ?? []).entries())
        content.push(toolCallPart(req.index, i, call))
      return {
        content,
        finishReason: finishReason(response),
        usage: usageFor(req, response, prefix),
        warnings: [],
        response: { headers: fauxHeaders(req) },
      }
    },

    async doStream(opts) {
      opts.abortSignal?.throwIfAborted()
      const { req, response, prefix } = next('stream', opts)
      if (response.error) throw toError(response.error)
      const normalized = streamParts(req.index, response, chunkSize)
      // With includeRawChunks, each part is preceded by a `raw` part carrying it (as a provider's raw chunk would)
      const parts: LanguageModelV4StreamPart[] = opts.includeRawChunks
        ? normalized.flatMap((part) => [{ type: 'raw', rawValue: part }, part])
        : normalized
      const signal = opts.abortSignal
      let i = 0
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(signal.reason)
            return
          }
          if (i < parts.length) {
            if (chunkDelayMs > 0 && i > 0)
              await new Promise((r) => setTimeout(r, chunkDelayMs))
            controller.enqueue(parts[i++]!)
            return
          }
          if (response.hang) {
            await waitForAbort(signal).catch((e) => controller.error(e))
            return
          }
          if (response.streamError) {
            controller.enqueue({
              type: 'error',
              error: new Error(response.streamError),
            })
            controller.close()
            return
          }
          controller.enqueue({
            type: 'finish',
            finishReason: finishReason(response),
            usage: usageFor(req, response, prefix),
          })
          controller.close()
          i++
        },
      })
      return { stream, response: { headers: fauxHeaders(req) } }
    },
  }
  return model
}

/** Response headers of a faux request: `x-faux-request` is the request's index. */
function fauxHeaders(req: FauxRequest): Record<string, string> {
  return { 'x-faux-request': String(req.index) }
}

function mergeResponses(step: FauxResponse | FauxResponse[]): FauxResponse {
  if (!Array.isArray(step)) return step
  const merged: FauxResponse = {}
  for (const r of step) {
    if (r.text) merged.text = (merged.text ?? '') + r.text
    if (r.reasoning) merged.reasoning = (merged.reasoning ?? '') + r.reasoning
    if (r.toolCalls)
      merged.toolCalls = [...(merged.toolCalls ?? []), ...r.toolCalls]
    for (const key of [
      'finishReason',
      'usage',
      'error',
      'streamError',
      'hang',
    ] as const)
      if (r[key] !== undefined) Object.assign(merged, { [key]: r[key] })
  }
  return merged
}

function finishReason(response: FauxResponse): LanguageModelV4FinishReason {
  return {
    unified:
      response.finishReason ??
      (response.toolCalls?.length ? 'tool-calls' : 'stop'),
    raw: undefined,
  }
}

function toolCallPart(request: number, i: number, call: FauxToolCall) {
  return {
    type: 'tool-call' as const,
    toolCallId: call.id ?? `faux-call-${request}-${i + 1}`,
    toolName: call.name,
    input: JSON.stringify(call.input ?? {}),
  }
}

function streamParts(
  request: number,
  response: FauxResponse,
  chunkSize: number,
): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
  ]
  if (response.reasoning) {
    parts.push({ type: 'reasoning-start', id: 'r' })
    for (const delta of chunk(response.reasoning, chunkSize))
      parts.push({ type: 'reasoning-delta', id: 'r', delta })
    parts.push({ type: 'reasoning-end', id: 'r' })
  }
  if (response.text) {
    parts.push({ type: 'text-start', id: 't' })
    for (const delta of chunk(response.text, chunkSize))
      parts.push({ type: 'text-delta', id: 't', delta })
    // No text-end on a mid-stream error, simulating a dropped connection
    if (!response.streamError && !response.hang)
      parts.push({ type: 'text-end', id: 't' })
  }
  if (!response.streamError && !response.hang)
    for (const [i, call] of (response.toolCalls ?? []).entries())
      parts.push(toolCallPart(request, i, call))
  return parts
}

function chunk(text: string, size: number): string[] {
  if (size <= 0 || text.length <= size) return [text]
  const out: string[] = []
  // Split by code point so CJK/emoji surrogate pairs stay intact
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i += size)
    out.push(chars.slice(i, i + size).join(''))
  return out
}

function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    })
  })
}

const approxTokens = (text: string) => Math.ceil(text.length / 4)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === 'text' ? (part.text ?? '') : '',
    )
    .join('')
}

function toolOutputText(output: unknown): string {
  if (!output || typeof output !== 'object') return String(output ?? '')
  const o = output as { type?: string; value?: unknown }
  if (typeof o.value === 'string') return o.value
  return JSON.stringify(o.value ?? output)
}

/**
 * The request as providers compare a cached prefix: tools, then system, then messages (the order Anthropic
 * matches in). Serialized once so the longest common prefix with the previous request can be measured.
 */
function cachePrefix(opts: LanguageModelV4CallOptions): string {
  const system = opts.prompt
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n')
  // Provider options (cache markers, reasoning settings) are metadata, not part of what a provider
  // hashes as the context; the last message's cache marker moves with every request.
  return JSON.stringify(
    {
      tools: opts.tools ?? {},
      system,
      messages: opts.prompt.filter((m) => m.role !== 'system'),
    },
    (key, value) => (key === 'providerOptions' ? undefined : value),
  )
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function describeRequest(
  index: number,
  kind: FauxRequest['kind'],
  opts: LanguageModelV4CallOptions,
): FauxRequest {
  const prompt = opts.prompt
  const system = prompt
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n')
  const lastUser = [...prompt].reverse().find((m) => m.role === 'user')
  const toolResults: FauxRequest['toolResults'] = []
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!
    if (m.role !== 'tool') break
    for (const part of m.content)
      if (part.type === 'tool-result')
        toolResults.unshift({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: toolOutputText(part.output),
          raw: part.output,
        })
  }
  const tools = opts.tools ?? []
  return {
    index,
    kind,
    system,
    prompt,
    inputTokens:
      approxTokens(JSON.stringify(prompt)) +
      approxTokens(JSON.stringify(tools)),
    tools: tools.map((t) => t.name),
    lastUserText: lastUser ? textOf(lastUser.content) : '',
    toolResults,
    responseFormat: opts.responseFormat,
    reasoning: opts.reasoning,
    abortSignal: opts.abortSignal,
    ...(opts.headers ? { headers: opts.headers } : {}),
  }
}

function findCompactionControl(
  prompt: LanguageModelV4Prompt,
): { sourceMessageCount: number } | undefined {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!
    if (m.role !== 'user') continue
    try {
      const parsed = JSON.parse(textOf(m.content))
      if (parsed?.type === 'context_compaction') return parsed
    } catch {}
  }
}

/** Format of a JSON scenario file (read by the CLI's `VELA_MODEL=faux:<file>`). */
export interface FauxScenario {
  /** User inputs, in order; `replayScenario()` uses them to replay the whole session, CLI replay ignores them */
  inputs?: string[]
  responses: FauxResponse[]
  generate?: FauxResponse[]
  chunkSize?: number
  chunkDelayMs?: number
  cache?: boolean
}

export async function readFauxScenario(path: string): Promise<FauxScenario> {
  const scenario = JSON.parse(await readFile(path, 'utf8')) as FauxScenario
  if (!Array.isArray(scenario.responses))
    throw new Error(`faux scenario ${path} must have a "responses" array`)
  return scenario
}

export async function loadFauxScenario(path: string): Promise<FauxModel> {
  return createFauxModel(await readFauxScenario(path))
}
