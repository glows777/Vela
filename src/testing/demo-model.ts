import type {
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider'
import { type LanguageModel, simulateReadableStream } from 'ai'
import { getStoredResult } from '../session/tool-results.ts'

/**
 * Vela demo model (VELA_MODEL=mock): an offline, keyword-driven model that also simulates prompt caching.
 *
 * It fingerprints system + tools to judge prefix stability:
 * - a prefix seen for the first time → all of it counts as cacheWrite
 * - identical to the previous call → all of it counts as cacheRead
 * - prefix changed (system edited, tools added/removed, timestamp injected) → cacheWrite again
 *
 * So /context and /usage show the cache hit rate rising as the conversation goes on.
 */

/** Per-instance state: retry demo counter, cache prefix fingerprint, cache switch. */
interface DemoState {
  retryTestCount: number
  lastPrefixHash: string | null
  cacheEnabled: boolean
}

export type DemoModel = LanguageModel & {
  /** `/cache on|off`: toggle the prompt cache simulation */
  setCacheEnabled(enabled: boolean): void
}

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h.toString(36)
}

function approxTokensFromChars(chars: number): number {
  return Math.ceil(chars / 3.5)
}

type Prompt = LanguageModelV3Prompt
type Message = Prompt[number]

/** All text parts of a message joined (system content is a string). */
function messageText(m: Message): string {
  if (typeof m.content === 'string') return m.content
  return m.content.map((c) => ('text' in c ? c.text : '')).join('')
}

function extractSystemContent(prompt: Prompt): string {
  const sys = (prompt || []).find((m) => m.role === 'system')
  return sys ? messageText(sys) : ''
}

function approxMessageTokens(prompt: Prompt): number {
  let chars = 0
  for (const m of prompt || []) {
    if (m.role === 'system') continue
    for (const c of m.content) {
      if (c.type === 'text') chars += (c.text || '').length
      else if (c.type === 'tool-call')
        chars += JSON.stringify(c.input || {}).length + 80
      else if (c.type === 'tool-result') {
        const out = c.output
        if ('value' in out && out.value) chars += String(out.value).length
        else chars += JSON.stringify(out || {}).length
        chars += 80
      }
    }
  }
  return approxTokensFromChars(chars)
}

/** Computes v3 usage for this call from the prompt, simulating cache hits. */
function makeUsage(state: DemoState, prompt: Prompt, outputChars = 80) {
  const system = extractSystemContent(prompt)
  const prefixContent = system
  const prefixTokens = approxTokensFromChars(prefixContent.length)
  const messageTokens = approxMessageTokens(prompt)
  const outputTokens = approxTokensFromChars(outputChars)

  // Real providers' minimums differ (Qwen implicit 256, OpenAI 1024, Sonnet 4.7 2048, Opus 4.7 4096).
  // 512 lets an ordinary system prompt demonstrate caching.
  const MIN_CACHE = 512
  const cacheable = state.cacheEnabled && prefixTokens >= MIN_CACHE

  const prefixHash = cacheable ? simpleHash(prefixContent) : null
  let cacheRead = 0
  let cacheWrite = 0
  let input = messageTokens

  if (cacheable) {
    if (state.lastPrefixHash === prefixHash) {
      cacheRead = prefixTokens
    } else {
      cacheWrite = prefixTokens
    }
    state.lastPrefixHash = prefixHash
  } else {
    input += prefixTokens
    state.lastPrefixHash = null
  }

  // AI SDK provider v3 usage: inputTokens.total covers all three kinds of input;
  // the breakdown separates uncached input, cache reads and cache writes.
  return {
    inputTokens: {
      total: input + cacheRead + cacheWrite,
      noCache: input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  }
}

const TEXT_RESPONSES = {
  default:
    "Hi! I'm the Vela demo model. Try /context for context usage, /usage for token usage and cache hit rate, and /cache off to compare cost without caching.",
  greeting:
    "Hi! I'm the Vela demo model, with prompt caching and cost tracking wired up :) Chat for a few turns, then type /usage to see how much you saved.",
} satisfies Record<string, string>

interface ToolCallIntent {
  toolName: string
  args: Record<string, unknown>
}

function extractUserText(prompt: Prompt): string {
  const userMsgs = (prompt || []).filter((m) => m.role === 'user')
  const last = userMsgs[userMsgs.length - 1]
  return last ? messageText(last).toLowerCase() : ''
}

function hasToolResults(prompt: Prompt): boolean {
  const msgs = prompt || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'tool') return true
    if (msgs[i]?.role === 'user') return false
  }
  return false
}

