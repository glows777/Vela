import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from '@ai-sdk/provider'
import type { LanguageModel } from 'ai'
import type {
  FauxFinishReason,
  FauxResponse,
  FauxScenario,
  FauxToolCall,
} from './faux'

export interface RecordOptions {
  /** 场景 JSON 写到哪里；每个请求结束后整份重写，进程中途退出也能留下已录的部分 */
  path: string
}

export interface Recorder {
  /** 包装后的模型：行为和原模型一样，同时记录每次响应 */
  model: LanguageModel
  /** 记录一条用户输入（CLI 在 agent_start 事件里调用），回放时按顺序重新输入 */
  addInput(input: string): void
  /** 当前录到的场景 */
  scenario(): FauxScenario
  /** 等待所有写盘完成 */
  flush(): Promise<void>
}

/**
 * 录制真实模型的响应，存成 faux 场景格式（`VELA_RECORD=<file>`）。
 * 录下来的文件用 `VELA_MODEL=faux:<file>` 或 `replayScenario(file)` 离线重跑，
 * 线上遇到的问题可以直接变成 e2e 测试。文件包含对话原文，不要直接提交到仓库。
 */
export function recordModel(
  model: LanguageModel,
  options: RecordOptions,
): Recorder {
  if (typeof model === 'string')
    throw new Error('recordModel: 需要模型实例，不支持模型 id 字符串')
  const inner = model as LanguageModelV4
  const responses: (FauxResponse | undefined)[] = []
  const generate: (FauxResponse | undefined)[] = []
  const inputs: string[] = []
  let writing: Promise<void> = Promise.resolve()

  const scenario = (): FauxScenario => {
    const done = (list: (FauxResponse | undefined)[]) =>
      list.filter((r): r is FauxResponse => r !== undefined)
    const result: FauxScenario = {
      inputs: [...inputs],
      responses: done(responses),
    }
    const generated = done(generate)
    if (generated.length) result.generate = generated
    return result
  }
  const save = () => {
    writing = writing.then(async () => {
      // 文件里有对话原文，只给当前用户读写（Bun.write 不应用 mode）
      await mkdir(dirname(options.path), { recursive: true })
      await writeFile(
        options.path,
        `${JSON.stringify(scenario(), null, 2)}\n`,
        { mode: 0o600 },
      )
      await chmod(options.path, 0o600)
    })
    return writing
  }
  const settle = (
    list: (FauxResponse | undefined)[],
    slot: number,
    response: FauxResponse,
  ) => {
    list[slot] = response
    void save()
  }

  const doStream: LanguageModelV4['doStream'] = async (
    opts: LanguageModelV4CallOptions,
  ) => {
    // 按请求开始的顺序占位，并发会话的响应也能按 faux 消费的顺序回放
    const slot = responses.push(undefined) - 1
    let result: Awaited<ReturnType<LanguageModelV4['doStream']>>
    try {
      result = await inner.doStream(opts)
    } catch (error) {
      settle(responses, slot, { error: errorText(error) })
      throw error
    }
    const collected = collector()
    const reader = result.stream.getReader()
    let settled = false
    const finish = (extra: FauxResponse = {}) => {
      if (settled) return
      settled = true
      settle(responses, slot, { ...collected.response(), ...extra })
    }
    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            finish()
            controller.close()
            return
          }
          if (value.type === 'error')
            finish({ streamError: errorText(value.error) })
          else collected.add(value)
          controller.enqueue(value)
        } catch (error) {
          finish(
            opts.abortSignal?.aborted
              ? { hang: true }
              : { streamError: errorText(error) },
          )
          controller.error(error)
        }
      },
      cancel(reason) {
        // 被中断：回放时用 hang 模拟“一直不结束，直到 abort”
        finish({ hang: true })
        return reader.cancel(reason)
      },
    })
    return { ...result, stream }
  }

  const doGenerate: LanguageModelV4['doGenerate'] = async (opts) => {
    const slot = generate.push(undefined) - 1
    try {
      const result = await inner.doGenerate(opts)
      settle(
        generate,
        slot,
        fromContent(result.content, result.finishReason.unified, result.usage),
      )
      return result
    } catch (error) {
      settle(
        generate,
        slot,
        opts.abortSignal?.aborted
          ? { hang: true }
          : { error: errorText(error) },
      )
      throw error
    }
  }

  const wrapped = new Proxy(inner, {
    get(target, key, receiver) {
      if (key === 'doStream') return doStream
      if (key === 'doGenerate') return doGenerate
      const value = Reflect.get(target, key, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return {
    model: wrapped,
    addInput: (input) => {
      inputs.push(input)
      void save()
    },
    scenario,
    flush: () => writing,
  }
}

function collector() {
  let text = ''
  let reasoning = ''
  const toolCalls: FauxToolCall[] = []
  let finishReason: FauxFinishReason | undefined
  let usage: LanguageModelV4Usage | undefined
  return {
    add(part: LanguageModelV4StreamPart) {
      if (part.type === 'text-delta') text += part.delta
      else if (part.type === 'reasoning-delta') reasoning += part.delta
      else if (part.type === 'tool-call') toolCalls.push(toolCall(part))
      else if (part.type === 'finish') {
        finishReason = part.finishReason.unified
        usage = part.usage
      }
    },
    response(): FauxResponse {
      return compact({
        text,
        reasoning,
        toolCalls,
        finishReason,
        usage: usage && fauxUsage(usage),
      })
    },
  }
}

function fromContent(
  content: LanguageModelV4Content[],
  finishReason: FauxFinishReason,
  usage: LanguageModelV4Usage,
): FauxResponse {
  let text = ''
  let reasoning = ''
  const toolCalls: FauxToolCall[] = []
  for (const part of content) {
    if (part.type === 'text') text += part.text
    else if (part.type === 'reasoning') reasoning += part.text
    else if (part.type === 'tool-call') toolCalls.push(toolCall(part))
  }
  return compact({
    text,
    reasoning,
    toolCalls,
    finishReason,
    usage: fauxUsage(usage),
  })
}

function toolCall(part: {
  toolCallId: string
  toolName: string
  input: string
}): FauxToolCall {
  let input: unknown = part.input
  try {
    input = JSON.parse(part.input || '{}')
  } catch {}
  return { name: part.toolName, input, id: part.toolCallId }
}

function fauxUsage(usage: LanguageModelV4Usage) {
  return {
    input: usage.inputTokens.total ?? 0,
    output: usage.outputTokens.total ?? 0,
    cacheRead: usage.inputTokens.cacheRead ?? 0,
    cacheWrite: usage.inputTokens.cacheWrite ?? 0,
  }
}

/** 去掉空字段，让场景文件和手写的一样简洁；finishReason 是默认值时也省略 */
function compact(r: {
  text: string
  reasoning: string
  toolCalls: FauxToolCall[]
  finishReason?: FauxFinishReason
  usage?: FauxResponse['usage']
}): FauxResponse {
  const out: FauxResponse = {}
  if (r.text) out.text = r.text
  if (r.reasoning) out.reasoning = r.reasoning
  if (r.toolCalls.length) out.toolCalls = r.toolCalls
  const defaultReason = r.toolCalls.length ? 'tool-calls' : 'stop'
  if (r.finishReason && r.finishReason !== defaultReason)
    out.finishReason = r.finishReason
  if (r.usage) out.usage = r.usage
  return out
}

/** provider 的 APICallError 的 message 不一定带状态码；带上它，回放时重试判断才和原来一致 */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && !message.includes(String(status))
    ? `${status} ${message}`
    : message
}
