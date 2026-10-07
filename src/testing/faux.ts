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

/**
 * 脚本化的 faux 模型（对应 pi 的 faux provider）。
 *
 * 实现 AI SDK 的 LanguageModelV4，按顺序回放预设的响应，所以 streamText / generateText、
 * 工具执行、重试和上下文压缩全部走真实代码。每次请求都会记进 `calls`，测试可以断言模型
 * “看到了什么”。脚本用完后的请求会直接报错，不会静默挂住。
 *
 * 响应是可 JSON 序列化的 `FauxResponse`（CLI 用 `VELA_MODEL=faux:<file.json>` 回放），
 * 也可以是 `(req) => FauxResponse` 动态生成，或者一个数组（合并成一次响应，用于并行工具调用）。
 */

export type FauxFinishReason = LanguageModelV4FinishReason['unified']

export interface FauxToolCall {
  name: string
  input: unknown
  /** 默认 `faux-call-<请求序号>-<序号>` */
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
  /** 默认：有工具调用时 'tool-calls'，否则 'stop' */
  finishReason?: FauxFinishReason
  /** 覆盖默认的确定性 usage 估算 */
  usage?: FauxUsage
  /** 请求直接失败（例如 '429 Too Many Requests'，或真实 provider 抛的 APICallError），不产生任何输出 */
  error?: string | Error
  /** 先流出 text，再在流中途报这个错误 */
  streamError?: string
  /** 一直不结束，直到请求被 abort（测试中断用） */
  hang?: boolean
}

export interface FauxRequest {
  /** 从 1 开始的请求序号（stream 和 generate 共用计数） */
  index: number
  kind: 'stream' | 'generate'
  system: string
  prompt: LanguageModelV4Prompt
  /** 本次请求可用的工具名 */
  tools: string[]
  /** 最后一条 user 消息的文本 */
  lastUserText: string
  /** 最近一组工具结果（上一步工具执行后发回模型的内容） */
  toolResults: {
    toolCallId: string
    toolName: string
    /** 工具结果的文本形式 */
    output: string
    /** 原始的 tool-result output（{ type, value }） */
    raw: unknown
  }[]
  /** 请求要求的 JSON 输出（例如压缩摘要的 Output.json()） */
  responseFormat?: LanguageModelV4CallOptions['responseFormat']
  abortSignal?: AbortSignal
}

export type FauxStep =
  | FauxResponse
  | FauxResponse[]
  | ((req: FauxRequest) => FauxResponse | FauxResponse[])

export interface FauxModelOptions {
  /** 主队列：streamText（以及没有 generate 队列时的 generateText）按顺序消费 */
  responses?: FauxStep[]
  /** generateText（目前是上下文压缩摘要）单独的队列；不传则共用主队列 */
  generate?: FauxStep[]
  /** 文本每块的字符数，默认 8；<=0 表示整段一次输出 */
  chunkSize?: number
  /** 每块之间的延迟毫秒数，默认 0 */
  chunkDelayMs?: number
  /** 模拟 prompt cache：system 前缀不变时记 cacheRead，变化时记 cacheWrite */
  cache?: boolean
  modelId?: string
}

export interface FauxModel extends LanguageModelV4 {
  /** 每次请求的记录，按顺序 */
  readonly calls: FauxRequest[]
  /** 追加主队列响应 */
  push(...steps: FauxStep[]): void
  /** 追加 generate 队列响应 */
  pushGenerate(...steps: FauxStep[]): void
  /** 还没用掉的响应数（主队列 + generate 队列） */
  pending(): number
}

// --- 构造响应的小工具 ---

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
 * 根据压缩请求生成一份合法的历史摘要 JSON：引用的都是被移除消息里的原文，
 * 能通过 compressor 的结构与引用校验。用在 `generate` 队列里。
 */