function getToolResultContent(prompt: Prompt): string {
  const msgs = prompt || []
  const parts: string[] = []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role === 'tool') {
      for (const c of m.content) {
        if (c.type !== 'tool-result') continue
        const val = ('value' in c.output && c.output.value) || c.output || ''
        const stored = getStoredResult(c.output)
        parts.push(
          stored?.preview ??
            (typeof val === 'string' ? val : JSON.stringify(val)),
        )
      }
    } else if (m?.role === 'user') break
  }
  return parts.join('\n')
}

function wasToolSearchCalled(prompt: Prompt): boolean {
  const msgs = prompt || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role === 'assistant') {
      for (const c of m.content) {
        if (c.type === 'tool-call' && c.toolName === 'tool_search') return true
      }
    }
    if (m?.role === 'user') return false
  }
  return false
}

// Input matching accepts English keywords; the Chinese ones are kept so existing demo inputs still work.
function detectParallelIntent(text: string): ToolCallIntent[] | null {
  if (text.includes('测试并发') || text.includes('test parallel')) {
    return [
      { toolName: 'list_directory', args: { path: '.' } },
      { toolName: 'bash', args: { command: 'echo parallel-1' } },
      { toolName: 'bash', args: { command: 'echo parallel-2' } },
    ]
  }
  return null
}

function detectToolIntent(prompt: Prompt): ToolCallIntent | null {
  const text = extractUserText(prompt)
  const toolResults = getToolResultContent(prompt)

  // Calls a tool on every step and never answers: something to interrupt with Esc
  if (text.includes('测试死循环') || text.includes('test loop')) {
    return { toolName: 'list_directory', args: { path: '.' } }
  }

  // tool_search just returned: call the tool it found
  if (hasToolResults(prompt) && wasToolSearchCalled(prompt)) {
    if (
      toolResults.includes('list_issues') ||
      toolResults.includes('mcp__github')
    ) {
      const repoMatch = text.match(/(\w+)\/(\w[\w-]*)/)
      const owner = repoMatch ? repoMatch[1] : 'vercel'
      const repo = repoMatch ? repoMatch[2] : 'ai'
      return { toolName: 'mcp__github__list_issues', args: { owner, repo } }
    }
    if (
      toolResults.includes('search_pages') ||
      toolResults.includes('mcp__notion')
    ) {
      return {
        toolName: 'mcp__notion__search_pages',
        args: { query: 'project roadmap' },
      }
    }
    if (
      toolResults.includes('navigate') ||
      toolResults.includes('mcp__browser')
    ) {
      return {
        toolName: 'mcp__browser__navigate',
        args: { url: 'https://example.com' },
      }
    }
    if (
      toolResults.includes('supabase') ||
      toolResults.includes('mcp__supabase')
    ) {
      return { toolName: 'mcp__supabase__list_tables', args: {} }
    }
    return null
  }

  if (hasToolResults(prompt)) return null

  // Deferred tools: tool_search first, with the exact tool name
  if (
    text.includes('issue') ||
    text.includes('issues') ||
    text.includes('github')
  ) {
    return {
      toolName: 'tool_search',
      args: { query: 'mcp__github__list_issues' },
    }
  }
  if (
    text.includes('notion') ||
    text.includes('笔记') ||
    text.includes('文档')
  ) {
    return {
      toolName: 'tool_search',
      args: { query: 'mcp__notion__search_pages' },
    }
  }
  if (
    text.includes('浏览器') ||
    text.includes('browser') ||
    text.includes('webpage') ||
    text.includes('网页')
  ) {
    return {
      toolName: 'tool_search',
      args: { query: 'mcp__browser__navigate' },
    }
  }
  if (
    text.includes('数据库') ||
    text.includes('database') ||
    text.includes('supabase') ||
    text.includes('sql')
  ) {
    return {
      toolName: 'tool_search',
      args: { query: 'mcp__supabase__list_tables' },
    }
  }

  // Built-in tools (not deferred, called directly)
  if (text.includes('测试截断') || text.includes('test truncation')) {
    return { toolName: 'read_file', args: { path: 'sample-data.txt' } }
  }
  if (text.includes('测试编辑') || text.includes('test edit')) {
    return {
      toolName: 'edit_file',
      args: {
        path: 'sample-data.txt',
        edits: [
          {
            oldText: '1. Tool registration',
            newText: '1. Tool registration (updated)',
          },
        ],
      },
    }
  }
  if (
    text.includes('测试搜索') ||
    text.includes('test grep') ||
    text.includes('test search')
  ) {
    return { toolName: 'grep', args: { pattern: 'export', path: 'src' } }
  }
  if (text.includes('测试find') || text.includes('test find')) {
    return { toolName: 'find', args: { pattern: '**/*.ts' } }
  }
  if (text.includes('测试bash') || text.includes('test bash')) {
    return {
      toolName: 'bash',
      args: { command: 'echo "Hello from bash!" && date' },
    }
  }
  if (
    text.includes('目录') ||
    text.includes('文件列表') ||
    text.includes('directory') ||
    text.includes('list files') ||
    /\bls\b/.test(text)
  ) {
    return { toolName: 'list_directory', args: { path: '.' } }
  }

  const fileMatch = text.match(/(\S+\.[\w]+)/)
  if (
    fileMatch &&
    (text.includes('读') ||
      text.includes('read') ||
      text.includes('看看') ||
      text.includes('查看') ||
      text.includes('打开') ||
      text.includes('open') ||
      text.includes('view') ||
      text.includes('文件') ||
      text.includes('file'))
  ) {
    return { toolName: 'read_file', args: { path: fileMatch[1] } }
  }

  return null
}

