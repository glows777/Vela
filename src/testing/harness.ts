import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LanguageModel } from 'ai'
import { createVela, type Vela } from '../app'
import {
  type CommandContext,
  type CommandHandler,
  createDispatcher,
} from '../commands'
import { createSkillCommands } from '../commands/skill'
import type { ContextManager } from '../context/manager'
import type { MemoryStore } from '../memory/store'
import { createMockModel } from '../mock'
import type { SkillLoader } from '../skills/loader'

export interface FixtureSkill {
  name: string
  description: string
  whenToUse?: string
  body: string
}

export interface TestFixture {
  vela: Vela
  ctx: CommandContext
  contextManager: ContextManager
  dispatch: ReturnType<typeof createDispatcher>
  loader: SkillLoader
  activeSkills: Set<string>
  memoryStore: MemoryStore
  askCount: () => number
  rootDir: string
  cleanup: () => void
}

/**
 * 在临时目录里用 createVela() 装配和 CLI 完全相同的运行环境，
 * cwd 和数据目录都指向临时目录；模型默认用 createMockModel()（无网络）；ask() 只做计数。
 */
export function createTestFixture(
  opts: {
    skill?: FixtureSkill
    commands?: CommandHandler[]
    model?: LanguageModel
  } = {},
): TestFixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vela-test-'))

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
  const vela = createVela({
    model: opts.model ?? createMockModel(),
    cwd: rootDir,
  })
  const loader = vela.skillLoader

  let asks = 0
  const ctx: CommandContext = vela.commandContext(() => {
    asks++
  })
  const { activeSkills, contextManager, memoryStore } = vela

  const dispatch = createDispatcher([
    ...(opts.commands ?? []),
    ...createSkillCommands(loader, activeSkills),
  ])

  return {
    vela,
    ctx,
    contextManager,
    dispatch,
    loader,
    activeSkills,
    memoryStore,
    askCount: () => asks,
    rootDir,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  }
}
