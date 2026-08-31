import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModel, ModelMessage } from 'ai'
import { createDispatcher, type CommandContext, type CommandHandler } from '../commands'
import { createSkillCommands } from '../commands/skill'
import { MemoryStore } from '../memory/store'
import { createMockModel } from '../mock'
import { coreRules, deferredTools, memoryContext, ragContext, sessionContext } from '../prompt'
import { PromptPipeline } from '../prompt/pipelins'
import { SqliteVectorStore } from '../rag/sqllite-store'
import { SessionStore } from '../session'
import { SkillLoader } from '../skills/loader'
import { ToolRegistry } from '../tools/registry'
import { TokenTracker } from '../usage/tracker'

export interface FixtureSkill {
  name: string
  description: string
  whenToUse?: string
  body: string
}

export interface TestFixture {
  ctx: CommandContext
  dispatch: ReturnType<typeof createDispatcher>
  loader: SkillLoader
  activeSkills: Set<string>
  memoryStore: MemoryStore
  askCount: () => number
  rootDir: string
  cleanup: () => void
}

/**
 * 在临时目录里装配一个和 src/index.ts 相同结构的运行环境：
 * 真实 PromptPipeline（coreRules/deferredTools/memory/rag/skill/session）、
 * 真实 MemoryStore / SqliteVectorStore / SessionStore / ToolRegistry，全部指向临时目录；
 * 模型用 createMockModel()（无网络）；ask() 只做计数。
 */
export function createTestFixture(opts: {
  skill?: FixtureSkill
  commands?: CommandHandler[]
  model?: LanguageModel
} = {}): TestFixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-test-'))
  const loader = new SkillLoader(rootDir)

  if (opts.skill) {
    const skillDir = path.join(rootDir, '.skills', opts.skill.name)
    fs.mkdirSync(skillDir, { recursive: true })
    const meta = ['---', `description: ${opts.skill.description}`]
    if (opts.skill.whenToUse) meta.push(`when_to_use: ${opts.skill.whenToUse}`)
    const frontmatter = `${meta.join('\n')}\n---\n\n`
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `${frontmatter}${opts.skill.body}\n`,
      'utf-8',
    )
  }
  loader.load()

  const activeSkills = new Set<string>()
  const messages: ModelMessage[] = []
  const timestamps = new Map<ModelMessage, number>()
  const registry = new ToolRegistry()
  const tracker = new TokenTracker()
  const memoryStore = new MemoryStore(rootDir)
  memoryStore.init()
  const vectorStore = new SqliteVectorStore(path.join(rootDir, 'knowledge.db'))
  const sessionStore = new SessionStore('test', path.join(rootDir, '.sessions'))

  const builder = new PromptPipeline()
    .pipe('coreRules', coreRules())
    .pipe('deferredTools', deferredTools())
    .pipe('memoryContext', memoryContext(memoryStore))
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('skillContext', () => loader.buildPromptSection(activeSkills))
    .pipe('sessionContext', sessionContext())

  let asks = 0
  const ctx: CommandContext = {
    messages,
    timestamps,
    registry,
    builder,
    tracker,
    sessionStore,
    model: opts.model ?? createMockModel(),
    makePromptCtx: () => ({
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId: 'test',
    }),
    prepareContext: async () => {},
    ask: () => {
      asks++
    },
    memoryStore,
    vectorStore,
    busy: { locked: false },
  }

  const dispatch = createDispatcher([
    ...(opts.commands ?? []),
    ...createSkillCommands(loader, activeSkills),
  ])

  return {
    ctx,
    dispatch,
    loader,
    activeSkills,
    memoryStore,
    askCount: () => asks,
    rootDir,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  }
}