function pickTextResponse(prompt: Prompt): string {
  if (hasToolResults(prompt)) {
    const combined = getToolResultContent(prompt)

    if (combined.includes('[DIR]') || combined.includes('[FILE]')) {
      return `Files in the current directory:\n${combined}`
    }
    if (
      combined.includes('Sent') ||
      combined.includes('Navigated') ||
      combined.includes('Clicked') ||
      combined.includes('Filled') ||
      combined.includes('已发送') ||
      combined.includes('已导航') ||
      combined.includes('已点击') ||
      combined.includes('已填写')
    ) {
      return `Done: ${combined}`
    }
    if (
      combined.includes('number') ||
      combined.includes('title') ||
      combined.includes('state')
    ) {
      return `Results:\n${combined}`
    }
    return `The tool returned:\n${combined}`
  }

  const text = extractUserText(prompt)
  if (text.includes('你好') || text.includes('hello') || text.includes('hi'))
    return TEXT_RESPONSES.greeting
  return TEXT_RESPONSES.default
}

/**
 * The compactor sends a `context_compaction` JSON request (see src/context/compressor.ts) and accepts
 * only verbatim quotes of the removed messages. Quote each message's anchor: the first user message
 * as the goal, the rest as details.
 */
function groundedSummary(prompt: Prompt): string | undefined {
  const last = prompt.at(-1)
  if (last?.role !== 'user') return undefined
  let control: {
    type?: string
    sourceMessageCount: number
    sourceCatalog: { index: number; role: string; anchor: string }[]
  }
  try {
    control = JSON.parse(messageText(last))
  } catch {
    return undefined
  }
  if (control?.type !== 'context_compaction') return undefined
  const facts = control.sourceCatalog
    .filter((s) => s.anchor.trim())
    .map((s) => ({
      sourceMessageIndex: s.index,
      quote: s.anchor.trim(),
      role: s.role,
    }))
  const goal = facts.find((f) => f.role === 'user') ?? facts[0]
  if (!goal) return undefined
  const fact = ({ sourceMessageIndex, quote }: (typeof facts)[number]) => ({
    sourceMessageIndex,
    quote,
  })
  const rest = facts.filter((f) => f !== goal).map(fact)
  return JSON.stringify({
    sourceMessageCount: control.sourceMessageCount,
    goal: fact(goal),
    completed: [],
    pending: [],
    constraints: [],
    details: rest.length ? rest : [fact(goal)],
  })
}

function makeToolCallChunks(
  state: DemoState,
  intents: ToolCallIntent[],
  prompt: Prompt,
): LanguageModelV3StreamPart[] {
  const chunks: LanguageModelV3StreamPart[] = []
  for (const intent of intents) {
    const callId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const argsJson = JSON.stringify(intent.args)
    chunks.push(
      { type: 'tool-input-start', id: callId, toolName: intent.toolName },
      { type: 'tool-input-delta', id: callId, delta: argsJson },
      { type: 'tool-input-end', id: callId },
      {
        type: 'tool-call',
        toolCallId: callId,
        toolName: intent.toolName,
        input: argsJson,
      },
    )
  }
  chunks.push({
    type: 'finish',
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: makeUsage(state, prompt),
  })
  return chunks
}

