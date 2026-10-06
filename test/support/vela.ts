import { spyOn } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { LanguageModel, ModelMessage } from 'ai'
import type { VelaEvent } from '../../src/agent/events'
import { createVela, type RunOptions, type Vela } from '../../src/app'
import { createCliDispatcher } from '../../src/cli/commands'
import type { CommandContext } from '../../src/commands'
import type { VelaLimits } from '../../src/limits'
import type { PluginDefinition } from '../../src/plugins/types'
import type { EmbeddingFn } from '../../src/rag/embedder'
import { createFauxEmbedder } from '../../src/testing/faux-embedder'
import {
  createFauxModel,
  type FauxModel,
  type FauxModelOptions,
  type FauxStep,
} from '../../src/testing/faux'

export interface FixtureSkill {
  name: string
  description: string
  whenToUse?: string
  body: string
}

export interface TestVelaOptions {
  /** faux 主队列（streamText） */
  responses?: FauxStep[]
  /** faux generate 队列（摘要压缩的 generateText） */
  generate?: FauxStep[]
  /** faux 的其他选项（chunkSize、cache…） */
  faux?: Omit<FauxModelOptions, 'responses' | 'generate'>
  /** 直接指定模型（不用 faux）；此时 `t.model` 不可用 */
  model?: LanguageModel
  /** 复用已有目录（例如测试会话恢复）；不传则新建临时目录 */
  cwd?: string
  /** 相对 cwd 的数据目录，默认等于 cwd */
  dataDir?: string
  sessionId?: string
  /** 预置到 cwd 的文件：相对路径 → 内容 */
  files?: Record<string, string>
  /** 预置到 cwd/.skills 的 skill */
  skills?: FixtureSkill[]
  /** true 用确定性的 faux embedder 打开 RAG；也可以直接传 embedder */
  embedder?: boolean | EmbeddingFn
  /** 覆盖上限；测试默认 retryBaseMs=0，重试不等待 */
  limits?: Partial<VelaLimits>
  /** 斜杠命令里可加载的插件，默认无 */
  plugins?: Map<string, PluginDefinition>
  /** cleanup 时不检查 faux 脚本是否用完 */
  allowPendingResponses?: boolean
}

const live: TestVela[] = []

/**
 * 用真实的 createVela() 装配一个 Vela：模型换成 faux，cwd/数据目录换成临时目录，
 * 收集所有事件。和 CLI 共用同一份装配和同一份斜杠命令分发器。
 */
export function createTestVela(options: TestVelaOptions = {}) {
  const ownsDir = !options.cwd
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'vela-test-'))
  for (const [path, content] of Object.entries(options.files ?? {}))
    writeFile(join(cwd, path), content)
  for (const skill of options.skills ?? []) writeSkill(cwd, skill)

  const faux = options.model
    ? undefined
    : createFauxModel({
        ...options.faux,
        responses: options.responses,
        generate: options.generate,
      })
  const embedder =
    options.embedder === true
      ? createFauxEmbedder()
      : options.embedder || undefined

  const events: VelaEvent[] = []
  const vela = createVela({
    model: options.model ?? faux!,
    cwd,
    dataDir: options.dataDir,
    sessionId: options.sessionId,
    embedder,
    limits: { retryBaseMs: 0, ...options.limits },
    onEvent: (event) => events.push(event),
  })

  let asks = 0
  let idleWaiters: (() => void)[] = []
  const ctx: CommandContext = vela.commandContext(() => {
    asks++
    const waiters = idleWaiters
    idleWaiters = []
    for (const resolve of waiters) resolve()
  })
  const dispatch = createCliDispatcher(vela, options.plugins ?? new Map())

  const t = {
    vela,
    cwd,
    dataDir: vela.dataDir,
    ctx,
    events,
    get model(): FauxModel {
      if (!faux) throw new Error('createTestVela: a custom model was passed')
      return faux
    },
    get messages(): ModelMessage[] {
      return vela.messages
    },

    run: (input: string, runOptions?: RunOptions) =>
      vela.run(input, runOptions),

    /** 事件类型序列，断言流程用 */
    eventTypes: (): VelaEvent['type'][] => events.map((e) => e.type),
    eventsOf: <T extends VelaEvent['type']>(type: T) =>
      events.filter(
        (e): e is Extract<VelaEvent, { type: T }> => e.type === type,
      ),
    clearEvents: () => {
      events.length = 0
    },
    /** 所有 text_delta 拼起来的文本 */
    streamedText: () =>
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    /** 最后一条 assistant 消息的文本 */
    lastAssistantText: () => {
      const last = [...vela.messages]
        .reverse()
        .find((m) => m.role === 'assistant')
      if (!last) return ''
      if (typeof last.content === 'string') return last.content
      return last.content
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
    },

    /** 执行斜杠命令；返回值同 CLI 分发器：true / false / 'async' */
    dispatch: (command: string) => dispatch(command, ctx),
    /** 执行斜杠命令并等它结束（异步命令等到它调用 ask()） */
    command: async (command: string) => {
      const before = asks
      const done = new Promise<void>((resolve) => idleWaiters.push(resolve))
      const result = dispatch(command, ctx)
      if (result === 'async' && asks === before) await done
      return result
    },
    askCount: () => asks,

    path: (relative: string) => join(cwd, relative),
    dataPath: (relative: string) => join(vela.dataDir, relative),
    exists: (relative: string) => existsSync(join(vela.dataDir, relative)),
    readData: (relative: string) =>
      Bun.file(join(vela.dataDir, relative)).text(),
    readFile: (relative: string) => Bun.file(join(cwd, relative)).text(),
    writeFile: (relative: string, content: string) =>
      writeFile(join(cwd, relative), content),

    /** dispose，删除自己建的临时目录；默认检查 faux 脚本是否全部用完 */
    async cleanup({ keepDir = false } = {}) {
      const index = live.indexOf(t)
      if (index !== -1) live.splice(index, 1)
      await vela.dispose()
      if (ownsDir && !keepDir) rmSync(cwd, { recursive: true, force: true })
      if (faux && !options.allowPendingResponses && faux.pending() > 0)
        throw new Error(
          `faux script has ${faux.pending()} unused response(s) after ${faux.calls.length} request(s)`,
        )
    },
  }
  live.push(t)
  return t
}

export type TestVela = ReturnType<typeof createTestVela>

/** 在 afterEach 里调用：清理本文件里还没 cleanup 的 TestVela。 */
export async function cleanupTestVelas(): Promise<void> {
  const errors: unknown[] = []
  for (const t of live.slice()) await t.cleanup().catch((e) => errors.push(e))
  if (errors.length) throw errors[0]
}

/** 新建一个临时目录（不归 TestVela 管），用于需要多个 Vela 共用目录的测试 */
export function tempDir(prefix = 'vela-test-'): {
  path: string
  cleanup(): void
} {
  const path = mkdtempSync(join(tmpdir(), prefix))
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

/** 捕获 console.log / console.error 的输出，返回拼好的文本 */
export async function captureConsole<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T; output: string }> {
  const lines: string[] = []
  const record = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  const log = spyOn(console, 'log').mockImplementation(record)
  const error = spyOn(console, 'error').mockImplementation(record)
  try {
    const result = await fn()
    return { result, output: lines.join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

function writeSkill(cwd: string, skill: FixtureSkill) {
  const meta = ['---', `description: ${skill.description}`]
  if (skill.whenToUse) meta.push(`when_to_use: ${skill.whenToUse}`)
  writeFile(
    join(cwd, '.skills', skill.name, 'SKILL.md'),
    `${meta.join('\n')}\n---\n\n${skill.body}\n`,
  )
}
