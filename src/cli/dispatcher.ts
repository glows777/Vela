import type { Vela } from '../vela.ts'
import { velaInternals } from '../vela.ts'
import { channelCommands } from './commands/channel.ts'
import { extensionCommands } from './commands/extensions.ts'
import {
  type CommandHandler,
  contextCommands,
  createDispatcher,
  debugCommands,
} from './commands/index.ts'
import { modelCommands } from './commands/model.ts'
import { securityCommands } from './commands/security.ts'
import { createSkillCommands } from './commands/skill.ts'

/**
 * The CLI's own slash commands. Tests use the same dispatcher so commands behave as in the real entry point.
 * Extension commands (/memory, /dream, /rag, ...) are not here: any `/xxx` these don't claim
 * goes to session.prompt(), which runs extension commands. Text without a leading `/` is never
 * a command (like pi): it goes to the model.
 */
export function createCliDispatcher(vela: Vela): CommandHandler {
  const dispatch = createDispatcher([
    ...debugCommands,
    ...contextCommands,
    ...modelCommands,
    ...createSkillCommands(velaInternals(vela).skillLoader),
    ...extensionCommands,
    ...channelCommands,
    ...securityCommands,
  ])
  return (cmd, ctx) => (cmd.startsWith('/') ? dispatch(cmd, ctx) : false)
}