export function createMockModel(): DemoModel {
  const state: DemoState = {
    retryTestCount: 0,
    lastPrefixHash: null,
    cacheEnabled: true,
  }
  return {
    setCacheEnabled(enabled: boolean) {
      state.cacheEnabled = enabled
      if (!enabled) state.lastPrefixHash = null
    },
    specificationVersion: 'v3' as const,
    provider: 'mock',
    modelId: 'mock-model',

    get supportedUrls() {
      return Promise.resolve({})
    },

    async doGenerate({ prompt }: { prompt: Prompt }) {
      // Summary compaction: answer with a grounded summary that quotes the removed messages
      const summary = groundedSummary(prompt)
      if (summary) {
        return {
          content: [{ type: 'text' as const, text: summary }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: makeUsage(state, prompt),
          warnings: [],
        }
      }

      const text = extractUserText(prompt)

      if (text.includes('测试重试') || text.includes('test retry')) {
        state.retryTestCount++
        if (state.retryTestCount <= 2) {
          throw new Error('429 Too Many Requests - Rate limit exceeded')
        }
        state.retryTestCount = 0
        return {
          content: [{ type: 'text' as const, text: 'Retry succeeded!' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: makeUsage(state, prompt),
          warnings: [],
        }
      }

      const parallelIntents = detectParallelIntent(text)
      if (parallelIntents && !hasToolResults(prompt)) {
        return {
          content: parallelIntents.map((intent) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            toolName: intent.toolName,
            input: JSON.stringify(intent.args),
          })),
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: makeUsage(state, prompt),
          warnings: [],
        }
      }

      const intent = detectToolIntent(prompt)
      if (intent) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: `call-${Date.now()}`,
              toolName: intent.toolName,
              input: JSON.stringify(intent.args),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: makeUsage(state, prompt),
          warnings: [],
        }
      }

      return {
        content: [{ type: 'text' as const, text: pickTextResponse(prompt) }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: makeUsage(state, prompt),
        warnings: [],
      }
    },

    async doStream({ prompt }: { prompt: Prompt }) {
      const text = extractUserText(prompt)

      if (text.includes('测试重试') || text.includes('test retry')) {
        state.retryTestCount++
        if (state.retryTestCount <= 2) {
          throw new Error('429 Too Many Requests - Rate limit exceeded')
        }
        state.retryTestCount = 0
        const reply = 'Retry succeeded!'
        const id = 'text-1'
        const chunks: LanguageModelV3StreamPart[] = [
          { type: 'text-start', id },
          ...reply.split('').map(
            (char): LanguageModelV3StreamPart => ({
              type: 'text-delta',
              id,
              delta: char,
            }),
          ),
          { type: 'text-end', id },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: makeUsage(state, prompt),
          },
        ]
        return {
          stream: simulateReadableStream({
            chunks: chunks,
            chunkDelayInMs: 30,
          }),
        }
      }

      const parallelIntents = detectParallelIntent(text)
      if (parallelIntents && !hasToolResults(prompt)) {
        return {
          stream: simulateReadableStream({
            chunks: makeToolCallChunks(state, parallelIntents, prompt),
            chunkDelayInMs: 15,
          }),
        }
      }

      const intent = detectToolIntent(prompt)
      if (intent) {
        return {
          stream: simulateReadableStream({
            chunks: makeToolCallChunks(state, [intent], prompt),
            chunkDelayInMs: 20,
          }),
        }
      }

      const replyText = pickTextResponse(prompt)
      const id = 'text-1'
      const chunks: LanguageModelV3StreamPart[] = [
        { type: 'text-start', id },
        ...replyText.split('').map(
          (char): LanguageModelV3StreamPart => ({
            type: 'text-delta',
            id,
            delta: char,
          }),
        ),
        { type: 'text-end', id },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: makeUsage(state, prompt),
        },
      ]
      return {
        stream: simulateReadableStream({ chunks: chunks, chunkDelayInMs: 30 }),
      }
    },
  }
}
