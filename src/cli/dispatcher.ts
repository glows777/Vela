import type { Vela } from '../vela'
import {
  contextCommands,
  createDispatcher,
  debugCommands,
  memoryCommands,
} from './commands'
import { channelCommands } from './commands/channel'
import { dreamCommands } from './commands/dream'
import { extensionCommands } from './commands/extensions'
import { ragCommands } from './commands/rag'
import { securityCommands } from './commands/security'
import { createSkillCommands } from './commands/skill'
import { velaInternals } from '../vela'

/**
 * CLI 自己的斜杠命令；测试用同一份分发器，保证命令行为和真实入口一致。
 * 扩展注册的命令不在这里：没被这些命令认领的 `/xxx` 交给 session.prompt()，由它执行扩展命令。
 */
export function createCliDispatcher(vela: Vela) {
  return createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...memoryCommands,
    ...dreamCommands,
    ...ragCommands,
    ...createSkillCommands(velaInternals(vela).skillLoader),
    ...extensionCommands,
    ...channelCommands,
    ...securityCommands,
  ])
}
