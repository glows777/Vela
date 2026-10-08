import type { Vela } from '../vela.ts'
import { contextCommands, createDispatcher, debugCommands } from './commands/index.ts'
import { channelCommands } from './commands/channel.ts'
import { extensionCommands } from './commands/extensions.ts'
import { modelCommands } from './commands/model.ts'
import { securityCommands } from './commands/security.ts'
import { createSkillCommands } from './commands/skill.ts'
import { velaInternals } from '../vela.ts'

/**
 * CLI 自己的斜杠命令；测试用同一份分发器，保证命令行为和真实入口一致。
 * 扩展注册的命令（/memory、/dream、/rag…）不在这里：没被这些命令认领的 `/xxx`
 * 交给 session.prompt()，由它执行扩展命令。
 */
export function createCliDispatcher(vela: Vela) {
  return createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...modelCommands,
    ...createSkillCommands(velaInternals(vela).skillLoader),
    ...extensionCommands,
    ...channelCommands,
    ...securityCommands,
  ])
}
