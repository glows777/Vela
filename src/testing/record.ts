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
} from './faux.ts'

export interface RecordOptions {
  /** Where to write the scenario JSON; rewritten in full after each request so a mid-run exit keeps what was recorded */
  path: string
}

export interface Recorder {
  /** The wrapped model: behaves like the original and records every response */
  model: LanguageModel
  /** Records a user input (the CLI calls this on agent_start); replay feeds inputs back in order */
  addInput(input: string): void
  /** The scenario recorded so far */
  scenario(): FauxScenario
  /** Waits for all pending writes */
  flush(): Promise<void>
}

/**
 * Records a real model's responses in the faux scenario format (`VELA_RECORD=<file>`).
 * Replay the file offline with `VELA_MODEL=faux:<file>` or `replayScenario(file)`, so a problem
 * seen live can become an e2e test directly. The file contains the raw conversation; do not
 * commit it as is.
 */
export function recordModel(
  model: LanguageModel,
  options: RecordOptions,
): Recorder {
  if (typeof model === 'string')
    throw new Error('recordModel: needs a model instance, not a model id string')
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
      // The file holds the raw conversation; only the current user may read or write it
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
    // Reserve a slot in request start order so concurrent sessions replay in the order faux consumes them
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
        // Interrupted: replay uses hang to simulate "never finishes until aborted"
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

/** Drops empty fields so the scenario file reads like a hand-written one; omits finishReason when it is the default */
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

/** A provider APICallError message may lack the status code; include it so replay makes the same retry decisions */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { statusCode?: unknown } | null)?.statusCode
  return typeof status === 'number' && !message.includes(String(status))
    ? `${status} ${message}`
    : message
}