export const fauxSummary =
  (pick: { goal?: number } = {}) =>
  (req: FauxRequest): FauxResponse => {
    const control = findCompactionControl(req.prompt)
    if (!control)
      throw new Error('faux: fauxSummary used on a non-compaction request')
    const catalog = control.sourceCatalog.filter((s) => s.anchor.trim())
    const goal =
      catalog.find((s) => s.index === pick.goal) ??
      catalog.find((s) => s.role === 'user') ??
      catalog[0]
    if (!goal) throw new Error('faux: compaction request has no sources')
    const fact = (s: { index: number; anchor: string }) => ({
      sourceMessageIndex: s.index,
      quote: s.anchor.trim().slice(0, 400),
    })
    const rest = catalog.filter((s) => s !== goal).map(fact)
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

// --- 实现 ---

export function createFauxModel(options: FauxModelOptions = {}): FauxModel {
  const main: FauxStep[] = [...(options.responses ?? [])]
  const generate: FauxStep[] | undefined = options.generate
    ? [...options.generate]
    : undefined
  const calls: FauxRequest[] = []
  const chunkSize = options.chunkSize ?? 8
  const chunkDelayMs = options.chunkDelayMs ?? 0
  let lastPrefix: string | undefined

  const next = (
    kind: FauxRequest['kind'],
    opts: LanguageModelV4CallOptions,
  ) => {
    const req = describeRequest(calls.length + 1, kind, opts)
    calls.push(req)
    const queue = kind === 'generate' && generate ? generate : main
    const step = queue.shift()
    if (!step)
      throw new Error(
        `faux: no scripted response for request #${req.index} (${kind}); last user text: ${JSON.stringify(req.lastUserText.slice(0, 80))}`,
      )
    const resolved = typeof step === 'function' ? step(req) : step
    return { req, response: mergeResponses(resolved) }
  }

  const usageFor = (
    req: FauxRequest,
    response: FauxResponse,
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
      const prefix = approxTokens(req.system)
      if (lastPrefix === req.system) cacheRead = prefix
      else cacheWrite = prefix
      lastPrefix = req.system
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

  return {
    specificationVersion: 'v4',
    provider: 'faux',
    modelId: options.modelId ?? 'faux',
    supportedUrls: {},
    calls,
    push: (...steps) => main.push(...steps),
    pushGenerate: (...steps) => (generate ?? main).push(...steps),
    pending: () => main.length + (generate?.length ?? 0),

    async doGenerate(opts): Promise<LanguageModelV4GenerateResult> {
      opts.abortSignal?.throwIfAborted()
      const { req, response } = next('generate', opts)
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
        usage: usageFor(req, response),
        warnings: [],
      }
    },

    async doStream(opts) {
      opts.abortSignal?.throwIfAborted()
      const { req, response } = next('stream', opts)
      if (response.error) throw toError(response.error)
      const parts = streamParts(req.index, response, chunkSize)
      const signal = opts.abortSignal
      let i = 0
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(signal.reason)
            return
          }
          if (i < parts.length) {
            if (chunkDelayMs > 0 && i > 0) await Bun.sleep(chunkDelayMs)
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
            usage: usageFor(req, response),
          })
          controller.close()
          i++
        },
      })
      return { stream }
    },
  }
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
    // 流中途出错时不发 text-end，模拟连接断开
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
  // 按码点切，避免把中文/emoji 的代理对切断
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
  return {
    index,
    kind,
    system,
    prompt,
    tools: (opts.tools ?? []).map((t) => t.name),
    lastUserText: lastUser ? textOf(lastUser.content) : '',
    toolResults,
    responseFormat: opts.responseFormat,
    abortSignal: opts.abortSignal,
  }
}

function findCompactionControl(prompt: LanguageModelV4Prompt):
  | {
      sourceMessageCount: number
      sourceCatalog: { index: number; role: string; anchor: string }[]
    }
  | undefined {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]!
    if (m.role !== 'user') continue
    try {
      const parsed = JSON.parse(textOf(m.content))
      if (parsed?.type === 'context_compaction') return parsed
    } catch {}
  }
}

/** JSON 场景文件的格式（CLI 的 `VELA_MODEL=faux:<file>` 读取它）。 */
export interface FauxScenario {
  /** 用户输入（按顺序）；`replayScenario()` 用它把整段会话重跑一遍，CLI 回放时忽略 */
  inputs?: string[]
  responses: FauxResponse[]
  generate?: FauxResponse[]
  chunkSize?: number
  chunkDelayMs?: number
  cache?: boolean
}

export async function readFauxScenario(path: string): Promise<FauxScenario> {
  const scenario = (await Bun.file(path).json()) as FauxScenario
  if (!Array.isArray(scenario.responses))
    throw new Error(`faux scenario ${path} must have a "responses" array`)
  return scenario
}

export async function loadFauxScenario(path: string): Promise<FauxModel> {
  return createFauxModel(await readFauxScenario(path))
}
