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
import type { VelaEvent } from '../agent/events'
import type { VelaExtension } from '../extensions/types'
import type { VelaLimits } from '../limits'
import type { VelaLogger } from '../logger'
import type { EmbeddingFn } from '../rag/embedder'
import { createVela, type Vela } from '../vela'
import type {
  PromptOptions,
  SessionOptions,
  VelaSession,
} from '../vela-session'
import {
  createFauxModel,
  type FauxModel,
  type FauxModelOptions,
  type FauxStep,
} from './faux'
import { createFauxEmbedder } from './faux-embedder'

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
  /** 默认会话（`t.session`）的 id，默认 'default' */
  sessionId?: string
  /** 预置到 cwd 的文件：相对路径 → 内容 */
  files?: Record<string, string>
  /** 预置到 cwd/.skills 的 skill */
  skills?: FixtureSkill[]
  /** true 用确定性的 faux embedder 打开 RAG；也可以直接传 embedder */
  embedder?: boolean | EmbeddingFn
  /** 覆盖上限；测试默认 retryBaseMs=0，重试不等待 */
  limits?: Partial<VelaLimits>
  logger?: VelaLogger
  /** 要加载的扩展（被测的扩展） */
  extensions?: VelaExtension[]
  /** 默认会话的选项（角色、权限、工具选择、ui） */
  session?: SessionOptions
  /** cleanup 时不检查 faux 脚本是否用完 */
  allowPendingResponses?: boolean
}

const live = new Set<{ cleanup(): Promise<void> }>()

/**
 * 用真实的 createVela() 装配一个 Vela：模型换成 faux，cwd/数据目录换成临时目录，
 * 收集所有会话的事件。`t.session` 是默认会话，`t.run()` 等于 `t.session.prompt()`。
 * 扩展作者也可以用它离线测试自己的工具和 hooks。
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

  const vela: Vela = createVela({
    model: options.model ?? (faux as FauxModel),
    cwd,
    dataDir: options.dataDir,
    embedder,
    limits: { retryBaseMs: 0, ...options.limits },
    logger: options.logger,
    extensions: options.extensions,
  })
  const events: VelaEvent[] = []
  const sessionIds: string[] = []
  vela.subscribe((event, sessionId) => {
    events.push(event)
    sessionIds.push(sessionId)
  })
  const session: VelaSession = vela.session(
    options.sessionId ?? 'default',
    options.session,
  )

  const t = {
    vela,
    session,
    cwd,
    dataDir: vela.dataDir,
    /** 所有会话的事件，按发生顺序 */
    events,
    get model(): FauxModel {
      if (!faux) throw new Error('createTestVela: a custom model was passed')
      return faux
    },
    get messages(): ModelMessage[] {
      return session.messages
    },

    /** 默认会话跑一轮 */
    run: (input: string, runOptions?: PromptOptions) =>
      session.prompt(input, runOptions),
    tracker: () => session.tracker,

    /** 事件类型序列，断言流程用 */
    eventTypes: (): VelaEvent['type'][] => events.map((e) => e.type),
    eventsOf: <T extends VelaEvent['type']>(type: T) =>
      events.filter(
        (e): e is Extract<VelaEvent, { type: T }> => e.type === type,
      ),
    /** 某个会话的事件 */
    eventsIn: (sessionId: string): VelaEvent[] =>
      events.filter((_, i) => sessionIds[i] === sessionId),
    clearEvents: () => {
      events.length = 0
      sessionIds.length = 0
    },
    /** 所有 text_delta 拼起来的文本 */
    streamedText: () =>
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    /** 默认会话最后一条 assistant 消息的文本 */
    lastAssistantText: () => lastAssistantText(session.messages),

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
      live.delete(t)
      await vela.dispose()
      if (ownsDir && !keepDir) rmSync(cwd, { recursive: true, force: true })
      if (faux && !options.allowPendingResponses && faux.pending() > 0)
        throw new Error(
          `faux script has ${faux.pending()} unused response(s) after ${faux.calls.length} request(s)`,
        )
    },
  }
  live.add(t)
  return t
}

export type TestVela = ReturnType<typeof createTestVela>

/** 在 afterEach 里调用：清理还没 cleanup 的 TestVela。 */
export async function cleanupTestVelas(): Promise<void> {
  const errors: unknown[] = []
  for (const t of [...live]) await t.cleanup().catch((e) => errors.push(e))
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

export function lastAssistantText(messages: readonly ModelMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!last) return ''
  if (typeof last.content === 'string') return last.content
  return last.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
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
