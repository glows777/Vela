import type { VelaRuntime } from '../runtime-sdk-types.ts'
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
import { statusCommands } from './commands/status.ts'

/**
 * The CLI's own slash commands. Tests use the same dispatcher so commands behave as in the real entry point.
 * Extension/native commands (/memory, /dream, /tasks, /rag, ...) go to `runtime.sessions.runCommand`.
 */
export function createCliDispatcher(_runtime?: VelaRuntime): CommandHandler {
  const dispatch = createDispatcher([
    ...debugCommands,
    ...statusCommands,
    ...contextCommands,
    ...modelCommands,
    ...createSkillCommands(),
    ...extensionCommands,
    ...channelCommands,
    ...securityCommands,
  ])
  return (cmd, ctx) => (cmd.startsWith('/') ? dispatch(cmd, ctx) : false)
}
