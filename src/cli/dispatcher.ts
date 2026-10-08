import type { Vela } from '../vela.ts'
import { contextCommands, createDispatcher, debugCommands } from './commands/index.ts'
import { channelCommands } from './commands/channel.ts'
import { extensionCommands } from './commands/extensions.ts'
import { modelCommands } from './commands/model.ts'
import { securityCommands } from './commands/security.ts'
import { createSkillCommands } from './commands/skill.ts'
import { velaInternals } from '../vela.ts'

/**
 * The CLI's own slash commands. Tests use the same dispatcher so commands behave as in the real entry point.
 * Extension commands (/memory, /dream, /rag, ...) are not here: any `/xxx` these don't claim
 * goes to session.prompt(), which runs extension commands.
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
